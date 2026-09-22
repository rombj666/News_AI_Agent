import { z } from 'zod';

export const uuidSchema = z.uuid();
export const telegramIdSchema = z.string().regex(/^[1-9]\d{0,15}$/);
const key = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} _.-]+$/u);
const priorities = z.record(key, z.number().int().min(0).max(5))
  .refine((value) => Object.keys(value).length <= 100, 'Too many preference entries');

export const preferencesSchema = z.object({
  language: z.string().trim().min(2).max(35),
  digestLength: z.enum(['quick', 'normal', 'deep']),
  writingStyle: z.enum(['simple', 'concise', 'professional', 'detailed']),
  timezone: z.string().max(80).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Invalid timezone'),
  deliveryTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  deliveryEnabled: z.boolean(),
  topics: priorities,
  regions: priorities,
  sources: priorities,
  exclusions: z.array(z.string().trim().min(1).max(150)).max(100),
}).strict();

export type Preferences = z.infer<typeof preferencesSchema>;

// Suggested onboarding values only. Delivery stays off until the user confirms.
export function initialPreferences(): Preferences {
  return preferencesSchema.parse({
    language: 'en', digestLength: 'normal', writingStyle: 'simple',
    timezone: 'Asia/Kuala_Lumpur', deliveryTime: '07:00', deliveryEnabled: false,
    topics: {}, regions: {}, sources: {}, exclusions: [],
  });
}

export class DomainError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'EXPIRED' | 'STALE' | 'NOT_PENDING' | 'NO_CHANGE' | 'FORBIDDEN') {
    super(code);
    this.name = 'DomainError';
  }
}
