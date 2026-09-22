import { z } from 'zod';

export const QUALITY_VERSION = 'deterministic-title-v1';
export const qualityConfigSchema = z.object({
  windowHours: z.number().int().min(1).max(168).default(24),
  allowPageAge: z.boolean().default(false),
  maxStorySpanHours: z.number().int().min(1).max(168).default(48),
  titleThreshold: z.number().min(0.5).max(1).default(0.65),
  minimumSharedTokens: z.number().int().min(2).max(10).default(3),
  maxArticles: z.number().int().min(1).max(5000).default(2000),
  sourcePriority: z.record(z.string().min(1).max(253), z.number().int().min(0).max(100)).default({}),
}).strict();
export type QualityConfig = z.infer<typeof qualityConfigSchema>;
export type QualityOptions = z.input<typeof qualityConfigSchema>;
