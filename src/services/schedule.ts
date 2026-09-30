import type { Database } from '../db/database.js';
import type { Preferences } from '../domain/preferences.js';
import { readPreferences,proposePreferences } from './preferences.js';

export function parseDeliveryTime(raw:string):string|null {
  const value=raw.trim();
  const twelve=/^(\d{1,2})(?::([0-5]\d))?\s*(AM|PM)$/i.exec(value);
  if(twelve) {
    const hour=Number(twelve[1]);if(hour<1||hour>12)return null;
    return `${String(hour%12+(twelve[3]!.toUpperCase()==='PM'?12:0)).padStart(2,'0')}:${twelve[2]??'00'}`;
  }
  const twentyFour=/^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
  return twentyFour?`${twentyFour[1]!.padStart(2,'0')}:${twentyFour[2]}`:null;
}
export function displayTime(time:string) {
  const [hour,minute]=time.split(':');return `${Number(hour)%12||12}:${minute} ${Number(hour)<12?'AM':'PM'}`;
}
export function scheduleSummary(p:Preferences) {
  return `Daily briefing schedule\n\nStatus: ${p.deliveryEnabled?'Enabled':'Disabled'}\nTime: ${displayTime(p.deliveryTime)}\nTimezone: ${p.timezone}\n\n/schedule 08:30\n/schedule 8:30 PM\n/schedule on\n/schedule off`;
}
export async function proposeSchedule(db:Database,userId:string,value:string,now:Date) {
  const profile=await readPreferences(db,userId),next=structuredClone(profile.document);
  const enabled=/^(on|off)$/i.test(value)?value.toLowerCase()==='on':null;
  const time=parseDeliveryTime(value);
  if(enabled===null&&!time)return null;
  const preview=enabled===null?`Delivery time: ${next.deliveryTime} → ${time}`
    :`Delivery: ${next.deliveryEnabled?'Enabled':'Disabled'} → ${enabled?'Enabled':'Disabled'}`;
  if(enabled!==null)next.deliveryEnabled=enabled;
  else next.deliveryTime=time!;
  const proposal=await proposePreferences(db,userId,next,{now:()=>now},profile.version);
  return {kind:'proposal' as const,proposalId:proposal.id,text:`Proposed permanent change\n\n${preview}\n\nConfirm to save, or Cancel. Expires in 15 minutes.`};
}
