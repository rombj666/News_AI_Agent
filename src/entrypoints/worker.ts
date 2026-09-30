import { productionConfig,type ProductionEnv } from '../production/config.js';
import { processInteractiveInbox,productionReady,productionTick } from '../production/runtime.js';
import { neonDatabase } from '../db/neon.js';
import { enqueueUpdate,isNewsUpdate } from '../production/inbox.js';
import { telegramUpdateSchema,type TelegramUpdate } from '../adapters/telegram/types.js';
import { BraveConfigError } from '../retrieval/brave-config.js';
import { ScheduleConfigError } from '../scheduling/config.js';
import { acknowledgeNewsUpdate } from '../production/news-status.js';

async function secretMatches(actual:string|null,expected:string|undefined) {
  if(!actual||!expected||!/^[A-Za-z0-9_-]{32,256}$/.test(expected))return false;
  const hash=async(value:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const [a,b]=await Promise.all([hash(actual),hash(expected)]);let different=0;
  for(let i=0;i<a.length;i++)different|=a[i]!^b[i]!;
  return different===0;
}
async function readUpdate(request:Request):Promise<TelegramUpdate> {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw Error('INVALID');
  if(Number(request.headers.get('content-length')??0)>65536)throw Error('INVALID');
  const reader=request.body?.getReader();if(!reader)throw Error('INVALID');
  let length=0;const chunks:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
    if(length>65536){await reader.cancel();throw Error('INVALID');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return telegramUpdateSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}
// Dependency injection keeps every normal Worker test offline.
export function createWorker(deps={
  ready:productionReady,tick:productionTick,processInbox:processInteractiveInbox,
  enqueue:async(config:ReturnType<typeof productionConfig>,userId:string,update:TelegramUpdate)=>{
    const connection=neonDatabase(config.runtimeUrl,'news_runtime');
    try{return await enqueueUpdate(connection.db,userId,config.telegram.botId,update);}finally{await connection.close();}
  },
},acknowledge=acknowledgeNewsUpdate) {
  return {
    async fetch(request:Request,env:ProductionEnv={},ctx?:{waitUntil(promise:Promise<unknown>):void}):Promise<Response> {
      const path=new URL(request.url).pathname;
      if(request.method==='GET'&&path==='/health')return Response.json({status:'ok',service:'news-ai-agent',liveIntegrations:false});
      if(request.method==='GET'&&path==='/ready') {
        if(!await secretMatches(request.headers.get('Authorization')?.replace(/^Bearer /,'')??null,env.PRODUCTION_HEALTH_SECRET))return new Response(null,{status:403});
        try{await deps.ready(env);return Response.json({status:'ready'});}catch(error){
          if(error instanceof BraveConfigError||error instanceof ScheduleConfigError)console.error(`PRODUCTION_READINESS_FIELDS: ${error.fields.filter(f=>/^[A-Z_]+$/.test(f)).join(',')}`);
          console.error('PRODUCTION_READINESS_FAILED');return Response.json({status:'not_ready'},{status:503});}
      }
      if(path!=='/telegram/webhook')return new Response(null,{status:404});
      if(request.method!=='POST')return new Response(null,{status:405});
      if(!await secretMatches(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.TELEGRAM_WEBHOOK_SECRET))return new Response(null,{status:403});
      let update:TelegramUpdate;
      try{update=await readUpdate(request);}catch{return new Response(null,{status:400});}
      try {
        const config=productionConfig(env),callback=update.callback_query,message=callback?.message??update.message,sender=callback?.from??message?.from;
        if(!sender||sender.is_bot||message?.chat.type!=='private'||message.chat.id!==sender.id)return new Response(null,{status:200});
        const userId=config.identities.get(String(sender.id));if(!userId)return new Response(null,{status:200});
        const inserted=await deps.enqueue(config,userId,update);
        // HTTP waitUntil is short-lived. The existing minute cron drains heavy
        // news work in a scheduled event; lightweight replies still run promptly.
        if(inserted&&isNewsUpdate(update)) {
          const status=acknowledge(config,update).catch(()=>{console.error('TELEGRAM_NEWS_ACK_FAILED');});
          if(ctx)ctx.waitUntil(status);else await status;
        } else if(inserted&&ctx)ctx.waitUntil(deps.processInbox(env,[userId],true));
        return new Response(null,{status:200});
      }catch{console.error('PRODUCTION_WEBHOOK_PERSIST_FAILED');return new Response(null,{status:503});}
    },
    async scheduled(event:{scheduledTime:number},env:ProductionEnv):Promise<void> {
      try{await deps.tick(env,new Date(event.scheduledTime));}
      catch{console.error('PRODUCTION_TICK_FAILED');throw Error('PRODUCTION_TICK_FAILED');}
    },
  };
}
export default createWorker();
