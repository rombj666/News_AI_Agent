import type { LUNA_MODEL } from '../config/index.js';

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

export interface NewsCandidate {
  imageUrl?: string | null;
  url: string;
  title: string;
  source: string;
  publishedAt: string | null;
  fetchedAt: string;
  excerpt: string;
  contentKind: 'snippet' | 'feed_excerpt' | 'full_text';
  dateKind: 'published' | 'page_age' | 'unknown';
  rawMetadata: Record<string, unknown>;
}

export interface RetrievalRequest {
  query: string;
  since: Date;
  limit: number;
  signal: AbortSignal;
  etag?: string;
  lastModified?: string;
}

export interface RetrievalBatch {
  items: NewsCandidate[];
  fetched: number;
  failures: { code: string; index?: number }[];
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
}

export interface NewsRetriever {
  readonly provider: 'rss' | 'brave';
  readonly source?: { id: string; url: string };
  collect(request: RetrievalRequest): Promise<RetrievalBatch>;
}

// Live implementation must meter every attempt before exposing this port.
export interface LanguageModel {
  readonly model: typeof LUNA_MODEL;
  generate(request: { instructions: string; context: string; maxOutputTokens: number; signal: AbortSignal; responseSchema?: Record<string, unknown> }): Promise<{
    text: string;
    usage: { inputTokens: number; cachedInputTokens: number | null; outputTokens: number } | null;
    requestId: string | null;
  }>;
}

export interface DigestDelivery {
  send(request: { userId: string; digestId: string; text: string; idempotencyKey: string }): Promise<{
    status: 'sent' | 'uncertain'; messageIds: string[];
  }>;
}
