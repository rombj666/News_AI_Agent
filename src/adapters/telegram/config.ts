import { z } from 'zod';
import { telegramIdSchema } from '../../domain/preferences.js';
import { LUNA_MODEL } from '../../config/index.js';
import { modelLimitsSchema } from '../../ai/metered.js';

export class TelegramConfigError extends Error {}
export function telegramConfig(env:Record<string,string|undefined>,mode:'whoami'|'dev'|'test') {
  const token = z.string().regex(/^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,200}$/).safeParse(env.TELEGRAM_BOT_TOKEN?.trim());
  if (!token.success) throw new TelegramConfigError('Required/invalid field: TELEGRAM_BOT_TOKEN');
  const ids = [...new Set((env.TELEGRAM_ALLOWED_USER_IDS??'').split(',').map(s=>s.trim()).filter(Boolean))];
  if (mode !== 'whoami' && (!ids.length || ids.some(id=>!telegramIdSchema.safeParse(id).success))) throw new TelegramConfigError('Required/invalid field: TELEGRAM_ALLOWED_USER_IDS');
  if (mode === 'test' && env.RUN_LIVE_TELEGRAM !== 'YES') throw new TelegramConfigError('Required field: RUN_LIVE_TELEGRAM=YES');
  const aiEnabled = mode === 'dev' && env.TELEGRAM_AI_ENABLED === 'YES';
  let limits:ReturnType<typeof modelLimitsSchema.parse>|null = null;
  if (aiEnabled) {
    if (!env.OPENAI_API_KEY?.trim()) throw new TelegramConfigError('Required field: OPENAI_API_KEY');
    if (env.OPENAI_MODEL && env.OPENAI_MODEL!==LUNA_MODEL) throw new TelegramConfigError('Invalid field: OPENAI_MODEL');
    if (!/^[1-9]\d{0,12}$/.test(env.OPENAI_TELEGRAM_MONTHLY_BUDGET_NANODOLLARS??'')) throw new TelegramConfigError('Required/invalid field: OPENAI_TELEGRAM_MONTHLY_BUDGET_NANODOLLARS');
    const parsed = modelLimitsSchema.safeParse({maxInputTokens:Number(env.MAX_INPUT_TOKENS??12000),maxOutputTokens:Number(env.MAX_OUTPUT_TOKENS??2000),
      monthlyBudgetNanodollars:BigInt(env.OPENAI_TELEGRAM_MONTHLY_BUDGET_NANODOLLARS!),budgetScope:'conversation'});
    if (!parsed.success) throw new TelegramConfigError('Invalid Telegram AI limits');
    limits=parsed.data;
  }
  const targetId = env.LIVE_TELEGRAM_USER_ID?.trim() || (ids.length===1 ? ids[0] : undefined);
  if (mode==='test' && (!targetId || !ids.includes(targetId))) throw new TelegramConfigError('Choose an allowed LIVE_TELEGRAM_USER_ID');
  return {token:token.data,botId:token.data.split(':')[0]!,allowedIds:ids,aiEnabled,limits,targetId};
}
