import { asUser,type Database } from '../db/database.js';
import { uuidSchema,type Preferences } from '../domain/preferences.js';
import { systemClock,type Clock,type LanguageModel,type NewsRetriever } from '../domain/ports.js';
import { readPreferences } from './preferences.js';
import { collectNews,type CollectionLimits } from '../retrieval/collect.js';
import { sharedCollection,type CollectionSource } from '../scheduling/collection.js';
import { refreshQuality } from '../quality/service.js';
import { rankStories,fitRankingCandidates } from '../ai/ranking.js';
import { requestHash,type ModelLimits } from '../ai/metered.js';
import { ModelError } from '../ai/openai.js';
import { generateDigest,readDigest } from '../digest/service.js';
import type { Digest } from '../digest/types.js';

export class NewsNowError extends ModelError {
  constructor(code:string,public readonly stage:'retrieval'|'generation'){super(code);}
}
export interface NewsNowRequest {userId:string;operationId:string;text:string;question:boolean;now:Date}
export type NewsNowHandler=(request:NewsNowRequest)=>Promise<Digest|null>;
export type NewsNowDeps={db:Database;collector:Database;quality:Database;model:LanguageModel;
  brave:NewsRetriever;braveLimits:CollectionLimits;rss:CollectionSource[];
  rankingLimits:ModelLimits;digestLimits:ModelLimits;clock?:Clock};
const tokens=(value:string)=>value.toLowerCase().replace(/artificial intelligence/g,'ai').replace(/technology/g,'tech')
  .replace(/\bunited states(?: of america)?\b|\bamerican\b|\bu\.s\.(?:a\.)?/g,'usa').replace(/\bmalaysian\b/g,'malaysia')
  .match(/[\p{L}\p{N}]+/gu)??[];
