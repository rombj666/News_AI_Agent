import type { Database } from '../db/database.js';
import { asUser } from '../db/database.js';
import { preferencesSchema, uuidSchema,type Preferences } from '../domain/preferences.js';
import type { LanguageModel } from '../domain/ports.js';
import { LUNA_MODEL } from '../config/index.js';
import { qualityConfigSchema } from '../quality/config.js';
import { freshness } from '../quality/freshness.js';
import type { StoryCandidate } from '../quality/types.js';
import { ModelError } from './openai.js';
import { modelInputBound,modelLimitsSchema, runModelJob, requestHash, type ModelLimits } from './metered.js';
import { rankingInstructions, rankingJsonSchema, rankingOutputSchema, type Classification } from './ranking-schema.js';

export type RankingLimits=ModelLimits;
export type QualityInput={runId:string;candidates:StoryCandidate[]};
const fail=(code:string):never=>{throw new ModelError(code);};
function rankingContext(prefs:Preferences,candidates:StoryCandidate[]) {
  return JSON.stringify({preferences:{topics:prefs.topics,regions:prefs.regions,sources:prefs.sources,exclusions:prefs.exclusions},
    stories:candidates.map(c=>({clusterId:c.clusterId,title:c.title.slice(0,500),description:c.representative.description.slice(0,1600),
      publishedAt:c.representative.publishedAt,source:c.representative.sourceDomain,sourceCount:c.sourceCount}))});
}
export function fitRankingCandidates(candidates:StoryCandidate[],prefs:Preferences,limits:ModelLimits,max=12) {
  const selected=candidates.slice(0,max);
  while(selected.length&&modelInputBound(rankingInstructions,rankingContext(prefs,selected),rankingJsonSchema)>(limits.maxInputTokens??12000)) selected.pop();
  if(!selected.length&&candidates.length) throw new ModelError('INPUT_TOKEN_LIMIT');
  return selected;
}
export async function rankStories(db:Database,model:LanguageModel,userId:string,operationId:string,
  quality:QualityInput,rawLimits:RankingLimits,now=new Date()) {
  uuidSchema.parse(userId);uuidSchema.parse(operationId);uuidSchema.parse(quality.runId);
  const limits=modelLimitsSchema.parse(rawLimits);
  if(model.model!==LUNA_MODEL) fail('MODEL_NOT_ALLOWED');
  if(!Number.isFinite(now.getTime())) fail('RANKING_TIME_INVALID');
  const candidates=quality.candidates;
  if(candidates.length===0) return {stories:[],replayed:false};
  if(candidates.length>20 || new Set(candidates.map(c=>c.clusterId)).size!==candidates.length) fail('CANDIDATE_LIMIT_OR_DUPLICATE');
  const config=qualityConfigSchema.parse({});
  for(const c of candidates) {
    if(freshness(c.representative,now,config)!=='fresh') fail('CANDIDATE_NOT_FRESH');
  }
  const prefs=await asUser(db,userId,async tx=>{
    const result=await tx.query<{document:unknown}>(`SELECT p.document FROM user_preferences p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'`,[userId]);
    if(!result.rows[0]) fail('RANKING_USER_NOT_READY');
    return preferencesSchema.parse(result.rows[0]!.document);
  });
  // Verify the supplied candidates belong to the active persisted quality snapshot.
  for(const c of candidates) {
    const result=await db.query(`SELECT id FROM story_clusters WHERE id=$1 AND quality_run_id=$2 AND representative_article_id=$3 AND active=true`,[c.clusterId,quality.runId,c.representative.id]);
    if(!result.rows.length) fail('QUALITY_SNAPSHOT_STALE');
  }
  const context=rankingContext(prefs,candidates);
  const key=await requestHash({context,qualityRun:quality.runId,model:model.model,limits:{...limits,monthlyBudgetNanodollars:limits.monthlyBudgetNanodollars.toString()}});
  const result=await runModelJob(db,model,{userId,operationId,jobType:'news_ranking',key,
    instructions:rankingInstructions,context,schema:rankingJsonSchema,limits,now,
    parse(value) {
      const parsed=rankingOutputSchema.safeParse(value);
      if(!parsed.success) throw new ModelError('MODEL_OUTPUT_INVALID');
      const ids=new Set(parsed.data.stories.map(s=>s.clusterId));
      if(ids.size!==candidates.length || parsed.data.stories.length!==candidates.length || candidates.some(c=>!ids.has(c.clusterId))) fail('MODEL_CLUSTER_IDS_INVALID');
      return parsed.data;
    },
  });
  return {stories:attach(result.output.stories,candidates),replayed:result.replayed};
}
function attach(stories:Classification[],candidates:StoryCandidate[]) {
  return stories.map(classification=>({classification,candidate:candidates.find(c=>c.clusterId===classification.clusterId)!,
    score:Math.round((classification.userRelevanceScore*0.6+classification.importanceScore*0.4)*100)/100}))
    .sort((a,b)=>b.score-a.score || b.classification.confidence-a.classification.confidence || a.classification.clusterId.localeCompare(b.classification.clusterId));
}
