import { fileURLToPath } from 'node:url';
import { localDatabase } from './local-db.js';
import { createUser } from '../src/services/identity.js';
import { telegramConfig } from '../src/adapters/telegram/config.js';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { pollTelegram,setupTelegramCommands } from '../src/adapters/telegram/polling.js';
import { createTelegramRouter } from '../src/adapters/telegram/router.js';
import { OpenAIResponses } from '../src/ai/openai.js';
import { withTelegramLock, safeTelegramError } from './telegram-common.js';
import { configuredNewsNow } from '../src/production/news.js';
import { parseRssSources } from '../src/retrieval/sources.js';
import { NewsNowError } from '../src/services/news-now.js';

async function main() {
  const config=telegramConfig(process.env,'dev');
  await withTelegramLock(config.botId,async signal=>{
    const db=await localDatabase(fileURLToPath(new URL('../.local/retrieval-live-db',import.meta.url)));
    try {
      // Trusted local bootstrap only. Incoming handlers never receive owner access.
      const identities=new Map<string,string>();
      for(const id of config.allowedIds) identities.set(id,await createUser(db.owner,id));
      const transport=new TelegramApi(config.token,fetch,1100,console.log);
      await setupTelegramCommands(transport,signal,console.log);
      const ai=config.aiEnabled?{model:new OpenAIResponses(process.env),limits:config.limits!}:null;
      const handle=createTelegramRouter({db:db.runtime,botId:config.botId,identities,transport,ai,log:console.log,
        newsNow:async request=>{
          if(!ai)throw new NewsNowError('LIVE_NEWS_AI_DISABLED','retrieval');
          let handler;
          try{handler=configuredNewsNow(process.env,db,ai.model,parseRssSources(JSON.parse(process.env.RSS_SOURCES_JSON??'[]')).filter(s=>s.enabled));}
          catch{throw new NewsNowError('LIVE_NEWS_CONFIGURATION_INVALID','retrieval');}
          return handler(request);
        }});
      console.log(`TELEGRAM_POLLING_STARTED AI_${ai?'ENABLED':'DISABLED'}`);
      await pollTelegram(transport,async update=>{await handle(update,signal);},signal,console.log);
      console.log('TELEGRAM_POLLING_STOPPED');
    } finally {await db.close();}
  });
}
main().catch(error=>{console.error(safeTelegramError(error));process.exitCode=1;});
