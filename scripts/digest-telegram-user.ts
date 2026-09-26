import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase } from './local-db.js';
import { telegramConfig } from '../src/adapters/telegram/config.js';
import { withTelegramLock, safeTelegramError } from './telegram-common.js';
import { existingTelegramUser, generateTelegramDigest } from '../src/services/telegram-digest.js';
import { OpenAIResponses, ModelError } from '../src/ai/openai.js';
import { asUser } from '../src/db/database.js';

async function main() {
  const inspect=process.argv.includes('--inspect');
  const force=process.argv.includes('--force');
  if(process.argv.slice(2).some(a=>!['--inspect','--force'].includes(a))||inspect&&force) throw new ModelError('UNSUPPORTED_ARGUMENT');
  // Running this explicit command opts into AI; inspect never constructs a provider.
  const config=telegramConfig({...process.env,TELEGRAM_AI_ENABLED:inspect?'NO':'YES'},'dev');
  await withTelegramLock(config.botId,async()=>{
    const path=fileURLToPath(new URL('../.local/retrieval-live-db',import.meta.url));
    await access(path);
    const db=await localDatabase(path);
    try {
      // Trusted local identity lookup, as in telegram:dev bootstrap. All generation
      // and private content access below use the non-owner runtime role.
      const identity=await existingTelegramUser(db.owner,config.allowedIds,process.env.LIVE_TELEGRAM_USER_ID?.trim());
      const owned=await asUser(db.runtime,identity.userId,tx=>tx.query(
        'SELECT id,status,digest_type,generated_at FROM digests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',[identity.userId]));
      const totals=await db.owner.query('SELECT user_id,count(*)::integer AS digest_count FROM digests GROUP BY user_id');
      console.log(JSON.stringify({...identity,ownedDigests:owned.rows,digestOwnership:totals.rows}));
      if(inspect) {
        const articles=await db.runtime.query("SELECT count(*)::integer AS stored_articles,count(*) FILTER (WHERE date_kind='published' AND published_at >= now()-interval '24 hours' AND published_at <= now())::integer AS recent_dated_articles FROM articles");
        console.log(JSON.stringify(articles.rows[0]));
        return;
      }
      const result=await generateTelegramDigest(db.runtime,db.quality,new OpenAIResponses(process.env),identity.userId,{...config.limits!,budgetScope:'all'},new Date(),{force});
      console.log(JSON.stringify({userId:identity.userId,digestId:result.digest?.id??null,type:result.digest?.type,
        stories:result.digest?.outputStoryCount??0,replayed:result.replayed}));
      if(!result.digest) throw new ModelError('NO_ELIGIBLE_RANKED_STORIES');
      console.log('Saved to the Telegram local database. Restart telegram:dev and send /news.');
    } finally {await db.close();}
  });
}
main().catch(error=>{console.error(error instanceof ModelError&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:safeTelegramError(error));process.exitCode=1;});
