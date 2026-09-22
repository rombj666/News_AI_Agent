import { z } from 'zod';
import { LUNA_MODEL } from '../config/index.js';
export class OpenAILiveConfigError extends Error {}
export function openaiLiveConfig(env:Record<string,string|undefined>) {
  const result=z.object({RUN_LIVE_OPENAI:z.literal('YES'),OPENAI_API_KEY:z.string().trim().min(1),
    OPENAI_MODEL:z.literal(LUNA_MODEL).default(LUNA_MODEL),LIVE_OPENAI_USER_ID:z.uuid(),
    OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS:z.string().regex(/^[1-9]\d{0,12}$/),
    MAX_INPUT_TOKENS:z.coerce.number().int().min(1024).max(100000).default(12000),
    MAX_OUTPUT_TOKENS:z.coerce.number().int().min(128).max(16000).default(2000),
  }).safeParse(env);
  if(!result.success) throw new OpenAILiveConfigError(`OpenAI live test disabled. Required/invalid fields: ${[...new Set(result.error.issues.map(i=>i.path.join('.')))].join(', ')}`);
  return {userId:result.data.LIVE_OPENAI_USER_ID,limits:{maxInputTokens:result.data.MAX_INPUT_TOKENS,
    maxOutputTokens:result.data.MAX_OUTPUT_TOKENS,monthlyBudgetNanodollars:BigInt(result.data.OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS)}};
}
