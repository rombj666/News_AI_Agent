import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telegramEgress } from '../src/production/telegram-egress.js';
import { createWorker } from '../src/entrypoints/worker.js';

const token='123456:abcdefghijklmnopqrstuvwxyz0123456789',secret='s'.repeat(32);
test('minimal egress probe uses only getMe and returns sanitized response metadata',async()=>{
  let url='',init:RequestInit|undefined;
  const result=await telegramEgress(token,async(input,options)=>{url=String(input);init=options;return new Response('{"ok":true,"result":{"username":"private"}}',
    {status:200,headers:{'content-type':'application/json; charset=utf-8'}});});
  assert.equal(url,`https://api.telegram.org/bot${token}/getMe`);
  assert.deepEqual({method:init?.method,body:init?.body,headers:init?.headers},{method:'POST',body:'{}',headers:{'Content-Type':'application/json','Accept':'application/json'}});
  assert.deepEqual(result,{reached:true,status:200,contentType:'json',bytes:43,category:'SUCCESS'});
  assert.ok(!JSON.stringify(result).includes(token));assert.ok(!JSON.stringify(result).includes('private'));
});

test('minimal egress classifier covers safe Cloudflare and network categories without leaking exceptions',async()=>{
  const errors=[
    [Object.assign(new Error('private'),{cause:{code:'ENOTFOUND'}}),'DNS_FAILURE'],
    [Object.assign(new Error('private'),{cause:{code:'ECONNRESET'}}),'CONNECTION_RESET'],
    [Object.assign(new Error('private'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}}),'CONNECTION_TIMEOUT'],
    [new Error('Network connection lost.'),'NETWORK_CONNECTION_LOST'],
    [new TypeError('Failed to fetch private URL'),'FETCH_FAILED'],
    [new Error('Too many subrequests for private URL'),'CLOUDFLARE_SUBREQUEST_BLOCKED'],
    [new Error('private unknown detail'),'UNKNOWN_NETWORK_FAILURE'],
  ] as const;
  for(const [error,category] of errors){
    const result=await telegramEgress(token,async()=>{throw error;});
    assert.deepEqual(result,{reached:false,status:0,contentType:'none',bytes:0,category});
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('protected fetch diagnostic calls only egress and scheduled diagnostic bypasses production tick',async()=>{
  let egress=0,ticks=0,ready=0,enqueues=0;
  const worker=createWorker({
    egress:async()=>{egress++;return {reached:false,status:0,contentType:'none' as const,bytes:0,category:'FETCH_FAILED' as const};},
    tick:async()=>{ticks++;},ready:async()=>{ready++;},enqueue:async()=>{enqueues++;},
  });
  const env={PRODUCTION_HEALTH_SECRET:secret,TELEGRAM_BOT_TOKEN:token,TELEGRAM_EGRESS_DIAGNOSTIC:'YES'};
  assert.equal((await worker.fetch(new Request('https://worker.test/diagnostics/telegram-egress',{method:'POST'}),env)).status,403);
  const response=await worker.fetch(new Request('https://worker.test/diagnostics/telegram-egress',{method:'POST',headers:{Authorization:`Bearer ${secret}`}}),env);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{reached:false,status:0,contentType:'none',bytes:0,category:'FETCH_FAILED'});
  await worker.scheduled({scheduledTime:0},env);
  assert.equal(egress,2);assert.equal(ticks,0);assert.equal(ready,0);assert.equal(enqueues,0);
});

test('scheduled diagnostics are opt-in and normal scheduled path remains intact when disabled',async()=>{
  let egress=0,ticks=0;
  const worker=createWorker({egress:async()=>{egress++;return {reached:true,status:200,contentType:'json' as const,bytes:1,category:'SUCCESS' as const};},
    tick:async()=>{ticks++;},ready:async()=>{},enqueue:async()=>{}});
  await worker.scheduled({scheduledTime:123},{TELEGRAM_EGRESS_DIAGNOSTIC:'NO'});
  assert.equal(egress,0);assert.equal(ticks,1);
});
