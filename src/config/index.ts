import { z } from 'zod';
import { telegramIdSchema } from '../domain/preferences.js';

export const LUNA_MODEL = 'gpt-5.6-luna' as const;
const integer = (fallback: number, max: number) => z.coerce.number().int().positive().max(max).default(fallback);
const schema = z.object({
  APP_MODE: z.enum(['offline', 'live']).default('offline'),
  OPENAI_MODEL: z.literal(LUNA_MODEL).default(LUNA_MODEL),
  OPENAI_API_KEY: z.string().optional(),
  BRAVE_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(''),
  MAX_INPUT_TOKENS: integer(12_000, 100_000),
  MAX_OUTPUT_TOKENS: integer(2_000, 16_000),
  DAILY_SEARCH_LIMIT: z.coerce.number().int().min(0).max(1000).default(10),
  MONTHLY_BUDGET_USD: z.string().regex(/^\d{1,5}(\.\d{1,2})?$/).default('10.00'),
}).superRefine((value, ctx) => {
  const ids = value.TELEGRAM_ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.some((id) => !telegramIdSchema.safeParse(id).success)) {
    ctx.addIssue({ code: 'custom', path: ['TELEGRAM_ALLOWED_USER_IDS'], message: 'Invalid Telegram user IDs' });
  }
  if (value.APP_MODE === 'live') {
    for (const field of ['OPENAI_API_KEY', 'BRAVE_API_KEY', 'DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'] as const) {
      if (!value[field]?.trim()) ctx.addIssue({ code: 'custom', path: [field], message: 'Required for live mode' });
    }
    if (ids.length === 0) ctx.addIssue({ code: 'custom', path: ['TELEGRAM_ALLOWED_USER_IDS'], message: 'Allowlist required' });
    if (value.DATABASE_URL && !/^postgres(?:ql)?:\/\//.test(value.DATABASE_URL)) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'PostgreSQL URL required' });
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value.TELEGRAM_WEBHOOK_SECRET ?? '')) {
      ctx.addIssue({ code: 'custom', path: ['TELEGRAM_WEBHOOK_SECRET'], message: 'Use a 32–256 character secret' });
    }
  }
});

export function readConfig(env: Record<string, string | undefined>) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Only report field names: validation error dumps can contain credentials.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration fields: ${fields.join(', ')}`);
  }
  const data = parsed.data;
  const [whole = '0', cents = ''] = data.MONTHLY_BUDGET_USD.split('.');
  return {
    mode: data.APP_MODE,
    model: data.OPENAI_MODEL,
    limits: {
      inputTokens: data.MAX_INPUT_TOKENS, outputTokens: data.MAX_OUTPUT_TOKENS,
      dailySearches: data.DAILY_SEARCH_LIMIT,
      monthlyBudgetNanodollars: BigInt(whole) * 1_000_000_000n + BigInt(cents.padEnd(2, '0')) * 10_000_000n,
    },
    telegramAllowedUserIds: [...new Set(data.TELEGRAM_ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean))],
    secrets: {
      openai: data.OPENAI_API_KEY, brave: data.BRAVE_API_KEY, database: data.DATABASE_URL,
      telegram: data.TELEGRAM_BOT_TOKEN, webhook: data.TELEGRAM_WEBHOOK_SECRET,
    },
  };
}
