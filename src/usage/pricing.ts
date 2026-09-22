export type TokenUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
export const LUNA_TEXT_RATES = {
  version: 'openai-luna-standard-text-2026-09-17',
  currency: 'USD', inputNanodollarsPerToken: 200n,
  cachedInputNanodollarsPerToken: 20n, outputNanodollarsPerToken: 1200n,
} as const;

export function validateUsage(usage: TokenUsage): void {
  for (const value of [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid token usage');
  }
  if (usage.cachedInputTokens > usage.inputTokens) throw new Error('Cached tokens exceed input');
}

export function estimateLunaCost(usage: TokenUsage | null): bigint | null {
  if (usage === null) return null;
  validateUsage(usage);
  if (usage.inputTokens > 272_000) throw new Error('Large-context pricing is not configured');
  return BigInt(usage.inputTokens - usage.cachedInputTokens) * LUNA_TEXT_RATES.inputNanodollarsPerToken
    + BigInt(usage.cachedInputTokens) * LUNA_TEXT_RATES.cachedInputNanodollarsPerToken
    + BigInt(usage.outputTokens) * LUNA_TEXT_RATES.outputNanodollarsPerToken;
}

export function formatUsd(nanodollars: bigint): string {
  if (nanodollars < 0n) throw new Error('Negative money');
  const millionths = (nanodollars + 500n) / 1000n;
  return `$${millionths / 1_000_000n}.${(millionths % 1_000_000n).toString().padStart(6, '0')}`;
}

// Policy helper only. Live callers additionally require atomic reservations.
export function hasAllowance(input: { spent: bigint; reserved: bigint; estimated: bigint; budget: bigint; unknownAttempts: number }): boolean {
  if ([input.spent, input.reserved, input.estimated, input.budget].some((v) => v < 0n)
    || !Number.isSafeInteger(input.unknownAttempts) || input.unknownAttempts < 0) throw new Error('Invalid allowance inputs');
  return input.unknownAttempts === 0 && input.spent + input.reserved + input.estimated <= input.budget;
}
