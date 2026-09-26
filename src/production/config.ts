import { z } from 'zod';
import { telegramConfig } from '../adapters/telegram/config.js';
import { uuidSchema,telegramIdSchema } from '../domain/preferences.js';
import { validateNeonUrl } from '../db/neon.js';
import { parseRssSources } from '../retrieval/sources.js';
export type ProductionEnv=Record<string,string|undefined>;
export function productionConfig(env:ProductionEnv) {
  try {
    const telegram=telegramConfig(env,'dev');
    const webhookSecret=z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).parse(env.TELEGRAM_WEBHOOK_SECRET);
    const healthSecret=z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).parse(env.PRODUCTION_HEALTH_SECRET);
    const mapping=z.record(telegramIdSchema,uuidSchema).parse(JSON.parse(env.TELEGRAM_USER_MAP??''));
    if(telegram.allowedIds.length>10||Object.keys(mapping).length!==telegram.allowedIds.length
      ||telegram.allowedIds.some(id=>!mapping[id])||new Set(Object.values(mapping)).size!==Object.keys(mapping).length)throw Error();
    const identities=new Map(telegram.allowedIds.map(id=>[id,mapping[id]!]));
    const sources=parseRssSources(JSON.parse(env.RSS_SOURCES_JSON??'[]')).filter(s=>s.enabled);
    if(!sources.length||sources.length>5)throw Error();
    const schedule=z.enum(['YES','NO']).default('NO').parse(env.PRODUCTION_SCHEDULE_ENABLED)==='YES';
    return {telegram,identities,webhookSecret,healthSecret,sources,schedule,
      runtimeUrl:validateNeonUrl(env.DATABASE_URL),collectorUrl:validateNeonUrl(env.COLLECTOR_DATABASE_URL),qualityUrl:validateNeonUrl(env.QUALITY_DATABASE_URL)};
  }catch{throw Error('PRODUCTION_CONFIGURATION_INVALID');}
}
