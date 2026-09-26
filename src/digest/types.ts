import type { Classification } from '../ai/ranking-schema.js';
import type { DigestType } from './config.js';

export interface DigestSource {
  imageUrl?:string;
  articleId: string; name: string; url: string; publishedAt: string;
  snippet: string; contentKind: string;
}
export interface RankedStory {
  rankingOperationId: string; classification: Classification;
  headline: string; sources: DigestSource[];
}
export interface SelectedStory extends RankedStory { section: string; selectionScore: number }
export interface DigestItem {
  clusterId: string; rankingOperationId: string; headline: string; summary: string; whyItMatters: string;
  primaryCategory: Classification['primaryCategory']; region: string | null;
  importanceScore: number; relevanceScore: number; entities: string[]; topics: string[];
  sources: Omit<DigestSource,'snippet'>[]; evidenceArticleIds: string[];
}
export interface Digest {
  id: string; userId: string; title: string; type: DigestType; language: string;
  periodStart: string; periodEnd: string; generatedAt: string; model: string;
  preferenceVersion: number; inputStoryCount: number; outputStoryCount: number;
  sections: { name: string; items: DigestItem[] }[];
}
