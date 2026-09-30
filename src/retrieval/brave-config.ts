import { z } from 'zod';
import type { CollectionLimits } from './collect.js';
export class BraveConfigError extends Error {
  constructor(public readonly fields:string[]){super('BRAVE_CONFIGURATION_INVALID');}
}
export function braveConfig(env:Record<string,string|undefined>) {
  const money=z.string().regex(/^[1-9]\d{0,12}$/);
  const parsed=z.object({BRAVE_API_KEY:z.string().trim().min(1),BRAVE_COST_PER_REQUEST_NANODOLLARS:money,
    BRAVE_PRICING_VERSION:z.string().trim().min(1).max(120),RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS:money}).safeParse(env);
  if(!parsed.success)throw new BraveConfigError([...new Set(parsed.error.issues.map(i=>String(i.path[0])))]);
  const p=parsed.data;
  const limits:CollectionLimits={braveCostPerRequest:BigInt(p.BRAVE_COST_PER_REQUEST_NANODOLLARS),
    monthlyBudget:BigInt(p.RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS),pricingVersion:p.BRAVE_PRICING_VERSION,dailyRequests:10};
  if(limits.braveCostPerRequest>limits.monthlyBudget)throw new BraveConfigError(['RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS']);
  return {key:p.BRAVE_API_KEY,limits};
}
