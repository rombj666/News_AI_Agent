import { z } from 'zod';
import { LUNA_MODEL } from '../config/index.js';
import { modelLimitsSchema } from '../ai/metered.js';
export class ScheduleConfigError extends Error {}
export function schedulingConfig(env:Record<string,string|undefined>) {
  const money=z.string().regex(/^[1-9]\d{0,12}$/);
  const parsed=z.object({RUN_LIVE_SCHEDULED_PIPELINE:z.literal('YES'),OPENAI_API_KEY:z.string().trim().min(1),
    OPENAI_MODEL:z.literal(LUNA_MODEL).default(LUNA_MODEL),OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS:money,
    OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS:money,SCHEDULE_NOTIFY_EMPTY:z.enum(['YES','NO']).default('NO'),
    SCHEDULE_BRAVE_QUERY:z.string().trim().max(400).default(''),
    SCHEDULER_INTERVAL_SECONDS:z.coerce.number().int().min(10).max(300).default(30),
    MAX_INPUT_TOKENS:z.coerce.number().int().min(1024).max(100000).default(12000),
    MAX_OUTPUT_TOKENS:z.coerce.number().int().min(128).max(16000).default(2000),
  }).safeParse(env);
  if(!parsed.success) throw new ScheduleConfigError(`Required/invalid scheduling fields: ${[...new Set(parsed.error.issues.map(i=>i.path[0]))].join(', ')}`);
  const p=parsed.data;
  const limits=(budget:string)=>modelLimitsSchema.parse({monthlyBudgetNanodollars:BigInt(budget),maxInputTokens:p.MAX_INPUT_TOKENS,
    maxOutputTokens:p.MAX_OUTPUT_TOKENS,budgetScope:'job_type'});
  return {rankingLimits:limits(p.OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS),digestLimits:limits(p.OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS),
    notifyEmpty:p.SCHEDULE_NOTIFY_EMPTY==='YES',braveQuery:p.SCHEDULE_BRAVE_QUERY,intervalMs:p.SCHEDULER_INTERVAL_SECONDS*1000};
}
