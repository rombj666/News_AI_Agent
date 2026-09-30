import { z } from 'zod';
import { type Fetcher } from '../../retrieval/http.js';
import { TelegramError, type TelegramMessage, type TelegramPolling } from './types.js';
import { safeImageUrl } from '../../retrieval/images.js';
import { telegramReason,safeFailure } from './diagnostics.js';

const defaultFetcher:Fetcher=(url,init)=>globalThis.fetch(url,init);

export function abortableDelay(ms:number,signal:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted) {reject(new TelegramError('TELEGRAM_STOPPED'));return;}
    const stop=()=>{clearTimeout(timer);reject(new TelegramError('TELEGRAM_STOPPED'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);
    signal.addEventListener('abort',stop,{once:true});
  });
}
export class TelegramApi implements TelegramPolling {
  readonly #token:string;
  #lastSend=0;
  #sendQueue:Promise<unknown>=Promise.resolve();
  constructor(token:string,private readonly fetcher:Fetcher=defaultFetcher,private readonly spacingMs=1100,private readonly log:(code:string)=>void=()=>{}) {
    if(!/^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,200}$/.test(token)) throw new TelegramError('TELEGRAM_TOKEN_INVALID');
    this.#token=token;
  }
  private async call(
    method:'getMe'|'getWebhookInfo'|'getUpdates'|'sendMessage'|'sendPhoto'|'setMyCommands'|'answerCallbackQuery',
    body:unknown,
    signal?:AbortSignal,
  ):Promise<unknown> {
    // Cloudflare production sends intentionally use the same plain fetch shape as
    // the proven getMe egress probe. Long polling alone needs an abort signal.
    const timeoutSignal=method==='getUpdates'?AbortSignal.timeout(35000):null;
    const combined=method==='getUpdates'?(signal?AbortSignal.any([signal,timeoutSignal!]):timeoutSignal!):undefined;
    const detail=(status:number,contentType:string,bytes:number,category:string)=>
      this.log(`TELEGRAM_HTTP_DIAGNOSTIC: method=${method} status=${status} content_type=${contentType} bytes=${bytes} category=${category}`);
    const url=`https://api.telegram.org/bot${this.#token}/${method}`;
    let requestBody:string;
    try{requestBody=JSON.stringify(body);}
    catch{
      detail(0,'none',0,'REQUEST_SERIALIZATION_FAILED');
      throw new TelegramError('TELEGRAM_REQUEST_INVALID',null,'REQUEST_SERIALIZATION_FAILED');
    }
    const init:RequestInit={method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:requestBody,...(combined?{signal:combined}:{})};
    let response:Response;
    try {
      // Copying the function prevents a receiver-sensitive host fetch from being
      // invoked with TelegramApi as `this`.
      const fetcher=this.fetcher;
      response=await fetcher(url,init);
    } catch (error) {
      if(signal?.aborted)throw new TelegramError('TELEGRAM_STOPPED');
      if(timeoutSignal?.aborted){detail(0,'none',0,'TIMEOUT');throw new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR',null,'REQUEST_TIMEOUT');}
      const code=(error as {cause?:{code?:unknown};code?:unknown})?.cause?.code??(error as {code?:unknown})?.code;
      const reason=typeof code==='string'?({ENOTFOUND:'DNS_FAILED',EAI_AGAIN:'DNS_TEMPORARY_FAILURE',ECONNRESET:'CONNECTION_RESET',
        ECONNREFUSED:'CONNECTION_REFUSED',UND_ERR_CONNECT_TIMEOUT:'CONNECT_TIMEOUT',UND_ERR_SOCKET:'SOCKET_CLOSED'} as Record<string,string>)[code]:'NETWORK_FAILED';
      detail(0,'none',0,'FETCH_NETWORK_FAILURE');
      throw new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR',null,reason??'NETWORK_FAILED');
    }
    const status=response.status;
    const rawType=(response.headers.get('content-type')??'').toLowerCase();
    const contentType=/application\/(?:[a-z0-9.+-]*\+)?json\b/.test(rawType)?'json':rawType.startsWith('text/html')?'html':rawType?'other':'none';
    const declared=Number(response.headers.get('content-length')??0);
    if(Number.isFinite(declared)&&declared>2_000_000){await response.body?.cancel().catch(()=>{});detail(status,contentType,declared,'RESPONSE_TOO_LARGE');throw new TelegramError('TELEGRAM_RESPONSE_INVALID',null,'RESPONSE_TOO_LARGE');}
    let text:string;
    try{text=await response.text();}
    catch{detail(status,contentType,0,'RESPONSE_BODY_READ_FAILED');throw new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR',null,'RESPONSE_BODY_READ_FAILED');}
    const bytes=new TextEncoder().encode(text).byteLength;
    if(bytes>2_000_000){detail(status,contentType,bytes,'RESPONSE_TOO_LARGE');throw new TelegramError('TELEGRAM_RESPONSE_INVALID',null,'RESPONSE_TOO_LARGE');}
    let json:unknown;
    try{json=JSON.parse(text);}
    catch{detail(status,contentType,bytes,'NON_JSON_HTTP_RESPONSE');throw new TelegramError(status>=400?`TELEGRAM_HTTP_${status}`:'TELEGRAM_RESPONSE_INVALID',null,status>=400?telegramReason(null,status):'NON_JSON_HTTP_RESPONSE');}
    const errorEnvelope=z.object({ok:z.literal(false),error_code:z.number().int().min(100).max(599),description:z.string().optional(),
      parameters:z.object({retry_after:z.number().int().nonnegative().max(86400).optional()}).optional()}).safeParse(json);
    const successEnvelope=z.object({ok:z.literal(true),result:z.unknown()}).safeParse(json);
    if(!errorEnvelope.success&&!successEnvelope.success){detail(status,contentType,bytes,'TELEGRAM_ENVELOPE_INVALID');throw new TelegramError('TELEGRAM_RESPONSE_INVALID',null,'TELEGRAM_ENVELOPE_INVALID');}
    if(errorEnvelope.success){const envelope=errorEnvelope.data,retryMs=envelope.parameters?.retry_after===undefined?null:envelope.parameters.retry_after*1000;
      detail(status,contentType,bytes,'TELEGRAM_REJECTED');
      throw new TelegramError(status>=400?`TELEGRAM_HTTP_${status}`:`TELEGRAM_API_${envelope.error_code}`,retryMs,telegramReason(envelope.description,status>=400?status:envelope.error_code));}
    if(status>=400){detail(status,contentType,bytes,'HTTP_STATUS_WITH_SUCCESS_ENVELOPE');throw new TelegramError(`TELEGRAM_HTTP_${status}`,null,telegramReason(null,status));}
    if(successEnvelope.success){detail(status,contentType,bytes,'TELEGRAM_SUCCESS');return successEnvelope.data.result;}
    // Kept explicit for exhaustive control-flow analysis across Zod versions.
    throw new TelegramError('TELEGRAM_RESPONSE_INVALID',null,'TELEGRAM_ENVELOPE_INVALID');
  }
  async getUpdates(offset:number,signal:AbortSignal):Promise<unknown[]> {
    if(!Number.isSafeInteger(offset)||offset<0) throw new TelegramError('TELEGRAM_OFFSET_INVALID');
    const result=await this.call('getUpdates',{offset,timeout:25,limit:25,allowed_updates:['message','callback_query']},signal);
    if(!Array.isArray(result)||result.length>100) throw new TelegramError('TELEGRAM_RESPONSE_INVALID');
    return result;
  }
  async sendMessage(chatId:string,message:TelegramMessage,signal?:AbortSignal):Promise<number> {
    // Polling replies and scheduled sends share one paced queue, including fallbacks.
    const work=this.#sendQueue.then(()=>this.sendOne(chatId,message,signal));
    this.#sendQueue=work.catch(()=>{});
    return work;
  }
  private async pace(signal?:AbortSignal) {
    const pause=Math.max(0,this.#lastSend+this.spacingMs-Date.now());
    if(pause)await abortableDelay(pause,signal??new AbortController().signal);
    this.#lastSend=Date.now();
  }
  private async sendOne(chatId:string,message:TelegramMessage,signal?:AbortSignal):Promise<number> {
    try {return await this.sendPayload(chatId,message,signal);}
    catch(error){
      if(error instanceof TelegramError&&/^TELEGRAM_(MESSAGE_INVALID|CALLBACK_TOO_LONG|KEYBOARD_INVALID)$/.test(error.code))this.log(`TELEGRAM_SEND_VALIDATION_FAILED: ${safeFailure(error)}`);
      throw error;
    }
  }
  private async sendPayload(chatId:string,message:TelegramMessage,signal?:AbortSignal):Promise<number> {
    if(!/^[1-9]\d{0,15}$/.test(chatId)||!message.html.length||message.html.length>4096) throw new TelegramError('TELEGRAM_MESSAGE_INVALID');
    for(const row of message.buttons??[]) for(const button of row) {
      if('callback_data' in button && new TextEncoder().encode(button.callback_data).length>64) throw new TelegramError('TELEGRAM_CALLBACK_TOO_LONG');
    }
    await this.pace(signal);
    if(safeImageUrl(message.imageUrl)&&message.html.length<=1024) {
      try {
        const photo=await this.call('sendPhoto',{chat_id:chatId,photo:message.imageUrl,caption:message.html,parse_mode:'HTML',
          ...(message.buttons?{reply_markup:{inline_keyboard:message.buttons}}:{})},signal);
        const parsed=z.object({message_id:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).safeParse(photo);
        if(!parsed.success){this.log('TELEGRAM_RESULT_DIAGNOSTIC: method=sendPhoto category=RESULT_SHAPE_INVALID');throw new TelegramError('TELEGRAM_SEND_UNCERTAIN',null,'RESPONSE_MESSAGE_ID_INVALID');}
        return parsed.data.message_id;
      }catch(error){
        this.log(`TELEGRAM_SEND_PHOTO_FAILED: ${safeFailure(error)}`);
        // A definite 400 rejects the photo. A timeout may have sent it: never duplicate.
        if(!(error instanceof TelegramError)||!/^TELEGRAM_(HTTP|API)_(400|413|415|422)$/.test(error.code))throw error;
        this.log('TELEGRAM_IMAGE_REJECTED_TEXT_FALLBACK');
        await this.pace(signal);
      }
    }
    try {
      const result=await this.call('sendMessage',{chat_id:chatId,text:message.html,parse_mode:'HTML',link_preview_options:{is_disabled:true},
        ...(message.buttons?{reply_markup:{inline_keyboard:message.buttons}}:{})},signal);
      const parsed=z.object({message_id:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).safeParse(result);
      if(!parsed.success){this.log('TELEGRAM_RESULT_DIAGNOSTIC: method=sendMessage category=RESULT_SHAPE_INVALID');throw new TelegramError('TELEGRAM_SEND_UNCERTAIN',null,'RESPONSE_MESSAGE_ID_INVALID');}
      return parsed.data.message_id;
    }catch(error){this.log(`TELEGRAM_SEND_MESSAGE_FAILED: ${safeFailure(error)}`);throw error;}
  }
  async answerCallback(id:string,text:string,signal?:AbortSignal):Promise<void> {
    if(id.length>200||text.length>200) throw new TelegramError('TELEGRAM_CALLBACK_INVALID');
    await this.call('answerCallbackQuery',{callback_query_id:id,text},signal);
  }
  async setCommands(signal?:AbortSignal):Promise<void> {
    await this.call('setMyCommands',{commands:[{command:'start',description:'Help and examples'},{command:'news',description:'Fresh personalized news now'},
      {command:'latest',description:'Latest saved briefing'},{command:'schedule',description:'View or change daily delivery'},
      {command:'preferences',description:'View your settings'},{command:'help',description:'Help and examples'}]},signal);
  }
  async inspectConnection():Promise<{reachable:boolean;webhookConfigured:boolean;pendingUpdates:number}> {
    z.object({id:z.number().int().positive()}).parse(await this.call('getMe',{}));
    const webhook=z.object({url:z.string(),pending_update_count:z.number().int().nonnegative()}).parse(await this.call('getWebhookInfo',{}));
    return {reachable:true,webhookConfigured:!!webhook.url,pendingUpdates:webhook.pending_update_count};
  }
}
