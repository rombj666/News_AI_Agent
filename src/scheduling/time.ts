import { preferencesSchema, type Preferences } from '../domain/preferences.js';

export function localParts(now:Date,timezone:string) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=(type:string)=>parts.find(p=>p.type===type)!.value;
  return {date:`${get('year')}-${get('month')}-${get('day')}`,time:`${get('hour')}:${get('minute')}`};
}
const cache=new Map<string,number>();
export function occurrence(now:Date,raw:Preferences,manual=false) {
  const p=preferencesSchema.parse(raw);
  if(!Number.isFinite(+now)) throw new Error('INVALID_CLOCK');
  const local=localParts(now,p.timezone);
  if(manual) return {localDate:local.date,scheduledFor:now};
  if(!p.deliveryEnabled) return null;
  const key=`${local.date}|${p.timezone}|${p.deliveryTime}`;
  let instant=cache.get(key);
  if(instant===undefined) {
    // First matching instant resolves fall-back twice-occurring times once.
    // A spring gap runs at the first valid local minute after the requested time.
    const midnight=Date.parse(`${local.date}T00:00:00Z`);
    const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:p.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    for(let t=midnight-16*3600000;t<=midnight+40*3600000;t+=60000) {
      const parts=formatter.formatToParts(new Date(t));
      const get=(s:string)=>parts.find(x=>x.type===s)!.value;
      if(`${get('year')}-${get('month')}-${get('day')}`===local.date && `${get('hour')}:${get('minute')}`>=p.deliveryTime) {instant=t;break;}
    }
    if(instant===undefined) return null;
    if(cache.size>1000) cache.clear();cache.set(key,instant);
  }
  return +now>=instant?{localDate:local.date,scheduledFor:new Date(instant)}:null;
}
