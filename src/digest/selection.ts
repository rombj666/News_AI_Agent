import type { Preferences } from '../domain/preferences.js';
import { digestConfigSchema, type DigestOptions, type DigestType } from './config.js';
import type { RankedStory, SelectedStory } from './types.js';

const key = (s: string) => s.normalize('NFKC').toLowerCase().trim();
function matches(value: string, labels: string[]) {
  const needle = ` ${key(value).replace(/[^\p{L}\p{N}]+/gu,' ')} `;
  return labels.some(label => ` ${key(label).replace(/[^\p{L}\p{N}]+/gu,' ')} `.includes(needle));
}
function priority(values: Record<string,number>, labels: string[]): number | null {
  const found = Object.entries(values).filter(([name]) => matches(name,labels)).map(([,p]) => p);
  return found.includes(0) ? 0 : found.length ? Math.max(...found) : null;
}
export function selectDigestStories(stories: RankedStory[], prefs: Preferences, type: DigestType, options: DigestOptions = {}): SelectedStory[] {
  const config = digestConfigSchema.parse(options);
  const selected: SelectedStory[] = [];
  const seen = new Set<string>();
  for (const story of stories) {
    const c = story.classification;
    if (seen.has(c.clusterId)) continue;
    seen.add(c.clusterId);
    const topics = [c.primaryCategory,...c.secondaryCategories,...c.topics,...c.entities];
    const regions = [c.region ?? '',...c.countries];
    const sources = story.sources.map(s => new URL(s.url).hostname.replace(/^www\./,''));
    // A user phrase such as "entertainment news" refers to the entertainment
    // category even when the classifier does not append the generic word news.
    if (prefs.exclusions.some(exclusion => matches(exclusion.replace(/\s+news$/i,''),[...topics,...regions,...sources,story.headline]))) continue;
    const topic = priority(prefs.topics,topics), region = priority(prefs.regions,regions), source = priority(prefs.sources,sources);
    if ([topic,region,source].includes(0)) continue;
    const selectionScore = c.userRelevanceScore * 0.6 + c.importanceScore * 0.4
      + (topic ?? 0) * config.topicWeight + (region ?? 0) * config.regionWeight + (source ?? 0) * config.sourceWeight;
    const section = region !== null && c.region ? c.region
      : c.primaryCategory === 'technology' ? 'AI & Technology'
      : c.primaryCategory[0]!.toUpperCase() + c.primaryCategory.slice(1);
    selected.push({...story,section,selectionScore});
  }
  return selected.sort((a,b) => b.selectionScore-a.selectionScore || a.classification.clusterId.localeCompare(b.classification.clusterId))
    .slice(0,Math.min(config.lengths[type].stories,config.maxStories ?? 30))
    .map((story,i) => ({...story,section:i < config.topStories ? 'Top Stories' : story.section}));
}
