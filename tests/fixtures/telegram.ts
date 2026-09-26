import type { TelegramDelivery, TelegramMessage } from '../../src/adapters/telegram/types.js';
import type { LanguageModel } from '../../src/domain/ports.js';
import { LUNA_MODEL } from '../../src/config/index.js';

export class FakeTelegram implements TelegramDelivery {
  sent:{chatId:string;message:TelegramMessage;id:number}[]=[];
  acknowledgements:{id:string;text:string}[]=[];
  failure:Error|null=null;
  async sendMessage(chatId:string,message:TelegramMessage) {
    if(this.failure) throw this.failure;
    const id=this.sent.length+100;
    this.sent.push({chatId,message,id});return id;
  }
  async answerCallback(id:string,text:string) {this.acknowledgements.push({id,text});}
}
export function telegramFixtureModel():LanguageModel&{calls:number;contexts:unknown[]} {
  return {model:LUNA_MODEL,calls:0,contexts:[],async generate(request) {
    this.calls++;
    const context=JSON.parse(request.context);this.contexts.push(context);
    let output:unknown;
    if('question' in context) output={answer:'Why this matters\nThis reported development may affect local planning and the people involved. The saved source establishes what happened, but does not establish the wider impact or who will benefit.\n\nWhat to watch\nFurther confirmed details would help clarify the practical effects.',
      evidence:[{articleId:context.sources[0].id,quote:context.sources[0].description}]};
    else if(/8:30/i.test(context.message))output={action:'delivery_time',key:null,priority:null,value:'08:30',scope:'permanent',clarification:null};
    else output=/football/i.test(context.message)?{action:'exclude_topic',key:'football',priority:null,value:null,scope:'permanent',clarification:null}
      :{action:'topic_priority',key:'AI',priority:5,value:null,scope:'permanent',clarification:null};
    return {text:JSON.stringify(output),usage:{inputTokens:100,cachedInputTokens:10,outputTokens:80},requestId:'resp_telegram_fixture'};
  }};
}
export function messageUpdate(id:number,sender:number,text:string,date=0) {
  return {update_id:id,message:{message_id:id,date,from:{id:sender,is_bot:false,username:'fixture_user'},chat:{id:sender,type:'private'},text}};
}
export function callbackUpdate(id:number,sender:number,data:string,callbackId=`callback_${id}`) {
  return {update_id:id,callback_query:{id:callbackId,from:{id:sender,is_bot:false},data,
    message:{message_id:100,date:0,chat:{id:sender,type:'private'}}}};
}
