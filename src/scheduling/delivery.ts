import { asUser, type Database } from '../db/database.js';
import type { Digest } from '../digest/types.js';
import { renderTelegramDigest,renderText } from '../adapters/telegram/render.js';
import { TelegramError,type TelegramDelivery } from '../adapters/telegram/types.js';
import { createConversationInTransaction,saveMessageInTransaction } from '../services/history.js';
import { safeFailure,definiteRejection } from '../adapters/telegram/diagnostics.js';

export async function deliverScheduled(db:Database,transport:TelegramDelivery,request:{userId:string;botId:string;chatId:string;runId:string;digest:Digest|null},now:Date,signal?:AbortSignal,log:(code:string)=>void=()=>{}) {
  const {userId,botId,chatId,runId,digest}=request;
  if(digest&&digest.userId!==userId) throw new Error('DIGEST_OWNER_MISMATCH');
  let messages;
  try {messages=digest?renderTelegramDigest(digest):renderText('No fresh briefing was generated this morning.');}
  catch(error){log(`TELEGRAM_RENDER_FAILED: ${safeFailure(error)}`);throw error;}
  for(const [part,payload] of messages.entries()) {
    signal?.throwIfAborted();
    const id=await asUser(db,userId,async tx=>{
      const identity=await tx.query("SELECT id FROM users WHERE id=$1 AND telegram_user_id=$2 AND status='active'",[userId,chatId]);
      if(!identity.rows.length) throw new Error('DELIVERY_OWNER_MISMATCH');
      await tx.query('SELECT pg_advisory_xact_lock(74102923)');
      const existing=await tx.query('SELECT id FROM telegram_deliveries WHERE user_id=$1 AND scheduled_run_id=$2 AND part=$3',[userId,runId,part]);
      if(existing.rows.length) throw new Error('DELIVERY_ALREADY_ATTEMPTED');
      let session=(await tx.query<{conversation_id:string}>('SELECT conversation_id FROM telegram_sessions WHERE user_id=$1 AND bot_id=$2 AND chat_id=$3',[userId,botId,chatId])).rows[0];
      if(!session) {
        session={conversation_id:await createConversationInTransaction(tx,userId)};
        await tx.query('INSERT INTO telegram_sessions(user_id,bot_id,chat_id,conversation_id) VALUES($1,$2,$3,$4)',[userId,botId,chatId,session.conversation_id]);
      }
      const messageId=await saveMessageInTransaction(tx,userId,{conversationId:session.conversation_id,role:'assistant',content:payload.plain,createdAt:now});
      return (await tx.query<{id:string}>(`INSERT INTO telegram_deliveries(user_id,bot_id,scheduled_run_id,part,message_record_id,digest_id,story_position,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'sending') RETURNING id`,[userId,botId,runId,part,messageId,payload.digestId??null,payload.storyPosition??null])).rows[0]!.id;
    });
    try {
      const messageId=await transport.sendMessage(chatId,payload,signal);
      await asUser(db,userId,async tx=>{
        await tx.query("UPDATE telegram_deliveries SET status='sent',telegram_message_id=$3 WHERE user_id=$1 AND id=$2",[userId,id,messageId]);
        if(digest) await tx.query('UPDATE telegram_sessions SET current_digest_id=$4,current_story_position=NULL WHERE user_id=$1 AND bot_id=$2 AND chat_id=$3',[userId,botId,chatId,digest.id]);
      });
    } catch(error) {
      const certain=definiteRejection(error);
      await asUser(db,userId,tx=>tx.query('UPDATE telegram_deliveries SET status=$3,error_code=$4 WHERE user_id=$1 AND id=$2',[userId,id,certain?'failed':'uncertain',safeFailure(error)]));
      log(`TELEGRAM_SCHEDULED_DELIVERY_FAILED: ${safeFailure(error)} part=${part} photo=${!!payload.imageUrl}`);
      throw new TelegramError(certain?'TELEGRAM_DELIVERY_FAILED':'TELEGRAM_DELIVERY_UNCERTAIN',null,error instanceof TelegramError?error.reason:null);
    }
  }
}
