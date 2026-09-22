import { z } from 'zod';
import { publicHttpsUrl } from './http.js';

export const rssSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  name: z.string().trim().min(1).max(200),
  url: z.string().max(2048).refine((value) => { try { publicHttpsUrl(value); return true; } catch { return false; } }, 'Public HTTPS feed required'),
  category: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
}).strict();
export type RssSource = z.infer<typeof rssSourceSchema>;

export function parseRssSources(value: unknown): RssSource[] {
  const sources = z.array(rssSourceSchema).max(100).parse(value);
  if (new Set(sources.map((source) => source.id)).size !== sources.length
    || new Set(sources.map((source) => source.url)).size !== sources.length) throw new Error('Duplicate RSS source ID or URL');
  return sources;
}
