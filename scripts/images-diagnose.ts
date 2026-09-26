import { access,readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase } from './local-db.js';
import { telegramConfig } from '../src/adapters/telegram/config.js';
import { withTelegramLock,safeTelegramError } from './telegram-common.js';
import { existingTelegramUser } from '../src/services/telegram-digest.js';
import { latestDigest } from '../src/services/news-assistant.js';
import { inspectQuality } from '../src/quality/service.js';
import { RssRetriever } from '../src/retrieval/rss.js';
import { parseRssSources } from '../src/retrieval/sources.js';
import { safeImageUrl } from '../src/retrieval/images.js';
import { collectNews } from '../src/retrieval/collect.js';
import { TelegramError } from '../src/adapters/telegram/types.js';

async function main() {
  if(process.argv.slice(2).some(a=>a!=='--refresh-rss'))throw new TelegramError('TELEGRAM_INVALID_ARGUMENT');
  const config=telegramConfig({...process.env,TELEGRAM_AI_ENABLED:'NO'},'dev');
  const sources=parseRssSources(JSON.parse(await readFile(new URL('../config/rss-sources.json',import.meta.url),'utf8')));
  const source=sources.find(s=>s.id==='bbc-technology'&&s.enabled);
  if(!source)throw new TelegramError('TELEGRAM_RSS_SOURCE_DISABLED');
  await withTelegramLock(config.botId,async signal=>{
    const path=fileURLToPath(new URL('../.local/retrieval-live-db',import.meta.url));await access(path);
    const db=await localDatabase(path);
    try {
      const {userId}=await existingTelegramUser(db.owner,config.allowedIds,process.env.LIVE_TELEGRAM_USER_ID?.trim());
      const now=new Date(),since=new Date(+now-7*86400000);
      // Explicit inspection fetch bypasses validators so historical NULL images can be enriched.
      const batch=await new RssRetriever(source).collect({query:'',since,limit:100,signal});
      if(process.argv.includes('--refresh-rss')) {
        const run=await collectNews(db.collector,{provider:'rss',source,collect:async()=>batch},
          {runId:crypto.randomUUID(),source,since,category:source.category,limit:100});
        if(run.status!=='succeeded')throw new TelegramError('TELEGRAM_RSS_REFRESH_FAILED');
      }
      const rows=(await db.runtime.query<{id:string;image_url:string|null}>('SELECT id,image_url FROM articles')).rows;
      const images=new Set(rows.filter(r=>safeImageUrl(r.image_url)).map(r=>r.id));
      const quality=await inspectQuality(db.quality,now);
      const digest=await latestDigest(db.runtime,userId);
      const items=digest?.sections.flatMap(s=>s.items)??[];
      console.log(JSON.stringify({rssItems:batch.items.length,rssItemsWithImages:batch.items.filter(i=>safeImageUrl(i.imageUrl)).length,
        storedArticles:rows.length,storedArticlesWithImages:images.size,
        freshCandidates:quality.candidates.length,
        freshCandidatesWithImages:quality.candidates.filter(c=>c.sources.some(s=>s.freshness==='fresh'&&images.has(s.articleId))).length,
        freshRepresentativesWithImages:quality.candidates.filter(c=>images.has(c.representative.id)).length,
        digestItems:items.length,digestItemsWithImages:items.filter(i=>i.sources.some(s=>safeImageUrl(s.imageUrl))).length}));
    }finally{await db.close();}
  });
}
main().catch(error=>{console.error(safeTelegramError(error));process.exitCode=1;});
