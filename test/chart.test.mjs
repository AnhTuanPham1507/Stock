import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const code=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function functionCode(name){
  const start=code.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.notEqual(start,-1,`Missing ${name}`);
  const end=code.indexOf('\n}',start);
  // Multiline functions in this dashboard close their outer scope at column zero.
  return code.slice(start,end+2);
}
function context(names,initial=''){
  const ctx=vm.createContext({console,Date,Map,Set,Math,Number});
  vm.runInContext(initial+'\n'+names.map(functionCode).join('\n'),ctx);
  return ctx;
}
function bars(n,sign=1){return Array.from({length:n},(_,i)=>({time:1800000000+i*60,open:100+i*sign,high:102+i*sign,low:99+i*sign,close:101+i*sign,volume:100}));}

test('Wilder ADX warms up for 2p-1 bars and reaches 100 on an uninterrupted trend',()=>{
  const ctx=context(['swiftADXCalculate']);
  for(const sign of [1,-1]){
    const values=ctx.swiftADXCalculate(bars(60,sign));
    assert.equal(values[26].adx,null);
    assert.equal(values[27].adx,100);
    assert.equal(values.at(-1).adx,100);
    assert.ok(sign>0?values.at(-1).plus>values.at(-1).minus:values.at(-1).minus>values.at(-1).plus);
  }
});
test('flat and insufficient candles do not produce NaN ADX',()=>{
  const ctx=context(['swiftADXCalculate']);
  assert.equal(ctx.swiftADXCalculate(bars(5)).every(r=>r.adx===null),true);
  const flat=bars(40).map(b=>({...b,open:100,high:100,low:100,close:100}));
  assert.equal(ctx.swiftADXCalculate(flat).at(-1).adx,0);
});
test('automatic DI crosses require ADX >=18 and exclude the forming candle',()=>{
  const ctx=context(['swiftUpdateAutoDICrosses'],'let swiftAutoDICrosses=[];');
  const input=[{plus:10,minus:20,adx:30},{plus:20,minus:10,adx:17},{plus:10,minus:20,adx:18},{plus:20,minus:10,adx:50}];
  ctx.swiftUpdateAutoDICrosses(bars(4),input);
  assert.equal(vm.runInContext('swiftAutoDICrosses.length',ctx),1);
  assert.equal(vm.runInContext('swiftAutoDICrosses[0].index',ctx),2);
  assert.equal(vm.runInContext('swiftAutoDICrosses[0].bullish',ctx),false);
});
test('candle scanner recognizes engulfing and rejects malformed OHLC',()=>{
  const ctx=context(['osCandlePatterns']);
  const rows=[{open:101,close:100,high:101.2,low:99.8},{open:99.9,close:101.2,high:101.4,low:99.7}];
  assert.ok(ctx.osCandlePatterns(rows,1).some(p=>p.name==='Bullish Engulfing'&&p.bias===1));
  assert.equal(ctx.osCandlePatterns([{open:102,close:100,high:101,low:99}],0).length,0);
});
test('Flow Force weights premium by absolute delta and resets rolling windows between sessions',()=>{
  const ctx=context(['buildFlowForceRows'],`let tvTimeframe=1,flowForceLen=2;let tvBars=[{time:60},{time:120},{time:180},{time:18060}];let flowForceLedger=new Map([[60,{bull:500,bear:0,live:500}],[120,{bull:0,bear:100,estimated:100}],[18060,{bull:0,bear:200,live:200}]]);`);
  const rows=ctx.buildFlowForceRows();
  assert.equal(rows.get(60).score,100);
  assert.ok(Math.abs(rows.get(120).score-66.6666666667)<1e-6);
  assert.equal(rows.get(180).score,-100);
  assert.equal(rows.get(18060).wBull,0);
  assert.equal(rows.get(18060).score,-100);
});
test('Flow Force does not invent delta or classify unclear trades',()=>{
  const ctx=context(['flowForceRecord'],`const CHART_WINDOW_MODE=false;let flowForceLedger=new Map(),flowForceVersion=0;function tapeTsMs(v){return Number(v);}function scheduleFlowForceRefresh(){}function scheduleFlowForcePersist(){}`);
  ctx.flowForceRecord(1800000000000,200000,undefined,'BULLISH');
  ctx.flowForceRecord(1800000000000,200000,.5,'UNCLEAR');
  assert.equal(vm.runInContext('flowForceLedger.size',ctx),0);
  ctx.flowForceRecord(1800000000000,200000,-.5,'BULLISH','live');
  assert.equal(vm.runInContext('[...flowForceLedger.values()][0].bull',ctx),100000);
  assert.equal(vm.runInContext('[...flowForceLedger.values()][0].live',ctx),100000);
});
test('candle lookup never bridges a session gap for a flow print',()=>{
  const ctx=context(['tapeTsMs','resolveFlowCandleEntry'],'let tvTimeframe=1,tvBars=[];');
  const start=1800000000,input=[{time:start},{time:start+60},{time:start+3000}];
  assert.equal(ctx.resolveFlowCandleEntry((start+30)*1000,input)?.bar.time,start);
  assert.equal(ctx.resolveFlowCandleEntry((start+1000)*1000,input),null);
});
test('SSE trade integration records one weighted force per unique valid print',()=>{
  const ctx=context(['handleMassiveTrade'],`
    let chain=[{details:{strike_price:562,contract_type:'call'},greeks:{delta:.5}}];
    let seenOptionTradeKeys=new Set(),seenOptionTradeQueue=[],tapePrints=[],tapeGroupedDirty=false,lastOptionTradeTs=0,massiveTradeCount=0;
    const TAPE_RAW_MAX=20000;let captures=[];
    function parseOCC(){return {expiration:'2026-10-28',strike:562,type:'call'};}
    function getSelectedExpiry(){return '2026-10-28';}
    function normalizeOptionWsTs(t){return t;}
    function classifyOrderPressure(sym,type,price,ts,conditions){return conditions.includes(201)?{skip:true}:{direction:'BULLISH',execution:'ASK BUY'};}
    function recordCandleContracts(){}
    function flowForceRecord(...args){captures.push(args);}
    function scheduleTapePersist(){}function scheduleChartFlowArchive(){}function addPressurePrint(){}function scheduleTapeRender(){}
  `);
  const trade={sym:'O:SPY261028C00562000',p:2.05,s:1200,q:1,t:1800000000000,c:[]};
  ctx.handleMassiveTrade(trade);ctx.handleMassiveTrade(trade);
  ctx.handleMassiveTrade({...trade,q:2,c:[201]});
  assert.equal(vm.runInContext('captures.length',ctx),1);
  assert.equal(vm.runInContext('captures[0][1]',ctx),246000);
  assert.equal(vm.runInContext('captures[0][2]',ctx),.5);
});
test('a standalone chart changes timeframe locally and rejects unsupported intervals',()=>{
  const ctx=context(['setChartTimeframe'],`
    const CHART_WINDOW_MODE=true,window={opener:null},document={querySelectorAll(){return [];}};
    let tvTimeframe=1,tvLoadedTf=1,loads=0,commands=0;
    function loadTradingChart(){loads++;}function sendChartWindowCommand(){commands++;}
  `);
  ctx.setChartTimeframe(5);
  assert.equal(vm.runInContext('tvTimeframe',ctx),5);
  assert.equal(vm.runInContext('loads',ctx),1);
  assert.equal(vm.runInContext('commands',ctx),0);
  ctx.setChartTimeframe(999);
  assert.equal(vm.runInContext('tvTimeframe',ctx),5);
});
test('the browser keeps a Stocks price when the option chain is unavailable',async()=>{
  const ctx=context(['fetchAll'],`
    const API_KEY='server-managed',MASSIVE_KEY='server-managed',DEMO_MODE=false,SIM_MODE=false;
    let chainRequestId=0,chain=[],spyPrevClose=null,seenPrice=null,renderCount=0,lastStatus='';
    const nodes=new Map();
    const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{style:{},textContent:''});return nodes.get(id);}};
    function getSelectedExpiry(){return '2030-01-04';}function updateExpiryNote(){}
    function setStatus(message){lastStatus=message;}function diffAndAccumulate(){throw Error('Must not accumulate an empty chain');}
    function applySpyPrice(price){seenPrice=price;}function renderAll(){renderCount++;}function showErr(message){throw Error(message);}
  `);
  ctx.URLSearchParams=URLSearchParams;
  ctx.fetch=async()=>({ok:true,json:async()=>({stock:{price:500,previousClose:499,source:'rest'},chain:[],optionsError:{status:403,message:'Not entitled'}})});
  await ctx.fetchAll();
  assert.equal(vm.runInContext('seenPrice',ctx),500);
  assert.equal(vm.runInContext('document.getElementById("mode-badge").textContent',ctx),'STOCKS ONLY');
  assert.match(vm.runInContext('document.getElementById("plan-box").textContent',ctx),/SPY candles/);
  assert.equal(vm.runInContext('renderCount',ctx),1);
});
test('the complete chart markup and CSP action allowlist ship together',()=>{
  for(const id of ['tv-main-chart','tv-volume-chart','swift-adx-canvas','swift-adx-resizer','swift-adx-bottom-resizer','tv-flow-storage-status','tv-sd-summary','tv-bfly-summary'])assert.ok(html.includes(`id="${id}"`),id);
  assert.doesNotMatch(html,/(?<!data-)\bon(?:click|change|input|keydown)\s*=/i);
  const allowlist=code.slice(code.indexOf('const UI_ACTIONS='),code.indexOf('function parseUiArgument'));
  const chart=html.slice(html.indexOf('<!-- ══ TRADING CHART TAB'));
  for(const match of chart.matchAll(/data-on\w+="([A-Za-z_$][\w$]*)\(/g))assert.ok(new RegExp(`\\b${match[1]}\\b`).test(allowlist),match[1]);
  assert.match(code,/if\(event\.origin!==location\.origin\)return;/);
  assert.doesNotMatch(code,/postMessage\([^\n]*,"\*"\)/);
});
