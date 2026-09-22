import { z } from 'zod';
import { LUNA_MODEL } from '../config/index.js';
import type { LanguageModel } from '../domain/ports.js';
import { fetchText, RetrievalError, type Fetcher } from '../retrieval/http.js';
type Reply = Awaited<ReturnType<LanguageModel['generate']>>;
export class ModelError extends Error {
  constructor(public readonly code:string, public readonly reply:Reply|null=null) { super(code); }
}
const usageSchema=z.object({input_tokens:z.number().int().nonnegative().max(272000),output_tokens:z.number().int().nonnegative().max(128000),
  input_tokens_details:z.object({cached_tokens:z.number().int().nonnegative()}).optional()});
export class OpenAIResponses implements LanguageModel {
  readonly model=LUNA_MODEL;
  readonly #key:string;
  constructor(env:Record<string,string|undefined>, private readonly fetcher:Fetcher=fetch) {
    if(!env.OPENAI_API_KEY?.trim()) throw new ModelError('OPENAI_KEY_MISSING');
    if(env.OPENAI_MODEL && env.OPENAI_MODEL!==LUNA_MODEL) throw new ModelError('MODEL_NOT_ALLOWED');
    this.#key=env.OPENAI_API_KEY.trim();
  }
  async generate(request:Parameters<LanguageModel['generate']>[0]):Promise<Reply> {
    if(!request.responseSchema || !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens<128 || request.maxOutputTokens>16000) throw new ModelError('MODEL_REQUEST_INVALID');
    let data:Record<string,unknown>;
    try {
      const response=await fetchText(this.fetcher,'https://api.openai.com/v1/responses',{
        method:'POST',headers:{Authorization:`Bearer ${this.#key}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:this.model,instructions:request.instructions,input:request.context,
          max_output_tokens:request.maxOutputTokens,store:false,tools:[],reasoning:{effort:'none'},
          text:{format:{type:'json_schema',name:'news_ranking',strict:true,schema:request.responseSchema}}}),
      },request.signal,1_000_000);
      data=JSON.parse(response.text) as Record<string,unknown>;
      if(!data || typeof data!=='object') throw new ModelError('MODEL_RESPONSE_INVALID');
    } catch(error) {
      if(error instanceof ModelError) throw error;
      const code=error instanceof RetrievalError && /^HTTP_\d{3}$/.test(error.code) ? `OPENAI_${error.code}`
        :request.signal.aborted?'MODEL_TIMEOUT':'MODEL_NETWORK_OR_RESPONSE_ERROR';
      throw new ModelError(code);
    }
    const parsed=usageSchema.safeParse(data.usage);
    let usage:Reply['usage']=null;
    if(parsed.success) {
      const u=parsed.data,cached=u.input_tokens_details?.cached_tokens??null;
      if(cached===null || cached<=u.input_tokens) usage={inputTokens:u.input_tokens,outputTokens:u.output_tokens,cachedInputTokens:cached};
    }
    const requestId=typeof data.id==='string' && /^resp_[a-zA-Z0-9_-]{1,190}$/.test(data.id)?data.id:null;
    const reply:Reply={text:'',usage,requestId};
    if(data.model!==this.model) throw new ModelError('MODEL_RESPONSE_MISMATCH',reply);
    if(data.status!=='completed') throw new ModelError('MODEL_INCOMPLETE',reply);
    const output=z.array(z.object({type:z.string(),content:z.array(z.object({type:z.string(),text:z.string().optional()})).optional()})).safeParse(data.output);
    if(!output.success) throw new ModelError('MODEL_RESPONSE_INVALID',reply);
    const content=output.data.flatMap(item=>item.content??[]);
    if(content.some(item=>item.type==='refusal')) throw new ModelError('MODEL_REFUSAL',reply);
    reply.text=content.filter(item=>item.type==='output_text').map(item=>item.text??'').join('');
    return reply;
  }
}
