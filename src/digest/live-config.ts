import { z } from 'zod';
import { LUNA_MODEL } from '../config/index.js';

export class DigestLiveConfigError extends Error {}
export function digestLiveConfig(env: Record<string,string|undefined>) {
  const result = z.object({
    RUN_LIVE_DIGEST:z.literal('YES'),OPENAI_API_KEY:z.string().trim().min(1),
    OPENAI_MODEL:z.literal(LUNA_MODEL).default(LUNA_MODEL),LIVE_OPENAI_USER_ID:z.uuid(),
    OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS:z.string().regex(/^[1-9]\d{0,12}$/),
    LIVE_DIGEST_FORCE:z.enum(['YES','NO']).default('NO'),
  }).safeParse(env);
  if (!result.success) throw new DigestLiveConfigError(`Digest live test disabled. Required/invalid fields: ${[...new Set(result.error.issues.map(i => i.path.join('.')))].join(', ')}`);
  return {userId:result.data.LIVE_OPENAI_USER_ID,force:result.data.LIVE_DIGEST_FORCE === 'YES',
    limits:{maxInputTokens:12000,maxOutputTokens:2500,timeoutMs:30000,
      monthlyBudgetNanodollars:BigInt(result.data.OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS)}};
}
