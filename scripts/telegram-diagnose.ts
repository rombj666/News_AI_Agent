import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase } from './local-db.js';
import { telegramConfig } from '../src/adapters/telegram/config.js';
import { withTelegramLock,safeTelegramError } from './telegram-common.js';
import { existingTelegramUser } from '../src/services/telegram-digest.js';
import { latestDigest } from '../src/services/news-assistant.js';
import { renderTelegramDigest } from '../src/adapters/telegram/render.js';
import { asUser } from '../src/db/database.js';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { safeFailure } from '../src/adapters/telegram/diagnostics.js';
import { readPreferences } from '../src/services/preferences.js';
import { preferencesSchema } from '../src/domain/preferences.js';

async function main() {
  const config=telegramConfig({...process.env,TELEGRAM_AI_ENABLED:'NO'},'dev');
  await withTelegramLock(config.botId,async()=>{
    const path=fileURLToPath(new URL('../.local/retrieval-live-db',import.meta.url));await access(path);
    const db=await localDatabase(path);
    try {
      const {userId}=await existingTelegramUser(db.owner,config.allowedIds,process.env.LIVE_TELEGRAM_USER_ID?.trim());
      const digest=await latestDigest(db.runtime,userId);
      console.log(JSON.stringify({userId,digestId:digest?.id??null,ownerMatches:digest?.userId===userId,generatedAt:digest?.generatedAt??null}));
      if(digest) {
        try {
          const messages=renderTelegramDigest(digest);
          console.log(JSON.stringify({render:'ok',parts:messages.map((m,part)=>({part,story:m.storyPosition??null,htmlLength:m.html.length,
            plainLength:m.plain.length,photo:!!m.imageUrl,keyboardRows:m.buttons?.length??0,
            callbackBytes:Math.max(0,...(m.buttons??[]).flat().filter(b=>'callback_data' in b).map(b=>Buffer.byteLength('callback_data' in b?b.callback_data:'')))}))}));
        }catch {console.log('TELEGRAM_RENDER_FAILED: SAVED_DIGEST_INVALID');}
      }
      const records=await asUser(db.runtime,userId,async tx=>({
        updates:(await tx.query(`SELECT u.update_id,u.status,u.error_code,u.created_at,u.callback_id IS NOT NULL AS callback,
          (SELECT CASE WHEN m.content='/news' THEN '/news' WHEN m.content='/start' THEN '/start' WHEN m.content='/preferences' THEN '/preferences' ELSE 'other' END
           FROM messages m WHERE m.user_id=u.user_id AND m.role='user' AND m.created_at=u.created_at LIMIT 1) AS command
          FROM telegram_updates u WHERE u.user_id=$1 ORDER BY u.created_at DESC LIMIT 20`,[userId])).rows,
        deliveries:(await tx.query(`SELECT update_id,scheduled_run_id,part,story_position,status,error_code,digest_id,telegram_message_id,created_at
          FROM telegram_deliveries WHERE user_id=$1 ORDER BY created_at DESC,part DESC LIMIT 30`,[userId])).rows,
        scheduled:(await tx.query(`SELECT id,status,started_at,digest_id,delivery_status,failure_stage,failure_code
          FROM scheduled_pipeline_runs WHERE user_id=$1 ORDER BY started_at DESC LIMIT 5`,[userId])).rows,
        usage:(await tx.query(`SELECT job_type,status,error_code,created_at FROM ai_usage WHERE user_id=$1 ORDER BY created_at DESC LIMIT 8`,[userId])).rows,
      }));
      console.log(JSON.stringify(records));
      const p=await readPreferences(db.runtime,userId);
      const job=await asUser(db.runtime,userId,async tx=>(await tx.query<{result:{action:string;value:unknown;priority:unknown;key:unknown};updated_at:Date}>(
        "SELECT result,updated_at FROM job_runs WHERE user_id=$1 AND job_type='preference_interpretation' AND status='succeeded' ORDER BY updated_at DESC LIMIT 1",[userId])).rows[0]);
      if(job?.result) {
        const r=job.result;
        const fields:Record<string,'deliveryTime'|'deliveryEnabled'|'timezone'|'digestLength'|'language'>={delivery_time:'deliveryTime',delivery_enabled:'deliveryEnabled',timezone:'timezone',digest_length:'digestLength',language:'language'};
        const field=fields[r.action];
        if(field) {
          const value=field==='deliveryEnabled'?r.value==='true'?true:r.value==='false'?false:r.value:r.value;
          console.log(JSON.stringify({lastPreferenceAction:r.action,proposedFieldValid:preferencesSchema.safeParse({...p.document,[field]:value}).success,
            sameAsCurrent:p.document[field]===value,modelCompletedAt:job.updated_at}));
        } else if(r.action==='topic_priority'||r.action==='region_priority') {
          const values=r.action==='topic_priority'?p.document.topics:p.document.regions;
          const key=typeof r.key==='string'?Object.keys(values).find(k=>k.toLowerCase()===String(r.key).toLowerCase())??r.key:'';
          const next={...p.document,[r.action==='topic_priority'?'topics':'regions']:{...values,[key]:r.priority}};
          console.log(JSON.stringify({lastPreferenceAction:r.action,proposedFieldValid:preferencesSchema.safeParse(next).success,sameAsCurrent:values[key]===r.priority,modelCompletedAt:job.updated_at}));
        }else console.log(JSON.stringify({lastPreferenceAction:['exclude_topic','clarify'].includes(r.action)?r.action:'UNRECOGNIZED'}));
      }
      if(process.argv.includes('--probe')) {
        const api=new TelegramApi(config.token);
        for(let sample=1;sample<=3;sample++) {
          try {console.log(JSON.stringify({probe:sample,...await api.inspectConnection()}));}
          catch(error){console.log(`TELEGRAM_CONNECTION_PROBE_FAILED: sample=${sample} ${safeFailure(error)}`);}
        }
      }
    }finally{await db.close();}
  });
}
main().catch(error=>{console.error(safeTelegramError(error));process.exitCode=1;});
