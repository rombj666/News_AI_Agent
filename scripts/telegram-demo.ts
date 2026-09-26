import { localDatabase } from './local-db.js';
import { createUser } from '../src/services/identity.js';
import { generateDigest } from '../src/digest/service.js';
import { createTelegramRouter } from '../src/adapters/telegram/router.js';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { FakeTelegram, telegramFixtureModel, messageUpdate, callbackUpdate } from '../tests/fixtures/telegram.js';
import { DIGEST_NOW,DIGEST_START,DIGEST_END,digestTestLimits,digestFixtureModel,seedDigestRankings } from '../tests/fixtures/digest.js';

const db=await localDatabase();
try {
  const telegramId=990002,userId=await createUser(db.owner,String(telegramId));
  const rankingId=await seedDigestRankings(db,userId);
  const digest=(await generateDigest(db.runtime,digestFixtureModel,{userId,operationId:crypto.randomUUID(),rankingOperationIds:[rankingId],
    periodStart:DIGEST_START,periodEnd:DIGEST_END},digestTestLimits,{},DIGEST_NOW)).digest!;
  const transport=new FakeTelegram();
  const api=new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz0123456789',async(url,init)=>{
    const body=JSON.parse(String(init.body));
    if(url.endsWith('/sendPhoto')&&body.photo.endsWith('image1.jpg'))return Response.json({ok:false,error_code:400},{status:400});
    if(url.endsWith('/answerCallbackQuery'))return Response.json({ok:true,result:true});
    console.log(url.endsWith('/sendPhoto')?'[MOCK PHOTO]':'[MOCK TEXT]');
    console.log(body.caption??body.text);
    if(body.reply_markup)console.log(body.reply_markup.inline_keyboard.flat().map((b:{text:string})=>b.text).join(' | '));
    const message_id=await transport.sendMessage(body.chat_id,{plain:body.caption??body.text,html:body.caption??body.text,buttons:body.reply_markup?.inline_keyboard});
    return Response.json({ok:true,result:{message_id}});
  },0,console.log);
  const handle=createTelegramRouter({db:db.runtime,botId:'123456',identities:new Map([[String(telegramId),userId]]),transport:api,
    ai:{model:telegramFixtureModel(),limits:digestTestLimits},now:()=>DIGEST_NOW});
  console.log('OFFLINE TELEGRAM DEMO: fake transport, fictional news and mock Luna. Actual provider cost $0.');
  await handle(messageUpdate(1,telegramId,'/start'));
  await handle(messageUpdate(2,telegramId,'/news'));
  await handle(messageUpdate(3,telegramId,'/preferences'));
  await handle(callbackUpdate(4,telegramId,`m:${digest.id}:1`));
  await handle(callbackUpdate(5,telegramId,`e:${digest.id}:1`));
  await handle(messageUpdate(6,telegramId,'Send my news at 8:30 AM'));
  const button=transport.sent.at(-1)!.message.buttons![0]![0]!;
  if('callback_data' in button)await handle(callbackUpdate(7,telegramId,button.callback_data));
  await handle(messageUpdate(8,telegramId,'/preferences'));
  console.log('\nSchedule saved only after Confirm. No network or real provider charges.');
} finally {await db.close();}
