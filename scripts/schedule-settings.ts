import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase } from './local-db.js';
import { telegramConfig } from '../src/adapters/telegram/config.js';
import { withTelegramLock,safeTelegramError } from './telegram-common.js';
import { existingTelegramUser } from '../src/services/telegram-digest.js';
import { readPreferences,proposePreferences,decideProposal } from '../src/services/preferences.js';
import { DomainError } from '../src/domain/preferences.js';
import { ModelError } from '../src/ai/openai.js';

async function main() {
  const config=telegramConfig({...process.env,TELEGRAM_AI_ENABLED:'NO'},'dev');
  const args=process.argv.slice(2),action=args.shift()??'show';
  await withTelegramLock(config.botId,async()=>{
    const path=fileURLToPath(new URL('../.local/retrieval-live-db',import.meta.url));await access(path);
    const db=await localDatabase(path);
    try {
      const {userId}=await existingTelegramUser(db.owner,config.allowedIds,process.env.LIVE_TELEGRAM_USER_ID?.trim());
      if(action==='confirm'||action==='cancel') {
        if(args.length!==1) throw new Error('INVALID_ARGUMENTS');
        await decideProposal(db.runtime,userId,args[0]!,action);
      } else if(action==='propose') {
        const p=await readPreferences(db.runtime,userId),next=structuredClone(p.document);
        if(!args.length||args.length%2) throw new Error('INVALID_ARGUMENTS');
        for(let i=0;i<args.length;i+=2) {
          const value=args[i+1]!;
          switch(args[i]) {
            case '--time':next.deliveryTime=value;break;
            case '--timezone':next.timezone=value;break;
            case '--type':if(!['quick','normal','deep'].includes(value))throw new Error('INVALID_TYPE');next.digestLength=value as typeof next.digestLength;break;
            case '--enabled':if(!['true','false'].includes(value))throw new Error('INVALID_ENABLED');next.deliveryEnabled=value==='true';break;
            default:throw new Error('INVALID_ARGUMENTS');
          }
        }
        const proposal=await proposePreferences(db.runtime,userId,next,undefined,p.version);
        console.log(JSON.stringify({userId,proposalId:proposal.id,enabled:next.deliveryEnabled,time:next.deliveryTime,timezone:next.timezone,digestType:next.digestLength,expiresAt:proposal.expires_at}));
        console.log(`Review then run: npm run schedule:settings -- confirm ${proposal.id}`);
        console.log(`Or cancel: npm run schedule:settings -- cancel ${proposal.id}`);
        return;
      } else if(action!=='show'||args.length) throw new Error('INVALID_ARGUMENTS');
      const p=(await readPreferences(db.runtime,userId)).document;
      console.log(JSON.stringify({userId,enabled:p.deliveryEnabled,time:p.deliveryTime,timezone:p.timezone,digestType:p.digestLength}));
    } finally {await db.close();}
  });
}
main().catch(error=>{console.error(error instanceof DomainError||error instanceof ModelError?error.code:safeTelegramError(error));process.exitCode=1;});
