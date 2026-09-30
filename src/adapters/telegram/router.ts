import { asUser, type Database } from '../../db/database.js';
import { authorizeTelegramUser } from '../../services/identity.js';
import { createConversationInTransaction, saveMessageInTransaction } from '../../services/history.js';
import { respondToNews, type AssistantAction, type AssistantReply } from '../../services/news-assistant.js';
import { DomainError } from '../../domain/preferences.js';
import { ModelError } from '../../ai/openai.js';
import { renderTelegramDigest, renderText } from './render.js';
import { telegramUpdateSchema, type TelegramDelivery, type TelegramMessage } from './types.js';
import { safeFailure,definiteRejection } from './diagnostics.js';
import { NewsNowError,type NewsNowHandler } from '../../services/news-now.js';

export function parseCallback(data:string):AssistantAction|null {
  if(data==='nav:news'||data==='nav:schedule'||data==='nav:preferences')return {kind:'navigate',command:`/${data.slice(4)}` as '/news'|'/schedule'|'/preferences'};
  if(new TextEncoder().encode(data).length>64) return null;
  const match=/^([emlcx]):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?::([1-9]|[12]\d|30))?$/.exec(data);
  if(!match) return null;
  const [,code,id,position]=match;
  if(code==='c'||code==='x') return position?null:{kind:code==='c'?'confirm':'cancel',proposalId:id!};
  if(!position) return null;
  return {kind:code==='e'?'explain':code==='m'?'more':'less',digestId:id!,position:Number(position)};
}
function renderReply(reply:AssistantReply):TelegramMessage[] {
  if(reply.kind==='digest') return renderTelegramDigest(reply.digest);
  const messages=renderText(reply.text);
  if(reply.kind==='text'&&reply.menu)messages[messages.length-1]!.buttons=[[
    {text:'📰 News now',callback_data:'nav:news'},{text:'⏰ Schedule',callback_data:'nav:schedule'},
    {text:'⚙️ Preferences',callback_data:'nav:preferences'}]];
  if(reply.kind==='proposal') messages[messages.length-1]!.buttons=[[
    {text:'Confirm',callback_data:`c:${reply.proposalId}`},{text:'Cancel',callback_data:`x:${reply.proposalId}`}]];
  return messages;
}
function userError(error:unknown):string {
  if(error instanceof NewsNowError)return error.stage==='retrieval'?'Live news search is temporarily unavailable.':"I found news, but couldn't prepare the briefing right now.";
  if(error instanceof DomainError) {
    if(error.code==='NO_CHANGE') return 'That preference is already set.';
    if(['EXPIRED','STALE','NOT_PENDING'].includes(error.code)) return 'That preference request expired, changed, or was already handled. Please propose it again.';
    return 'That story or request is not available to your account.';
  }
  if(error instanceof ModelError && /BUDGET|TOKEN_LIMIT/.test(error.code)) return 'The AI request is temporarily unavailable.';
  return "I couldn't process that request right now.";
}
export function createTelegramRouter(deps:{db:Database;botId:string;identities:ReadonlyMap<string,string>;
  transport:TelegramDelivery;ai:Parameters<typeof respondToNews>[2];newsNow?:NewsNowHandler;now?:()=>Date;log?:(code:string)=>void}) {
  const {db,botId,identities,transport}=deps;
  const log=deps.log??(()=>{});
  return async (raw:unknown,signal?:AbortSignal):Promise<'ignored'|'unauthorized'|'duplicate'|'completed'|'failed'>=>{
    const parsed=telegramUpdateSchema.safeParse(raw);
    if(!parsed.success) {log('TELEGRAM_UPDATE_INVALID');return 'ignored';}
    const update=parsed.data,callback=update.callback_query;
    const message=callback?.message??update.message, sender=callback?.from??message?.from;
    if(!message||!sender||sender.is_bot||message.chat.type!=='private'||message.chat.id!==sender.id) return 'ignored';
    const chatId=String(message.chat.id),senderId=String(sender.id);
    const acknowledge=async(text:string)=>{if(callback) try{await transport.answerCallback(callback.id,text,signal);}catch{log('TELEGRAM_CALLBACK_ACK_FAILED');}};
    let userId:string;
    try {authorizeTelegramUser(senderId,[...identities.keys()]);userId=identities.get(senderId)!;}
    catch {
      await acknowledge('You are not authorized to use this bot.');
      if(!callback) try{await transport.sendMessage(chatId,renderText('You are not authorized to use this bot.')[0]!,signal);}catch{log('TELEGRAM_UNAUTHORIZED_REPLY_FAILED');}
      return 'unauthorized';
    }
    const now=(deps.now??(()=>new Date()))();
    const action=callback?parseCallback(callback.data??''):null;
    const inbound=callback?(action?`[${action.kind}${'position' in action?` story ${action.position}`:''}]`:'[Unsupported button]'):(message.text??'[Unsupported message]');
    // Claim and inbound history are one transaction. Never rerun a claimed update,
    // including one interrupted after billing or after an uncertain Telegram send.
    const claim=await asUser(db,userId,async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(74102923)');
      const active=await tx.query(`SELECT id FROM users WHERE id=$1 AND telegram_user_id=$2 AND status='active'`,[userId,senderId]);
      if(!active.rows.length) return {blocked:true} as const;
      let session=(await tx.query<{conversation_id:string;current_digest_id:string|null;current_story_position:number|null}>(`SELECT conversation_id,current_digest_id,current_story_position FROM telegram_sessions
        WHERE user_id=$1 AND bot_id=$2 AND chat_id=$3`,[userId,botId,chatId])).rows[0];
      if(!session) {
        const conversationId=await createConversationInTransaction(tx,userId);
        await tx.query(`INSERT INTO telegram_sessions(user_id,bot_id,chat_id,conversation_id) VALUES($1,$2,$3,$4)`,[userId,botId,chatId,conversationId]);
        session={conversation_id:conversationId,current_digest_id:null,current_story_position:null};
      }
      const inserted=await tx.query<{operation_id:string}>(`INSERT INTO telegram_updates(bot_id,update_id,user_id,chat_id,callback_id,telegram_message_id,reply_to_message_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING operation_id`,
      [botId,update.update_id,userId,chatId,callback?.id??null,message.message_id,message.reply_to_message?.message_id??null,now.toISOString()]);
      if(!inserted.rows[0]) return null;
      await saveMessageInTransaction(tx,userId,{conversationId:session.conversation_id,role:'user',content:inbound,createdAt:now});
      if(message.reply_to_message) {
        const reply=(await tx.query<{digest_id:string|null}>(`SELECT digest_id FROM telegram_deliveries WHERE user_id=$1 AND bot_id=$2 AND telegram_message_id=$3 AND status='sent'`,
          [userId,botId,message.reply_to_message.message_id])).rows[0];
        if(reply?.digest_id&&reply.digest_id!==session.current_digest_id) {session.current_digest_id=reply.digest_id;session.current_story_position=null;}
      }
      return {...session,operationId:inserted.rows[0].operation_id,blocked:false} as const;
    });
    if(claim?.blocked) {
      await acknowledge('You are not authorized to use this bot.');
      if(!callback) try{await transport.sendMessage(chatId,renderText('You are not authorized to use this bot.')[0]!,signal);}catch{log('TELEGRAM_UNAUTHORIZED_REPLY_FAILED');}
      return 'unauthorized';
    }
    if(!claim) {log(`TELEGRAM_UPDATE_DUPLICATE: update_id=${update.update_id}`);await acknowledge('Already handled.');return 'duplicate';}
    await acknowledge('Received.');
    let reply:AssistantReply;let failed=false;let errorCode:string|null=null;
    try {
      if(callback&&!action) reply={kind:'text',text:'This button is not supported. Use /news or /preferences.'};
      else if(!callback&&(!message.text||message.text.length>1500)) reply={kind:'text',text:'Please send a text request of at most 1,500 characters.'};
      else reply=await respondToNews(db,{userId,operationId:claim.operationId,
        ...(action?{action}:{text:message.text!}),...(claim.current_digest_id?{currentDigestId:claim.current_digest_id}:{}),
        ...(claim.current_story_position?{currentStoryPosition:claim.current_story_position}:{})},deps.ai,now,deps.newsNow);
    } catch(error) {
      if(error instanceof DomainError&&error.code==='NO_CHANGE')log('TELEGRAM_PREFERENCE_ALREADY_SET');
      else {failed=true;errorCode=safeFailure(error);log(`TELEGRAM_APPLICATION_REQUEST_FAILED: ${errorCode}`);}
      reply={kind:'text',text:userError(error)};
    }
    let outbound:TelegramMessage[];
    try {outbound=renderReply(reply);}catch(error){
      failed=true;errorCode=safeFailure(error);log(`TELEGRAM_RENDER_FAILED: ${errorCode}`);
      outbound=renderText('Your saved briefing could not be displayed. Please try /news again after the issue is checked.');
    }
    for(const [part,payload] of outbound.entries()) {
      const deliveryId=await asUser(db,userId,async tx=>{
        const recordId=await saveMessageInTransaction(tx,userId,{conversationId:claim.conversation_id,role:'assistant',content:payload.plain,createdAt:now});
        const result=await tx.query<{id:string}>(`INSERT INTO telegram_deliveries(user_id,bot_id,update_id,part,message_record_id,digest_id,story_position,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,'sending') RETURNING id`,[userId,botId,update.update_id,part,recordId,payload.digestId??null,payload.storyPosition??null]);
        return result.rows[0]!.id;
      });
      try {
        const telegramId=await transport.sendMessage(chatId,payload,signal);
        await asUser(db,userId,async tx=>{
          await tx.query("UPDATE telegram_deliveries SET status='sent',telegram_message_id=$3 WHERE user_id=$1 AND id=$2",[userId,deliveryId,telegramId]);
          // A partially delivered briefing must still be the context for visible
          // story numbers; callback buttons always carry an exact digest reference.
          if(payload.digestId) await tx.query('UPDATE telegram_sessions SET current_digest_id=$4 WHERE user_id=$1 AND bot_id=$2 AND chat_id=$3',
            [userId,botId,chatId,payload.digestId]);
        });
      } catch(error) {
        failed=true;
        const certain=definiteRejection(error);errorCode=safeFailure(error);
        await asUser(db,userId,tx=>tx.query('UPDATE telegram_deliveries SET status=$3,error_code=$4 WHERE user_id=$1 AND id=$2',[userId,deliveryId,certain?'failed':'uncertain',errorCode]));
        log(`TELEGRAM_DELIVERY_FAILED_OR_UNCERTAIN: ${errorCode} update_id=${update.update_id} part=${part} photo=${!!payload.imageUrl}`);break;
      }
    }
    await asUser(db,userId,async tx=>{
      if(!failed&&action?.kind==='explain')await tx.query('UPDATE telegram_sessions SET current_digest_id=$4,current_story_position=$5 WHERE user_id=$1 AND bot_id=$2 AND chat_id=$3',[userId,botId,chatId,action.digestId,action.position]);
      const position=Number(/\bstory\s*(\d+)\b/i.exec(message.text??'')?.[1]);
      if(!failed&&!action&&Number.isInteger(position)&&position>=1&&position<=30)await tx.query('UPDATE telegram_sessions SET current_story_position=$4 WHERE user_id=$1 AND bot_id=$2 AND chat_id=$3',[userId,botId,chatId,position]);
      await tx.query('UPDATE telegram_updates SET status=$3,error_code=$5 WHERE user_id=$1 AND bot_id=$2 AND update_id=$4',[userId,botId,failed?'failed':'completed',update.update_id,errorCode]);
      if(!failed&&reply.kind==='digest') await tx.query('UPDATE telegram_sessions SET current_digest_id=$4,current_story_position=NULL WHERE user_id=$1 AND bot_id=$2 AND chat_id=$3',[userId,botId,chatId,reply.digest.id]);
    });
    return failed?'failed':'completed';
  };
}
