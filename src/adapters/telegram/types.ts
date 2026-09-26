import { z } from 'zod';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sender = z.object({id:integer.min(1),is_bot:z.boolean(),username:z.string().max(64).optional()});
const message = z.object({message_id:integer, date:integer,
  from:sender.optional(),chat:z.object({id:z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),type:z.string()}),
  text:z.string().max(20000).optional(),reply_to_message:z.object({message_id:integer}).optional()});
export const telegramUpdateSchema = z.object({update_id:integer,message:message.optional(),
  callback_query:z.object({id:z.string().min(1).max(200),from:sender,message:message.optional(),data:z.string().max(256).optional()}).optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramButton = {text:string;url:string} | {text:string;callback_data:string};
export interface TelegramMessage {
  imageUrl?:string;
  html:string; plain:string; buttons?:TelegramButton[][]; digestId?:string; storyPosition?:number;
}
export interface TelegramDelivery {
  sendMessage(chatId:string,message:TelegramMessage,signal?:AbortSignal):Promise<number>;
  answerCallback(id:string,text:string,signal?:AbortSignal):Promise<void>;
}
export interface TelegramPolling extends TelegramDelivery {
  getUpdates(offset:number,signal:AbortSignal):Promise<unknown[]>;
}
export class TelegramError extends Error {
  constructor(public readonly code:string,public readonly retryAfterMs:number|null=null,public readonly reason:string|null=null) {super(code);}
}
