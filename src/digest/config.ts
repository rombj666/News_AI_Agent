import { z } from 'zod';

export const digestTypeSchema = z.enum(['quick','normal','deep']);
export type DigestType = z.infer<typeof digestTypeSchema>;
const lengthSchema = z.object({
  stories: z.number().int().min(1).max(30),
  summaryCharacters: z.number().int().min(80).max(1200),
  explanationCharacters: z.number().int().min(80).max(800),
}).strict();
export const digestConfigSchema = z.object({
  lengths: z.object({
    quick: lengthSchema.default({stories:5,summaryCharacters:220,explanationCharacters:160}),
    normal: lengthSchema.default({stories:12,summaryCharacters:500,explanationCharacters:300}),
    deep: lengthSchema.default({stories:20,summaryCharacters:900,explanationCharacters:600}),
  }).prefault({}),
  maxStories: z.number().int().min(1).max(30).optional(),
  topStories: z.number().int().min(0).max(5).default(2),
  snippetCharacters: z.number().int().min(80).max(1600).default(700),
  maxSourcesPerStory: z.number().int().min(1).max(10).default(4),
  topicWeight: z.number().min(0).max(20).default(6),
  regionWeight: z.number().min(0).max(20).default(4),
  sourceWeight: z.number().min(0).max(20).default(2),
}).strict();
export type DigestConfig = z.infer<typeof digestConfigSchema>;
export type DigestOptions = z.input<typeof digestConfigSchema>;
