// Never store a client-supplied text report: accept only bounded numbers/enums.
const pick = (value, choices) => choices.includes(value) ? value : "unknown";
function sample(input) {
  const h = input && typeof input === "object" ? input : {};
  const out = {};
  for (const [key,max] of Object.entries({at:9e12,viewer:10000,width:8192,height:8192,
    sourceWidth:8192,sourceHeight:8192,fps:240,mbps:200,targetBitrate:200_000_000})) {
    if (Number.isFinite(h[key]) && h[key]>=0 && h[key]<=max) out[key]=h[key];
  }
  out.codec=pick(String(h.codec || '').toUpperCase(),['H264','VP8','VP9','AV1','H265']);
  out.limit=pick(h.limit,['none','cpu','bandwidth','other']);
  out.route=pick(h.route,['direct UDP','direct TCP','relay UDP','relay TCP','relay TLS']);
  out.encoder=h.encoder==='libvpx' ? 'libvpx' : h.encoder==='platform' || /^(MediaCodec|OMX\.|c2\.)/i.test(String(h.encoder || '')) ? 'platform' : 'unknown';
  return out;
}
export function cleanPictureReport(body) {
  if (!body || !Array.isArray(body.history) || !Array.isArray(body.viewers)) return null;
  return {version:/^1\.0\.\d{1,6}$/.test(body.version) ? body.version : 'web',
    quality:pick(body.quality,['Auto 1080p','Smooth 720p','HD 1080p','4K Ultra HD']),
    viewers:body.viewers.slice(0,8).map(sample),history:body.history.slice(-120).map(sample)};
}
export async function readPictureBody(request) {
  const reader=request.body?.getReader();
  if (!reader) return null;
  const chunks=[]; let size=0;
  while(true) {
    const {done,value}=await reader.read(); if(done) break;
    size+=value.byteLength;
    if(size>65536) {await reader.cancel(); return null;}
    chunks.push(value);
  }
  const all=new Uint8Array(size); let offset=0;
  for(const chunk of chunks) {all.set(chunk,offset);offset+=chunk.byteLength;}
  try {return cleanPictureReport(JSON.parse(new TextDecoder().decode(all)));} catch {return null;}
}
