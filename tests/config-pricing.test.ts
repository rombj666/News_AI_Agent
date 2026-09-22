import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config/index.js';
import { initialPreferences, preferencesSchema } from '../src/domain/preferences.js';
import { authorizeTelegramUser } from '../src/services/identity.js';
import { estimateLunaCost, formatUsd, hasAllowance } from '../src/usage/pricing.js';
import worker from '../src/entrypoints/worker.js';

test('offline defaults do not enable delivery or live providers', () => {
  const config = readConfig({});
  assert.equal(config.mode, 'offline');
  assert.equal(config.model, 'gpt-5.6-luna');
  assert.equal(config.limits.monthlyBudgetNanodollars, 10_000_000_000n);
  assert.deepEqual(config.telegramAllowedUserIds, []);
  assert.equal(initialPreferences().deliveryEnabled, false);
  assert.deepEqual(initialPreferences().topics, {});
});

test('config rejects model substitution, bad limits and incomplete live settings without leaking secrets', () => {
  assert.throws(() => readConfig({ OPENAI_MODEL: 'another-model' }), /OPENAI_MODEL/);
  assert.throws(() => readConfig({ MAX_INPUT_TOKENS: '-1' }), /MAX_INPUT_TOKENS/);
  assert.throws(() => readConfig({ MONTHLY_BUDGET_USD: '0.001' }), /MONTHLY_BUDGET_USD/);
  assert.throws(() => readConfig({ TELEGRAM_ALLOWED_USER_IDS: 'abc' }), /TELEGRAM_ALLOWED_USER_IDS/);
  assert.throws(() => readConfig({ APP_MODE: 'live', DATABASE_URL: 'sensitive-invalid-url' }), (error: Error) => {
    assert.match(error.message, /DATABASE_URL/);
    assert.doesNotMatch(error.message, /sensitive-invalid-url/);
    return true;
  });
  assert.equal(readConfig({ MONTHLY_BUDGET_USD: '0.05' }).limits.monthlyBudgetNanodollars, 50_000_000n);
});

test('preferences reject unknown keys, invalid times, timezones and priority overflow', () => {
  assert.throws(() => preferencesSchema.parse({ ...initialPreferences(), timezone: 'invented' }));
  assert.throws(() => preferencesSchema.parse({ ...initialPreferences(), deliveryTime: '25:00' }));
  assert.throws(() => preferencesSchema.parse({ ...initialPreferences(), topics: { AI: 6 } }));
  assert.throws(() => preferencesSchema.parse({ ...initialPreferences(), admin: true }));
});

test('Telegram allowlist denies missing, numeric and foreign identities', () => {
  assert.equal(authorizeTelegramUser('12345', ['12345']), '12345');
  for (const value of [undefined, 12345, '12346', '']) {
    assert.throws(() => authorizeTelegramUser(value, ['12345']), /FORBIDDEN/);
  }
});

test('Luna pricing uses cached input as a subset and preserves unknown usage', () => {
  assert.equal(estimateLunaCost({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 }), 368_000n);
  assert.equal(estimateLunaCost(null), null);
  assert.equal(estimateLunaCost({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), 0n);
  assert.equal(formatUsd(440_000n), '$0.000440');
  assert.throws(() => estimateLunaCost({ inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 }));
  assert.throws(() => estimateLunaCost({ inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 }));
  assert.throws(() => estimateLunaCost({ inputTokens: 272_001, cachedInputTokens: 0, outputTokens: 0 }));
});

test('allowance accounts for reservations and fails closed on unknown costs', () => {
  const base = { spent: 5n, reserved: 3n, estimated: 2n, budget: 10n, unknownAttempts: 0 };
  assert.equal(hasAllowance(base), true);
  assert.equal(hasAllowance({ ...base, estimated: 3n }), false);
  assert.equal(hasAllowance({ ...base, unknownAttempts: 1 }), false);
  assert.throws(() => hasAllowance({ ...base, spent: -1n }));
});

test('Worker exposes health only and does not claim integrations are live', async () => {
  const response = await worker.fetch(new Request('https://example.test/health'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).liveIntegrations, false);
  assert.equal((await worker.fetch(new Request('https://example.test/telegram', { method: 'POST' }))).status, 404);
});
