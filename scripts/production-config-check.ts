import { readFile } from 'node:fs/promises';
import { productionConfig } from '../src/production/config.js';
import { productionSchedulingConfig } from '../src/production/runtime.js';
import { schedulingConfig,ScheduleConfigError } from '../src/scheduling/config.js';
import { LiveConfigError } from '../src/retrieval/live-config.js';

// Offline validation only. Never connects to Neon, Telegram, OpenAI or Cloudflare.
// Explicit local secrets are merged with the actual checked-in deployment vars.
try {
  // The checked-in wrangler.jsonc uses strict JSON (no comments/trailing commas).
  const file=JSON.parse(await readFile('wrangler.jsonc','utf8'));
  const env={...process.env,...file.vars,PRODUCTION_SCHEDULE_ENABLED:'YES'};
  schedulingConfig({...env,RUN_LIVE_SCHEDULED_PIPELINE:'YES'});
  productionSchedulingConfig(env,productionConfig(env));
  console.log('PRODUCTION_SCHEDULE_CONFIG_VALID: candidate YES; local validation only, deployed bindings unverified');
}catch(error) {
  // These validators emit field names / fixed strings only, never input values.
  if(error instanceof ScheduleConfigError||error instanceof LiveConfigError)console.error(error.message);
  else console.error('PRODUCTION_CONFIGURATION_INVALID');
  process.exitCode=1;
}
