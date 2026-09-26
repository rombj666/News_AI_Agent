import { localDatabase } from '../../scripts/local-db.js';
import { createUser } from '../../src/services/identity.js';
import { readPreferences,proposePreferences,decideProposal } from '../../src/services/preferences.js';
import { FakeTelegram } from './telegram.js';
import { digestFixtureModel,digestTestLimits } from './digest.js';
import type { LanguageModel,NewsRetriever,NewsCandidate } from '../../src/domain/ports.js';
import type { PipelineDeps } from '../../src/scheduling/pipeline.js';

export const SCHEDULE_NOW=new Date('2026-09-26T23:00:00Z'); // 07:00 Kuala Lumpur
export async function schedulerFixture(empty=false,dataDir?:string) {
  const db=await localDatabase(dataDir),telegramId='1837198543',userId=await createUser(db.owner,telegramId);
  const prefs=await readPreferences(db.runtime,userId);
  const proposal=await proposePreferences(db.runtime,userId,{...prefs.document,deliveryEnabled:true},{now:()=>SCHEDULE_NOW});
  await decideProposal(db.runtime,userId,proposal.id,'confirm',{now:()=>SCHEDULE_NOW});
  const source={id:'fixture-scheduled',name:'Fictional Daily',url:'https://example.com/feed',category:'world',enabled:true};
  const items:NewsCandidate[]=empty?[]:[
    {url:'https://example.com/scheduled/1',title:'Regional science lab releases telescope software',excerpt:'A fictional science lab released telescope software for local researchers.',
      source:'Fictional Daily',publishedAt:new Date(+SCHEDULE_NOW-3600000).toISOString(),fetchedAt:SCHEDULE_NOW.toISOString(),dateKind:'published',contentKind:'feed_excerpt',rawMetadata:{}},
    {url:'https://example.com/scheduled/2',title:'Coastal council opens flood warning centre',excerpt:'A fictional coastal council opened its flood warning centre for residents.',
      source:'Fictional Daily',publishedAt:new Date(+SCHEDULE_NOW-7200000).toISOString(),fetchedAt:SCHEDULE_NOW.toISOString(),dateKind:'published',contentKind:'feed_excerpt',rawMetadata:{}},
  ];
  const counts={retrieval:0,ranking:0,digest:0};
  const retriever:NewsRetriever={provider:'rss',source,async collect(){counts.retrieval++;return {items,fetched:items.length,failures:[],notModified:false,etag:null,lastModified:null};}};
  const model:LanguageModel={...digestFixtureModel,async generate(request){
    const input=JSON.parse(request.context);
    if(input.stories[0].sources) {counts.digest++;return digestFixtureModel.generate(request);}
    counts.ranking++;
    return {text:JSON.stringify({stories:input.stories.map((s:{clusterId:string})=>({clusterId:s.clusterId,primaryCategory:'world',secondaryCategories:[],region:'World',countries:[],
      importanceScore:60,userRelevanceScore:50,confidence:0.8,importanceReason:'Fictional public-interest report.',entities:[],topics:[]}))}),
      usage:{inputTokens:100,cachedInputTokens:0,outputTokens:80},requestId:'resp_mock_scheduler'};
  }};
  const transport=new FakeTelegram();
  const deps:PipelineDeps={db:db.runtime,collector:db.collector,quality:db.quality,model,transport,botId:'123456',
    sources:[{retriever,request:{source,category:source.category,limit:10}}],rankingLimits:digestTestLimits,digestLimits:digestTestLimits,clock:{now:()=>SCHEDULE_NOW}};
  return {db,userId,telegramId,deps,counts,transport,items};
}
