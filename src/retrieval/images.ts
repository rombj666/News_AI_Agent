import { publicHttpsUrl } from './http.js';
// Only source-supplied metadata. No page scraping, binary download or proxy.
export function safeImageUrl(value:unknown):string|null {
  if(typeof value!=='string'||value.length>2048) return null;
  try {
    const url=publicHttpsUrl(value);
    if([...url.searchParams.keys()].some(k=>/token|secret|password|credential|signature|api.?key/i.test(k)))return null;
    if(/\.(svg|gif|webp|avif)(?:$)/i.test(url.pathname))return null;
    url.hash='';return url.href;
  }catch{return null;}
}
