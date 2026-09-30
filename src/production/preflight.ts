import { z } from 'zod';
import { LUNA_MODEL } from '../config/index.js';
import { productionConfig,type ProductionEnv } from './config.js';
import { braveConfig,BraveConfigError } from '../retrieval/brave-config.js';
import { schedulingConfig,ScheduleConfigError } from '../scheduling/config.js';
import { telegramConfig } from '../adapters/telegram/config.js';
import { productionSchedulingConfig } from './runtime.js';

export type ConfigResult={name:string;fields:string[]};
export function productionPreflight(env:ProductionEnv):ConfigResult[] {
  const results:ConfigResult[]=[];
  const fields=(name:string,schema:z.ZodType)=>{
    const result=schema.safeParse(env);results.push({name,fields:result.success?[]:[...new Set(result.error.issues.map(i=>String(i.path[0])))]});
  };
  const required=z.string().trim().min(1),money=z.string().regex(/^[1-9]\d{0,12}$/).refine(v=>BigInt(v)<=9_000_000_000_000n);
  fields('AI_BUDGETS',z.object({OPENAI_API_KEY:required,OPENAI_MODEL:z.literal(LUNA_MODEL),
    OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS:money,OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS:money,
    OPENAI_TELEGRAM_MONTHLY_BUDGET_NANODOLLARS:money,
    MAX_INPUT_TOKENS:z.coerce.number().int().min(1024).max(100000),MAX_OUTPUT_TOKENS:z.coerce.number().int().min(128).max(16000)}));
  try{braveConfig(env);results.push({name:'SEARCH_BUDGET',fields:[]});}
  catch(error){results.push({name:'SEARCH_BUDGET',fields:error instanceof BraveConfigError?error.fields:['BRAVE_CONFIGURATION']});}
  fields('PRODUCTION_BINDINGS',z.object({DATABASE_URL:required,COLLECTOR_DATABASE_URL:required,QUALITY_DATABASE_URL:required,
    TELEGRAM_BOT_TOKEN:required,TELEGRAM_ALLOWED_USER_IDS:required,TELEGRAM_USER_MAP:required,
    TELEGRAM_WEBHOOK_SECRET:required,PRODUCTION_HEALTH_SECRET:required,RSS_SOURCES_JSON:required}));
  try{
    schedulingConfig({...env,RUN_LIVE_SCHEDULED_PIPELINE:'YES'});
    const config=productionConfig(env);telegramConfig({...env,TELEGRAM_AI_ENABLED:'YES'},'dev');
    productionSchedulingConfig(env,config);
    results.push({name:'SCHEDULE_CONFIG',fields:[]});
  }catch(error){
    const names=error instanceof ScheduleConfigError?error.message.split(': ')[1]?.split(', '):undefined;
    results.push({name:'SCHEDULE_CONFIG',fields:names??['PRODUCTION_CONFIGURATION']});
  }
  return results;
}
