import { z } from 'zod';
import { asUser, type Database, type Queryable } from '../db/database.js';
import { preferencesSchema, uuidSchema } from '../domain/preferences.js';
import type { LanguageModel } from '../domain/ports.js';
import { LUNA_MODEL } from '../config/index.js';
import { ModelError } from '../ai/openai.js';
import { modelInputBound, modelLimitsSchema, requestHash, runModelJob, type ModelLimits } from '../ai/metered.js';
import { digestConfigSchema, digestTypeSchema, type DigestOptions } from './config.js';
import { loadRankedStories } from './ranked-stories.js';
import { selectDigestStories } from './selection.js';
import { digestInstructions, digestResponseSchema, parseDigestOutput } from './schema.js';
import type { Digest, DigestItem } from './types.js';

const requestSchema = z.object({
  userId:uuidSchema, operationId:uuidSchema, rankingOperationIds:z.array(uuidSchema).max(10),
  periodStart:z.date(), periodEnd:z.date(), type:digestTypeSchema.optional(),
  force:z.boolean().default(false),
  windowHours:z.number().int().min(1).max(168).default(24),allowPageAge:z.boolean().default(false),
  purpose:z.enum(['scheduled','news_now','current_question']).default('scheduled'),
}).strict();
export type DigestRequest = z.input<typeof requestSchema>;
type DigestRow = {id:string;status:string;document:Digest|null;revision:number;purpose:string};

export async function readDigest(db: Database, userId: string, id: string): Promise<Digest | null> {
  uuidSchema.parse(id);
  return asUser(db,userId,async tx => (await tx.query<{document:Digest|null}>(
    "SELECT document FROM digests WHERE user_id=$1 AND id=$2 AND status='succeeded'",[userId,id])).rows[0]?.document ?? null);
}

