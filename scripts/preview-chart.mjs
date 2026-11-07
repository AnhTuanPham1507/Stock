// Deterministic local preview. No provider keys or external data requests are used.
import fs from 'node:fs';
import http from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { AuthService, createSecurityHeaders } from '../src/security.mjs';
import { createRequestHandler } from '../src/app.mjs';
import { SseHub } from '../src/sse-hub.mjs';

const config=loadConfig({NODE_ENV:'development',FLOW_AUTH_MODE:'none'});
const hub=new SseHub(config);
const nowMinute=Math.floor(Date.now()/60000)*60000;
const results=Array.from({length:480},(_,i)=>{
  const o=562+Math.sin(i/12)*1.8+Math.sin(i/3)*.28+i*.001;
  const c=562+Math.sin((i+1)/12)*1.8+Math.sin((i+1)/3)*.28+(i+1)*.001;
  return {t:nowMinute-(479-i)*60000,o,c,h:Math.max(o,c)+.12,l:Math.min(o,c)-.12,v:12000+(i%17)*1700,vw:(o+c)/2};
});
const price=results.at(-1).c;
function chain(expiry){
  return Array.from({length:42},(_,i)=>{
    const type=i%2?'put':'call',strike=552+Math.floor(i/2),sign=type==='call'?1:-1;
    return {details:{ticker:`O:SPY${expiry.slice(2).replaceAll('-','')}${type==='call'?'C':'P'}${String(strike*1000).padStart(8,'0')}`,contract_type:type,strike_price:strike,expiration_date:expiry},
      day:{volume:1000+(i%7)*350,change:2,change_percent:1.2},open_interest:1500+(i%9)*750,
      greeks:{delta:sign*.5,gamma:.05,theta:-.04,vega:.12},implied_volatility:.2,
      last_trade:{price:2.05,size:1000,sip_timestamp:Date.now()*1e6},last_quote:{bid:1.95,ask:2.05,midpoint:2,last_updated:Date.now()*1e6}};
  });
}
const market={getBootstrap:async expiry=>({schemaVersion:1,expiry,stock:{price,previousClose:price-.5,source:'demo',timestamp:Date.now()},chain:chain(expiry)}),getCandles:async()=>({results})};
const provider={status:{stocks:'demo',options:'demo'},syncSubscriptions(){}};
const handle=createRequestHandler({config,auth:new AuthService(config),market,provider,hub});
const server=http.createServer((request,response)=>{
  const pathname=new URL(request.url,'http://localhost').pathname;
  if(pathname==='/'||pathname==='/index.html'){
    const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8').replace('<body>','<body><div role="status" style="padding:8px;text-align:center;color:#fbbf24;background:#291d0b;font:700 12px monospace">CHART PREVIEW · SYNTHETIC DATA · NO LIVE MARKET CONNECTION</div>');
    response.writeHead(200,createSecurityHeaders(config,'text/html; charset=utf-8'));
    response.end(html);return;
  }
  return handle(request,response);
});
let sequence=0;
const timer=setInterval(()=>{
  hub.publish('stock_tick',{price:price+Math.sin(sequence/8)*.03,timestamp:Date.now(),source:'demo'});
  for(const {expiry} of hub.getSubscriptions()){
    const contract=chain(expiry)[20],sym=contract.details.ticker,t=Date.now();
    hub.publish('option_quote_batch',[{sym,bp:1.95,ap:2.05,t}],{expiry});
    hub.publish('option_trade',{sym,p:2.05,s:1200,q:++sequence,t,x:1,c:[]},{expiry});
  }
},1000);
const port=Number(process.env.CHART_PREVIEW_PORT)||4318;
server.listen(port,'127.0.0.1',()=>console.log(`Synthetic chart preview: http://127.0.0.1:${port}`));
process.on('SIGINT',()=>{clearInterval(timer);server.close();process.exit(0);});
