// Read-only entitlement check. Prints status/counts, never API keys or market payloads.
import { loadEnvFile } from 'node:process';
import { loadConfig } from '../src/config.mjs';
import { MarketDataService } from '../src/massive.mjs';

try { loadEnvFile(new URL('../.env',import.meta.url)); }
catch(error) { if(error.code!=='ENOENT') throw error; }
const config=loadConfig();
const service=new MarketDataService(config);
const today=process.argv[2]||new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const previous=new Date(`${today}T12:00:00Z`);
do {previous.setUTCDate(previous.getUTCDate()-1);} while([0,6].includes(previous.getUTCDay()));
const prior=previous.toISOString().slice(0,10);
const redact=value=>{
  let message=String(value||'');
  for(const key of [config.stocksApiKey,config.optionsApiKey])if(key)message=message.split(key).join('[REDACTED]');
  return message.slice(0,300);
};
console.log(JSON.stringify({stocksKeyConfigured:Boolean(config.stocksApiKey),optionsKeyConfigured:Boolean(config.optionsApiKey),sameKey:Boolean(config.stocksApiKey)&&config.stocksApiKey===config.optionsApiKey,restHost:new URL(config.restBaseUrl).hostname,dateET:today}));
try {
  await fetch(`${config.restBaseUrl}/`,{signal:AbortSignal.timeout(config.upstreamTimeoutMs)});
} catch(error) {
  console.log(JSON.stringify({check:'transport',result:'error',code:error.cause?.code||error.code||error.name,message:redact(error.cause?.message||error.message)}));
  process.exit(1);
}
const checks=[
  ['stock_history',config.stocksApiKey,`/v2/aggs/ticker/SPY/range/1/minute/${prior}/${prior}?adjusted=true&sort=asc&limit=1000`],
  ['stock_today',config.stocksApiKey,`/v2/aggs/ticker/SPY/range/1/minute/${today}/${today}?adjusted=true&sort=asc&limit=1000`],
  ['stock_snapshot',config.stocksApiKey,'/v2/snapshot/locale/us/markets/stocks/tickers/SPY'],
  ['option_chain',config.optionsApiKey,`/v3/snapshot/options/SPY?expiration_date=${today}&limit=1`]
];
for(const [name,key,endpoint] of checks){
  if(!key){console.log(JSON.stringify({check:name,result:'missing-key'}));continue;}
  try{
    const payload=await service.requestJson(endpoint,key);
    console.log(JSON.stringify({check:name,result:'ok',providerStatus:payload.status,count:Array.isArray(payload.results)?payload.results.length:undefined,hasTicker:Boolean(payload.ticker),hasQuote:Boolean(payload.results?.[0]?.last_quote),hasTrade:Boolean(payload.results?.[0]?.last_trade)}));
  }catch(error){console.log(JSON.stringify({check:name,result:'error',status:error.status,message:redact(error.message)}));}
}
