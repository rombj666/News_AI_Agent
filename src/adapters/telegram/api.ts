import { z } from 'zod';
import { fetchText, RetrievalError, type Fetcher } from '../../retrieval/http.js';
import { TelegramError, type TelegramMessage, type TelegramPolling } from './types.js';
import { safeImageUrl } from '../../retrieval/images.js';
import { telegramReason,safeFailure } from './diagnostics.js';

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
  constructor(token:string,private readonly fetcher:Fetcher=fetch,private readonly spacingMs=1100,private readonly log:(code:string)=>void=()=>{}) {
    if(!/^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,200}$/.test(token)) throw new TelegramError('TELEGRAM_TOKEN_INVALID');
    this.#token=token;
  }
  private async call(method:'getMe'|'getWebhookInfo'|'getUpdates'|'sendMessage'|'sendPhoto'|'setMyCommands'|'answerCallbackQuery',body:unknown,signal?:AbortSignal):Promise<unknown> {
    const combined=AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(method==='getUpdates'?35000:15000)]);
    let httpStatus=200;
    let networkReason:string|null=null;
    try {
      // Read bounded error JSON only to obtain Telegram's numeric retry delay.
      // Neither descriptions nor the token-bearing URL escape this boundary.
      const response=await fetchText(async(url,init)=>{
        let raw:Response;
        try {raw=await this.fetcher(url,init);}catch(error){
          const code=(error as {cause?:{code?:unknown};code?:unknown})?.cause?.code??(error as {code?:unknown})?.code;
          networkReason=typeof code==='string'?({ENOTFOUND:'DNS_FAILED',EAI_AGAIN:'DNS_TEMPORARY_FAILURE',ECONNRESET:'CONNECTION_RESET',ECONNREFUSED:'CONNECTION_REFUSED',UND_ERR_CONNECT_TIMEOUT:'CONNECT_TIMEOUT',UND_ERR_SOCKET:'SOCKET_CLOSED'} as Record<string,string>)[code]??null:null;
          throw error;
        }
        httpStatus=raw.status;
        return raw.ok?raw:new Response(raw.body,{status:200,headers:raw.headers});
        },`https://api.telegram.org/bot${this.#token}/${method}`,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(body)
        },combined,2_000_000);      
        const envelope=z.object({ok:z.boolean(),result:z.unknown().optional(),error_code:z.number().int().optional(),description:z.string().optional(),
        parameters:z.object({retry_after:z.number().int().nonnegative().max(86400).optional()}).optional()}).parse(JSON.parse(response.text));
      const retryMs=envelope.parameters?.retry_after===undefined?null:envelope.parameters.retry_after*1000;
      if(httpStatus>=400) throw new TelegramError(`TELEGRAM_HTTP_${httpStatus}`,retryMs,telegramReason(envelope.description,httpStatus));
      if(!envelope.ok) throw new TelegramError(`TELEGRAM_API_${envelope.error_code??0}`,retryMs,telegramReason(envelope.description,envelope.error_code??0));
      return envelope.result;
    } catch(error) {
      if(error instanceof TelegramError) throw error;
      if(httpStatus>=400) throw new TelegramError(`TELEGRAM_HTTP_${httpStatus}`,null,telegramReason(null,httpStatus));
      if(error instanceof RetrievalError && /^HTTP_\d{3}$/.test(error.code)) throw new TelegramError(`TELEGRAM_${error.code}`);
      throw new TelegramError(signal?.aborted?'TELEGRAM_STOPPED':'TELEGRAM_NETWORK_OR_RESPONSE_ERROR',null,
        combined.aborted?'REQUEST_TIMEOUT':networkReason??(error instanceof RetrievalError?'NETWORK_OR_ENCODING_ERROR':'RESPONSE_INVALID'));
    }
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
        if(!parsed.success)throw new TelegramError('TELEGRAM_SEND_UNCERTAIN');
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
      if(!parsed.success) throw new TelegramError('TELEGRAM_SEND_UNCERTAIN',null,'RESPONSE_MESSAGE_ID_INVALID');
      return parsed.data.message_id;
    }catch(error){this.log(`TELEGRAM_SEND_MESSAGE_FAILED: ${safeFailure(error)}`);throw error;}
  }
  async answerCallback(id:string,text:string,signal?:AbortSignal):Promise<void> {
    if(id.length>200||text.length>200) throw new TelegramError('TELEGRAM_CALLBACK_INVALID');
    await this.call('answerCallbackQuery',{callback_query_id:id,text},signal);
  }
  async setCommands(signal?:AbortSignal):Promise<void> {
    await this.call('setMyCommands',{commands:[{command:'start',description:'Your setup and examples'},{command:'news',description:'Latest saved briefing'},{command:'preferences',description:'View your settings'}]},signal);
  }
  async inspectConnection():Promise<{reachable:boolean;webhookConfigured:boolean;pendingUpdates:number}> {
    z.object({id:z.number().int().positive()}).parse(await this.call('getMe',{}));
    const webhook=z.object({url:z.string(),pending_update_count:z.number().int().nonnegative()}).parse(await this.call('getWebhookInfo',{}));
    return {reachable:true,webhookConfigured:!!webhook.url,pendingUpdates:webhook.pending_update_count};
  }
}

