export type TelegramEgressCategory='SUCCESS'|'DNS_FAILURE'|'CONNECTION_RESET'|'CONNECTION_TIMEOUT'|
  'NETWORK_CONNECTION_LOST'|'FETCH_FAILED'|'CLOUDFLARE_SUBREQUEST_BLOCKED'|'UNKNOWN_NETWORK_FAILURE';
export type TelegramEgressResult={reached:boolean;status:number;contentType:'json'|'html'|'other'|'none';bytes:number;category:TelegramEgressCategory};

function contentType(value:string|null):TelegramEgressResult['contentType'] {
  const type=(value??'').toLowerCase();
  if(/application\/(?:[a-z0-9.+-]*\+)?json\b/.test(type))return 'json';
  if(type.startsWith('text/html'))return 'html';
  return type?'other':'none';
}
function networkCategory(error:unknown):TelegramEgressCategory {
  const known=(error as {cause?:{code?:unknown};code?:unknown})?.cause?.code??(error as {code?:unknown})?.code;
  if(known==='ENOTFOUND'||known==='EAI_AGAIN')return 'DNS_FAILURE';
  if(known==='ECONNRESET'||known==='UND_ERR_SOCKET')return 'CONNECTION_RESET';
  if(known==='ETIMEDOUT'||known==='UND_ERR_CONNECT_TIMEOUT')return 'CONNECTION_TIMEOUT';
  const name=error instanceof Error?error.name:'';
  const message=error instanceof Error?error.message:''; // classified only; never returned or logged
  if(name==='TimeoutError'||name==='AbortError')return 'CONNECTION_TIMEOUT';
  if(/network connection lost/i.test(message))return 'NETWORK_CONNECTION_LOST';
  if(/too many subrequests|subrequest.*(?:blocked|not allowed)|not allowed to access/i.test(message))return 'CLOUDFLARE_SUBREQUEST_BLOCKED';
  if(/fetch failed|failed to fetch/i.test(message))return 'FETCH_FAILED';
  return 'UNKNOWN_NETWORK_FAILURE';
}

// Deliberately independent of TelegramApi, databases, routing and scheduling.
export async function telegramEgress(token:string,fetcher:typeof fetch=fetch):Promise<TelegramEgressResult> {
  if(!/^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,200}$/.test(token))return {reached:false,status:0,contentType:'none',bytes:0,category:'UNKNOWN_NETWORK_FAILURE'};
  try {
    const response=await fetcher(`https://api.telegram.org/bot${token}/getMe`,{method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},body:'{}'});
    const declared=Number(response.headers.get('content-length')??0);
    let bytes=Number.isFinite(declared)&&declared>=0?declared:0;
    try{bytes=(await response.arrayBuffer()).byteLength;}catch{/* egress was still reached */}
    return {reached:true,status:response.status,contentType:contentType(response.headers.get('content-type')),bytes,category:'SUCCESS'};
  }catch(error){return {reached:false,status:0,contentType:'none',bytes:0,category:networkCategory(error)};}
}
