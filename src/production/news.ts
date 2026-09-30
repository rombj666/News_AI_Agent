import { braveConfig } from '../retrieval/brave-config.js';
import { BraveRetriever } from '../retrieval/brave.js';
import { RssRetriever } from '../retrieval/rss.js';
import { schedulingConfig,ScheduleConfigError } from '../scheduling/config.js';
import { BraveConfigError } from '../retrieval/brave-config.js';
import { NewsNowError } from '../services/news-now.js';
import { createNewsNow } from '../services/news-now.js';
import type { Database } from '../db/database.js';
import type { LanguageModel } from '../domain/ports.js';
import type { RssSource } from '../retrieval/sources.js';
import type { Fetcher } from '../retrieval/http.js';

export function newsNowConfig(env:Record<string,string|undefined>) {
  return {...schedulingConfig({...env,RUN_LIVE_SCHEDULED_PIPELINE:'YES'}),brave:braveConfig(env)};
}
export function validatedNewsNowConfig(env:Record<string,string|undefined>,log:(line:string)=>void) {
  try{return newsNowConfig(env);}catch(error) {
    if(error instanceof BraveConfigError||error instanceof ScheduleConfigError) {
      log(`LIVE_NEWS_CONFIG_FIELDS: ${error.fields.filter(field=>/^[A-Z][A-Z0-9_]*$/.test(field)).join(',')}`);
    }
    throw new NewsNowError('LIVE_NEWS_CONFIGURATION_INVALID','retrieval');
  }
}
export function configuredNewsNow(env:Record<string,string|undefined>,db:{runtime:Database;collector:Database;quality:Database},
  model:LanguageModel,sources:RssSource[],fetcher:Fetcher=(url,init)=>globalThis.fetch(url,init)) {
  const config=newsNowConfig(env);
  return createNewsNow({db:db.runtime,collector:db.collector,quality:db.quality,model,
    brave:new BraveRetriever(config.brave.key,fetcher),braveLimits:config.brave.limits,
    rss:sources.map(source=>({retriever:new RssRetriever(source,fetcher),request:{source,category:source.category,limit:30}})),
    rankingLimits:config.rankingLimits,digestLimits:config.digestLimits});
}