const boilerplate=new Set('news latest current now today this week happening happened what whats is are the with in about for any important give me show find search look up please of on developments s has been'.split(' '));
export function newsSearchPlan(text:string,p:Preferences) {
  const scope=tokens(text.replace(/^\/news\b/i,'')).filter(t=>!boilerplate.has(t));
  const names=(values:Record<string,number>)=>Object.entries(values).filter(([,n])=>n>0)
    .sort(([a,x],[b,y])=>y-x||a.localeCompare(b)).slice(0,3).map(([name])=>tokens(name).join(' ')).filter(Boolean);
  const topics=names(p.topics),regions=names(p.regions);
  const group=(parts:string[])=>parts.length?`(${parts.map(s=>`"${s}"`).join(' OR ')})`:'';
  const query=scope.length?scope.join(' '):[group(topics),group(regions),'news'].filter(Boolean).join(' ');
  if(query.length>400||query.split(/\s+/).length>50)throw new NewsNowError('LIVE_QUERY_INVALID','retrieval');
  return {query,scope,windowHours:/\bthis week\b/i.test(text)?168:24};
}
async function childId(id:string,label:string) {
  const h=await requestHash({id,label});return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function createNewsNow(deps:NewsNowDeps):NewsNowHandler {
  return async request=>{
    const {userId,operationId,now}=request;uuidSchema.parse(userId);uuidSchema.parse(operationId);
    if(!Number.isFinite(+now)||!request.text.trim()||request.text.length>1500)throw new NewsNowError('NEWS_REQUEST_INVALID','retrieval');
    const profile=await readPreferences(deps.db,userId),plan=newsSearchPlan(request.text,profile.document);
    const key=await requestHash({text:request.text,question:request.question});
    const prior=await asUser(deps.db,userId,async tx=>{
      if(!(await tx.query("SELECT id FROM users WHERE id=$1 AND status='active'",[userId])).rows.length)throw new NewsNowError('NEWS_USER_NOT_READY','retrieval');
      const inserted=await tx.query(`INSERT INTO news_now_runs(user_id,id,request_key,created_at)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,[userId,operationId,key,now.toISOString()]);
      if(inserted.rows.length)return null;
      return (await tx.query<{request_key:string;status:string;digest_id:string|null}>(
        'SELECT request_key,status,digest_id FROM news_now_runs WHERE user_id=$1 AND id=$2',[userId,operationId])).rows[0]!;
    });
    if(prior) {
      if(prior.request_key!==key)throw new NewsNowError('NEWS_REQUEST_CONFLICT','retrieval');
      if(prior.status==='completed'&&prior.digest_id)return readDigest(deps.db,userId,prior.digest_id);
      if(prior.status==='no_fresh')return null;
      throw new NewsNowError('NEWS_ALREADY_ATTEMPTED','retrieval');
    }
    const update=(status:string,stage:string|null,code:string|null,digestId:string|null)=>asUser(deps.db,userId,tx=>tx.query(
      'UPDATE news_now_runs SET status=$3,failure_stage=$4,failure_code=$5,digest_id=$6,completed_at=$7 WHERE user_id=$1 AND id=$2',
      [userId,operationId,status,stage,code,digestId,(deps.clock??systemClock).now().toISOString()]));
    let stage:'retrieval'|'generation'='retrieval';
    try {
      // Private query/provenance/usage belong to the requesting user. Never put
      // this query in the shared scheduled collection cache.
      let run;
      try {run=await collectNews(deps.collector,deps.brave,{runId:await childId(operationId,'brave'),userId,
        query:plan.query,category:'interactive-news',since:new Date(+now-plan.windowHours*3600000),limit:10},
        {limits:deps.braveLimits,...(deps.clock?{clock:deps.clock}:{})});}
      catch(error) {throw new NewsNowError(error instanceof Error&&error.message==='COLLECTION_ALLOWANCE_EXCEEDED'
        ?'BRAVE_BUDGET_EXCEEDED':'BRAVE_COLLECTION_FAILED','retrieval');}
      if(run.status==='running')throw new NewsNowError('BRAVE_ALREADY_ATTEMPTED','retrieval');
      if(run.status==='failed'||(run.status==='partial'&&run.number_inserted+run.number_duplicates===0)) {
        const code=run.failures[0]?.code??'RESPONSE_INVALID';
        throw new NewsNowError(/^[A-Z0-9_]{1,60}$/.test(code)?`BRAVE_${code}`:'BRAVE_RESPONSE_INVALID','retrieval');
      }
      await sharedCollection(deps.collector,deps.rss,now,undefined,deps.clock);
      const ids=await asUser(deps.db,userId,tx=>tx.query<{article_id:string}>(
        'SELECT article_id FROM article_retrievals WHERE run_id=$1',[run.id]));
      const retrieved=new Set(ids.rows.map(r=>r.article_id));
      const preferred=Object.entries(profile.document.topics).filter(([,priority])=>priority>0).map(([name])=>tokens(name));
      // Brave supplies page-age timestamps, not publisher-verified dates. Permit
      // those explicitly for live requests only; undated/future results stay out.
      const qualityOptions={allowPageAge:true,windowHours:plan.windowHours};
      const quality=await refreshQuality(deps.quality,now,qualityOptions);
      quality.candidates=quality.candidates.filter(candidate=>{
        const content=new Set(tokens(candidate.title+' '+candidate.representative.description));
        const matches=plan.scope.length>0&&plan.scope.every(t=>content.has(t));
        return plan.scope.length?matches:(candidate.sources.some(s=>retrieved.has(s.articleId))
          ||preferred.some(topic=>topic.length>0&&topic.every(t=>content.has(t))));
      });
      if(!quality.candidates.length){await update('no_fresh',null,null,null);return null;}
      stage='generation';
      quality.candidates=fitRankingCandidates(quality.candidates,profile.document,deps.rankingLimits,request.question?3:12,plan.query);
      const rankingId=await childId(operationId,'ranking');
      await rankStories(deps.db,deps.model,userId,rankingId,quality,{...deps.rankingLimits,budgetScope:'job_type'},now,
        {quality:qualityOptions,requestTopic:plan.query});
      const result=await generateDigest(deps.db,deps.model,{userId,operationId,rankingOperationIds:[rankingId],
        periodStart:new Date(+now-plan.windowHours*3600000),periodEnd:now,type:request.question?'quick':profile.document.digestLength,
        ...qualityOptions,force:true,purpose:request.question?'current_question':'news_now'},
        {...deps.digestLimits,budgetScope:'job_type'},{},now);
      await update(result.digest?'completed':'no_fresh',null,null,result.digest?.id??null);
      return result.digest;
    }catch(error) {
      const code=error instanceof ModelError&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'NEWS_PIPELINE_FAILED';
      await update('failed',stage,code,null);
      throw new NewsNowError(code,stage);
    }
  };
}
