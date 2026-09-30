import { asUser,type Database } from '../db/database.js';
import { telegramUpdateSchema,type TelegramUpdate } from '../adapters/telegram/types.js';
import { classifyMessage } from '../services/news-intent.js';

export function isNewsUpdate(raw:unknown) {
  const parsed=telegramUpdateSchema.safeParse(raw);if(!parsed.success)return false;
  const update=parsed.data;
  if(update.callback_query)return update.callback_query.data==='nav:news';
  const intent=classifyMessage(update.message?.text??'');
  return intent==='NEWS_NOW'||intent==='CURRENT_NEWS_QUESTION';
}

export async function enqueueUpdate(db:Database,userId:string,botId:string,update:TelegramUpdate) {
  return asUser(db,userId,async tx=>{
    const active=await tx.query("SELECT id FROM users WHERE id=$1 AND telegram_user_id=$2 AND status='active'",[userId,String(update.callback_query?.from.id??update.message?.from?.id)]);
    if(!active.rows.length)throw Error('PRODUCTION_IDENTITY_NOT_READY');
    const inserted=await tx.query(`INSERT INTO telegram_webhook_inbox(user_id,bot_id,update_id,payload) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT DO NOTHING RETURNING update_id`,[userId,botId,update.update_id,JSON.stringify(update)]);
    return inserted.rows.length===1;
  });
}

export async function drainInbox(db:Database,userId:string,botId:string,handle:(raw:unknown)=>Promise<unknown>,limit=5,deadline=Date.now()+240000,
  canProcess:(raw:unknown)=>boolean=()=>true) {
  let processed=0;
  for(let i=0;i<limit&&Date.now()<deadline;i++) {
    const row=await asUser(db,userId,async tx=>{
      // Serialize per-user claims. A previous invocation may still be sending.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,74102926))',[userId+':'+botId]);
      // A stale claim is deliberately not reset or redelivered.
      await tx.query(`UPDATE telegram_webhook_inbox SET status='failed',payload=NULL,completed_at=now()
        WHERE user_id=$1 AND bot_id=$2 AND status='processing' AND started_at<now()-interval '20 minutes'`,[userId,botId]);
      if((await tx.query("SELECT 1 FROM telegram_webhook_inbox WHERE user_id=$1 AND bot_id=$2 AND status='processing'",[userId,botId])).rows.length)return;
      const pending=(await tx.query<{update_id:string;payload:unknown}>(`SELECT update_id,payload FROM telegram_webhook_inbox
        WHERE user_id=$1 AND bot_id=$2 AND status='pending' ORDER BY update_id LIMIT 1 FOR UPDATE SKIP LOCKED`,[userId,botId])).rows[0];
      if(!pending||!canProcess(pending.payload))return;
      return (await tx.query<{update_id:string;payload:unknown}>(`UPDATE telegram_webhook_inbox SET status='processing',started_at=now()
        WHERE user_id=$1 AND bot_id=$2 AND update_id=$3 AND status='pending' RETURNING update_id,payload`,[userId,botId,pending.update_id])).rows[0];
    });
    if(!row)break;
    let status='completed';
    try{if(await handle(row.payload)==='failed')status='failed';}catch{status='failed';}
    await asUser(db,userId,tx=>tx.query(`UPDATE telegram_webhook_inbox SET status=$4,payload=NULL,completed_at=now()
      WHERE user_id=$1 AND bot_id=$2 AND update_id=$3`,[userId,botId,row.update_id,status]));
    processed++;
  }return processed;
}