export async function generateDigest(db: Database, model: LanguageModel, raw: DigestRequest,
  rawLimits: ModelLimits, options: DigestOptions = {}, now = new Date()): Promise<{digest:Digest|null;replayed:boolean;reason?:'NO_ELIGIBLE_RANKED_STORIES'}> {
  const request = requestSchema.parse(raw);
  const config = digestConfigSchema.parse(options), limits = modelLimitsSchema.parse({maxOutputTokens:6000,...rawLimits});
  const {userId,operationId,periodStart,periodEnd} = request;
  if (!Number.isFinite(now.getTime()) || periodStart >= periodEnd || +periodEnd - +periodStart > request.windowHours*3600000
    || periodStart > now || +periodEnd > +now + 86400000) throw new ModelError('DIGEST_PERIOD_INVALID');
  if (model.model !== LUNA_MODEL) throw new ModelError('MODEL_NOT_ALLOWED');
  const profile = await asUser(db,userId,async tx => {
    const row = (await tx.query<{document:unknown;version:number}>(`SELECT p.document,p.version FROM user_preferences p
      JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'`,[userId])).rows[0];
    if (!row) throw new ModelError('DIGEST_USER_NOT_READY');
    return {document:preferencesSchema.parse(row.document),version:row.version};
  });
  const type = request.type ?? profile.document.digestLength;
  const periodParams = [userId,periodStart.toISOString(),periodEnd.toISOString(),type];
  const latest = async (tx: Queryable) => (await tx.query<DigestRow>(`SELECT id,status,document,revision,purpose FROM digests
    WHERE user_id=$1 AND period_start=$2 AND period_end=$3 AND digest_type=$4 ORDER BY revision DESC LIMIT 1`,periodParams)).rows[0];
  const previous = await asUser(db,userId,latest);
  if (previous?.status === 'succeeded' && previous.purpose===request.purpose && (!request.force || previous.id === operationId)) return {digest:previous.document!,replayed:true};
  if (previous && (previous.status === 'running' || (!request.force&&previous.purpose===request.purpose))) throw new ModelError('DIGEST_ALREADY_ATTEMPTED');

  const ranked = await loadRankedStories(db,userId,request.rankingOperationIds,now,periodStart,periodEnd,{windowHours:request.windowHours,allowPageAge:request.allowPageAge});
  let selected = selectDigestStories(ranked,profile.document,type,config).map(story => ({...story,
    headline:story.headline.slice(0,500),sources:story.sources.slice(0,config.maxSourcesPerStory)
      .map(source => ({...source,snippet:source.snippet.slice(0,config.snippetCharacters)}))}));
  const contextFor = () => JSON.stringify({language:profile.document.language,writingStyle:profile.document.writingStyle,
    digestType:type,length:config.lengths[type],stories:selected.map(s => ({clusterId:s.classification.clusterId,
      headline:s.headline,classification:s.classification,sources:s.sources.map(({articleId,name,snippet,contentKind}) => ({articleId,name,snippet,contentKind}))}))});
  // Reduce the lowest-priority tail before calling the model; never retry a billed
  // response merely to fill the target count. Selection already applied priorities.
  let context = contextFor();
  let schema = z.toJSONSchema(digestResponseSchema(config,type,Math.max(1,selected.length))) as Record<string,unknown>;
  while (selected.length && modelInputBound(digestInstructions,context,schema) > limits.maxInputTokens) {
    selected = selected.slice(0,-1); context = contextFor();
    schema = z.toJSONSchema(digestResponseSchema(config,type,Math.max(1,selected.length))) as Record<string,unknown>;
  }
  if (!selected.length) {
    if (ranked.length && selectDigestStories(ranked,profile.document,type,config).length) throw new ModelError('INPUT_TOKEN_LIMIT');
    return {digest:null,replayed:false,reason:'NO_ELIGIBLE_RANKED_STORIES'};
  }
  const key = await requestHash({periodParams,version:profile.version,context,config,force:request.force});
  let document: Digest | null = null;
  const result = await runModelJob(db,model,{userId,operationId,jobType:'news_digest',key,context,schema,
    instructions:digestInstructions,limits,now,parse:value => parseDigestOutput(value,selected,config,type),
    async reserve(tx) {
      const current = (await tx.query<{version:number}>(`SELECT p.version FROM user_preferences p JOIN users u ON u.id=p.user_id
        WHERE p.user_id=$1 AND u.status='active' FOR UPDATE OF p`,[userId])).rows[0];
      if (current?.version !== profile.version) throw new ModelError('DIGEST_PREFERENCES_STALE');
      const prior = await latest(tx);
      if (prior && (prior.status === 'running' || (!request.force&&prior.purpose===request.purpose))) throw new ModelError('DIGEST_ALREADY_ATTEMPTED');
      await tx.query(`INSERT INTO digests(id,user_id,period_start,period_end,digest_type,revision,status,model,
        preference_version,input_story_count,created_at,purpose) VALUES($1,$2,$3,$4,$5,$6,'running',$7,$8,$9,$10,$11)`,
      [operationId,...periodParams,(prior?.revision??0)+1,LUNA_MODEL,profile.version,selected.length,now.toISOString(),request.purpose]);
    },
    async settle(tx,output,error) {
      if (error || !output) {
        await tx.query("UPDATE digests SET status='failed',error_code=$3 WHERE user_id=$1 AND id=$2",[userId,operationId,error]);
        return;
      }
      const sections: Digest['sections'] = [];
      let position = 0;
      for (const story of selected) {
        const c = story.classification, generated = output.items.find(item => item.clusterId === c.clusterId)!;
        const item: DigestItem = {clusterId:c.clusterId,rankingOperationId:story.rankingOperationId,headline:story.headline,
          summary:generated.summary,whyItMatters:generated.whyItMatters,primaryCategory:c.primaryCategory,region:c.region,
          importanceScore:c.importanceScore,relevanceScore:c.userRelevanceScore,entities:c.entities,topics:c.topics,
          sources:story.sources.map(({snippet:_,...source}) => source),evidenceArticleIds:[...new Set(generated.evidence.map(e => e.articleId))]};
        let section = sections.find(section => section.name === story.section);
        if (!section) { section = {name:story.section,items:[]}; sections.push(section); }
        section.items.push(item);
      }
      // Stored position follows rendered section order, not pre-group selection order.
      for (const section of sections) for (const item of section.items) {
        await tx.query(`INSERT INTO digest_items(user_id,digest_id,story_cluster_id,position,section,headline,summary,why_it_matters,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[userId,operationId,item.clusterId,++position,section.name,item.headline,item.summary,item.whyItMatters,JSON.stringify(item)]);
      }
      document = {id:operationId,userId,title:request.purpose==='scheduled'?'Morning Briefing':'News now',type,language:profile.document.language,
        periodStart:periodStart.toISOString(),periodEnd:periodEnd.toISOString(),generatedAt:now.toISOString(),model:LUNA_MODEL,
        preferenceVersion:profile.version,inputStoryCount:selected.length,outputStoryCount:position,sections};
      await tx.query(`UPDATE digests SET status='succeeded',document=$3::jsonb,generated_at=$4,output_story_count=$5
        WHERE user_id=$1 AND id=$2`,[userId,operationId,JSON.stringify(document),now.toISOString(),position]);
    },
  });
  return {digest:result.replayed ? await readDigest(db,userId,operationId) : document,replayed:result.replayed};
}
