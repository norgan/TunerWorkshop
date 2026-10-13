export function allowExternalLink(value) {
  if(value==='ms-settings:bluetooth')return true;
  try {
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.port)return false;
    return url.hostname==='auth.openai.com'||url.hostname==='auth0.openai.com'||url.hostname==='chatgpt.com'&&url.pathname==='/settings/usage';
  }catch{return false;}
}
export function isLocalPage(value,origin) {
  try{const url=new URL(value);return url.origin===origin&&['/','/index.html'].includes(url.pathname);}catch{return false;}
}
