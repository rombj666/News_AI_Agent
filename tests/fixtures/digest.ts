import type { localDatabase } from '../../scripts/local-db.js';
import { normalizeArticle } from '../../src/retrieval/normalize.js';
import { persistArticle } from '../../src/retrieval/repository.js';
import { refreshQuality } from '../../src/quality/service.js';
import { rankStories } from '../../src/ai/ranking.js';
import { LUNA_MODEL } from '../../src/config/index.js';
import type { LanguageModel } from '../../src/domain/ports.js';

export const DIGEST_NOW = new Date('2026-09-23T12:00:00Z');
export const DIGEST_START = new Date('2026-09-23T00:00:00Z');
export const DIGEST_END = new Date('2026-09-24T00:00:00Z');
export const digestTestLimits = {monthlyBudgetNanodollars:1_000_000_000n,maxInputTokens:30000,maxOutputTokens:4000};
export const digestFixtureModel: LanguageModel = {model:LUNA_MODEL,async generate(request) {
  const input = JSON.parse(request.context) as {stories:{clusterId:string;headline:string;sources:{articleId:string;snippet:string}[]}[]};
  return {text:JSON.stringify({items:input.stories.map(story => ({clusterId:story.clusterId,
    summary:story.sources[0]!.snippet,whyItMatters:'This fictional report may affect local planning; the available excerpt provides limited detail.',
    evidence:[{articleId:story.sources[0]!.articleId,quote:story.sources[0]!.snippet}]}))}),
  usage:{inputTokens:100,cachedInputTokens:0,outputTokens:80},requestId:'resp_offline_fixture'};
}};

export async function seedDigestRankings(db: Awaited<ReturnType<typeof localDatabase>>, userId: string) {
  const examples = [
    ['Orbital lab publishes open telescope software','technology','AI','World','The fictional Orbital lab released telescope software for researchers.'],
    ['Malaysia opens coastal flood warning centre','environment','Floods','Malaysia','A fictional Malaysian council opened a flood warning centre.'],
    ['Regional markets extend small business grants','business','Grants','World','A fictional regional council extended its small business grant programme.'],
    ['International delegates announce water talks','world','Water','World','Fictional delegates announced talks on shared water access.'],
  ];
  for (const [i,example] of examples.entries()) {
    await db.collector.transaction(async tx => persistArticle(tx,await normalizeArticle({url:`https://example.com/digest/${i}`,
      title:example[0]!,source:'Fictional News',excerpt:example[4]!,publishedAt:'2026-09-23T08:00:00Z',fetchedAt:DIGEST_NOW.toISOString(),
      dateKind:'published',contentKind:'feed_excerpt',rawMetadata:{},...(i<2?{imageUrl:`https://example.com/image${i}.jpg`}:{})})));
  }
  const quality = await refreshQuality(db.quality,DIGEST_NOW);
  const operationId = crypto.randomUUID();
  await rankStories(db.runtime,{model:LUNA_MODEL,async generate() {
    return {text:JSON.stringify({stories:quality.candidates.map(c => {
      const e = examples.find(example => example[0] === c.title)!;
      return {clusterId:c.clusterId,primaryCategory:e[1],secondaryCategories:[],region:e[3],countries:e[3]==='Malaysia'?['MY']:[],
        importanceScore:60,userRelevanceScore:50,confidence:0.8,importanceReason:'Fictional public-interest example.',entities:[],topics:[e[2]]};
    })}),usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0},requestId:null};
  }},userId,operationId,quality,digestTestLimits,DIGEST_NOW);
  return operationId;
}
