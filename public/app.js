
// ─── state ────────────────────────────────────────────────────────────────────
const pageParams = new URLSearchParams(location.search);
const CHART_WINDOW_MODE = pageParams.get("chartWindow")==="1";
const DEMO_MODE = pageParams.get("demo")==="1";
const dataKey = name => DEMO_MODE ? "demo:" + name : name;
const EXPIRY_STORAGE_KEY = dataKey("spyflow_selected_expiry");
const SERVER_MANAGED_FEED = true;
// Provider credentials are owned by Node and never enter the browser.
try{
  localStorage.removeItem("poly_key_spyflow");
  localStorage.removeItem("massive_opt_key");
  localStorage.removeItem("spyflow_key_bundle_version");
}catch(_){}
let API_KEY = "server-managed";
let MASSIVE_KEY = "server-managed";

// Inline event attributes were converted to inert data attributes so CSP can
// block injected scripts. Only this explicit function allowlist can run.
const UI_ACTIONS={
  showGate,tryConnect,toggleDemoMode,changeExpiration,setScenario,setSimSpeed,
  switchTab,openPremiumWindow,openChartWindow,toggleAR,fetchAll,
  setPressurePremiumFilter,setCt,setSrt,setTapeViewMode,setTapePremium,
  setTapePremiumCustom,setTapeStatusFilter,setWsRange,toggleWsDebug,clearTape,
  clearWsDebug,changeTapePage,goToLatestTapePage,setGexRatioInterval,
  setChartTimeframe,setChartMode,toggleChartStudy,setStudyColor,
  setChartFlowMinPremium,setCustomDrawTool,toggleCustomDrawLine,
  toggleCustomTrendExtension,toggleCustomMagnet,eraseSelectedDrawing,
  clearCustomDrawings,fitTradingChart,loadTradingChart,focusChartWindow,
  closeChartWindow,toggleSwiftADX,toggleSwiftAutoDILines,toggleSwiftDISnap,
  toggleHammerPatterns,toggleSupplyDemand,toggleButterfly,setButterflyScale,
  setFlowForceLength,setFlowMarkGap,enableTradingChartLiveFollow,setChartBackground
};

function parseUiArgument(token,element){
  const value=token.trim();
  if(value==="this")return element;
  if(value==="this.value")return element.value;
  if(value==="true")return true;
  if(value==="false")return false;
  if(/^[-+]?\d+(?:\.\d+)?$/.test(value))return Number(value);
  const quoted=/^'([^']*)'$/.exec(value);if(quoted)return quoted[1];
  throw new Error("Unsupported UI action argument");
}

function runUiAction(code,element,event){
  if(code==="if(event.key==='Enter')tryConnect()"){
    if(event.key==="Enter")tryConnect();
    return;
  }
  for(const statement of String(code||"").split(";").map(v=>v.trim()).filter(Boolean)){
    const match=/^([A-Za-z_$][\w$]*)\((.*)\)$/.exec(statement);
    if(!match||!Object.hasOwn(UI_ACTIONS,match[1]))continue;
    const args=match[2].trim()?match[2].split(",").map(value=>parseUiArgument(value,element)):[];
    UI_ACTIONS[match[1]](...args);
  }
}

function bindUiActions(){
  document.addEventListener("click",event=>{
    const element=event.target.closest?.("[data-onclick]");
    if(element)runUiAction(element.dataset.onclick,element,event);
  });
  for(const type of ["change","input","keydown"]){
    document.addEventListener(type,event=>{
      const element=event.target.closest?.(`[data-on${type}]`);
      if(element)runUiAction(element.dataset[`on${type}`],element,event);
    });
  }
}
bindUiActions();
let spyPrice  = null, spyPrevClose = null, chain = [];
let chainRequestId = 0;
let spyWS = null, wsAlive = false, wsReconnTimer = null;
let spyNbbo = {bid:null,ask:null,ts:0};
let spyOutlierCandidate = null;
let rejectedSpyTicks = 0;
let chartReconcileTimer = null;
// ── massive.com options WS state
let massiveWS = null, massiveAlive = false, massiveReconnTimer = null;
let massiveSubs = new Set();        // currently-subscribed OCC tickers (no "T." prefix)
let massiveTradeCount = 0;          // lifetime trade counter for status
let massiveQuoteCount = 0;          // lifetime live option quote counter
let tapeRenderTimer = null;         // debounce for streaming renders
let wsRangeDollars = +(localStorage.getItem("ws_range_dollars") ?? 10);  // 0 = no filter
let wsDebugOn = false;              // debug panel toggle
let wsDebugLog = [];                // last 20 frames for debug view
let ctFilter  = "all", sortField = "time";
let tapePremiumMin = +(localStorage.getItem("tape_premium_min") || 0);
let tapeViewMode = localStorage.getItem("tape_view_mode") || "grouped";
const TAPE_RAW_MAX = 20000;
const TAPE_PERSIST_MAX = 6000;
const TAPE_RETENTION_MS = 30 * 60 * 1000;
const TAPE_CLEANUP_INTERVAL_MS = 5000;
const TAPE_STORE_KEY_PREFIX = dataKey("options_swift_flow_tape_v2");
let tapeStatusFilter = localStorage.getItem("tape_status_filter") || "all";
if(tapeStatusFilter==="archived") tapeStatusFilter="all";
let tapePersistTimer = null;
let tapeRetentionTimer = null;
const TAPE_RENDER_MAX = 200;
let tapePage = 0; // 0 = newest page; older pages remain accessible without rendering the whole session
const TAPE_GROUP_REBUILD_MS = 750;
const CANDLE_FLOW_MIN_PREMIUM = 200000;
const FLOW_MARK_PREMIUM_LEVELS = new Set([200000,300000,400000,500000]);
let chartFlowMinPremium = +(localStorage.getItem("options_swift_chart_flow_min")||200000);
if(!FLOW_MARK_PREMIUM_LEVELS.has(chartFlowMinPremium))chartFlowMinPremium=200000;
const CHART_FLOW_DB_NAME = dataKey("options-swift-chart-flow-v1");
const CHART_FLOW_DB_STORE = "orders";
const CHART_FLOW_FALLBACK_KEY = dataKey("options_swift_chart_flow_history_v1");
const CHART_FLOW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CHART_FLOW_RETENTION_LABEL = "30-day persistent history";
const CHART_FLOW_MAX = 5000;
let chartFlowVersion=0,flowVolumeCache=null,flowVolumeCacheVersion=-1,flowVolumeCacheMinPrem=-1;
let tapeGroupedCache = [];
let tapeGroupedCacheAt = 0;
let tapeGroupedDirty = true;
let tapeRecoveredArchiveCount = 0;
const TAPE_SPLIT_PRINT_WINDOW_MS = 125;
const TAPE_SWEEP_WINDOW_MS = 500;
const TAPE_CLUSTER_WINDOW_MS = 5000;
let autoRef   = true, arTimer = null;
let chartSpy  = null, chartStrike = null, chartGexRatio = null;
let gexRatioHistory = [];
let gexRatioHistoryExpiry = "";
const GEX_RATIO_INTERVAL_OPTIONS = [60000,180000,300000,900000];
const GEX_RATIO_DEFAULT_BUCKET_MS = 60000;
let GEX_RATIO_BUCKET_MS = (()=>{
  try{
    const saved=+localStorage.getItem("options_swift_gex_ratio_interval_ms");
    return GEX_RATIO_INTERVAL_OPTIONS.includes(saved) ? saved : GEX_RATIO_DEFAULT_BUCKET_MS;
  }catch(_){ return GEX_RATIO_DEFAULT_BUCKET_MS; }
})();
const GEX_RATIO_MAX_POINTS = 240;
let strikeChartSignature = "", strikeChartNeedsPaint = false;
let tvChart=null,tvVolumeChart=null,tvCandles=null,tvVolume=null,tvFlowVolume=null,tvVwap=null,tvEma7=null,tvEma9=null,tvEma21=null,tvEma200=null,tvBbUpper=null,tvBbMiddle=null,tvBbLower=null;
let tvBars=[],tvDisplayBars=[],tvTimeframe=1,tvLoadedTf=null,tvLoading=false,tvResizeObserver=null,tvPriceLines=[];
let tvFlowLabelFrame=null;
let tvCandleContractTotals=new Map(); // displayed timeframe buckets: ALL option contracts, independent of Flow Marks premium filter
const CANDLE_CONTRACT_STORE_PREFIX=dataKey("options_swift_candle_contracts_v2");
const CANDLE_CONTRACT_RETENTION_MS=60*60*1000; // compact all-print contract ledger retained for 60 minutes
let candleContractMinuteTotals=new Map(); // 1-minute epoch seconds -> {callContracts,putContracts,prints}
let candleContractPersistTimer=null;
let chartFlowOrders=[],chartFlowDbPromise=null,chartFlowArchiveTimer=null,chartFlowArchiveLoaded=false;
let chartExternalWindow=null,chartWindowSyncTimer=null,chartWindowCloseTimer=null;
let chartFlowChannel=null,chartFlowBroadcastTimer=null,chartFlowBroadcastSig="",lastOpenerFlowSyncAt=0;
let chartWindowTickTimer=null,chartWindowPendingPrice=null,chartWindowPendingTime=null,chartWindowFlowSyncTimer=null,chartWindowFlowSignature="";
let tvChartMode=localStorage.getItem("options_swift_chart_mode")==="heikin"?"heikin":"candles";
let tvChartTheme=localStorage.getItem("options_swift_chart_background")==="white"?"white":"dark";
let liveWallLevels={callPremium:null,putPremium:null,callPressure:null,putPressure:null,callGex:null,putGex:null};
let gammaFlipState={price:null,netAtSpot:null,regime:"unavailable",distance:null,updatedAt:0,source:"gamma × OI"};
const tvStudies={vwap:true,ema7:true,ema9:true,ema21:true,ema200:true,bb:true,levels:true,flow:true,profile:localStorage.getItem("options_swift_volume_profile")!=="0",flowForce:localStorage.getItem("options_swift_flow_force")!=="0"};
// ── FLOW FORCE · premium × |delta| weighted bullish/bearish pressure ─────────
const FLOW_FORCE_LENGTHS=[1,5,10,15,20,30]; // 1 = per candle (each bar on its own)
const FLOW_FORCE_STORE_PREFIX=dataKey("options_swift_flow_force_v1");
const FLOW_FORCE_KEEP_SEC=6*24*3600;
let flowForceLen=(()=>{try{const v=+localStorage.getItem("options_swift_flow_force_len");return FLOW_FORCE_LENGTHS.includes(v)?v:1;}catch(_){return 1;}})();
let flowForceLedger=new Map(); // minute -> {bull,bear} weighted dollars where force = premium × |delta|
let flowForceVersion=0,flowForceRefreshTimer=null,flowForcePersistTimer=null;
let tvFlowForce={map:new Map(),len:flowForceLen,hasData:false}; // bar time -> {bull,bear,wBull,wBear,share}
const tvColors={vwap:"#38bdf8",ema7:"#84cc16",ema9:"#facc15",ema21:"#a78bfa",ema200:"#f97316",bb:"#22d3ee"};
let tapePrints = [];   // accumulated intraday prints [{ts,side,strike,price,size,prem,iv,delta,isNew}]
let pressurePrints = []; // individual WS prints enriched with live NBBO direction
let pressurePrintIds = new Set();
let optionQuoteMap = new Map(); // OCC ticker → latest live NBBO
let seenOptionTradeKeys = new Set(); // distinct WS prints, including same-millisecond executions
let seenOptionTradeQueue = [];
let lastOptionTradeTs=0;
let prevSnaps  = {};   // keyed by strike_type → last seen sip_timestamp
let isFirstLoad = true;
const PRESSURE_FILTER_LEVELS = new Set([0,75000,100000,150000,200000,300000,400000,500000]);
let pressureMinPremium = +(localStorage.getItem("spy_pressure_min_premium") ?? 100000);
if(!PRESSURE_FILTER_LEVELS.has(pressureMinPremium)) pressureMinPremium = 100000;
const PRESSURE_WINDOW_MS = 30 * 60 * 1000;
const PRESSURE_RETENTION_MS = 35 * 60 * 1000;
const PRESSURE_MEMORY_MAX = 20000;
const PRESSURE_STORE_MAX = 2500;
const PRESSURE_RENDER_MAX = 200;
const PRESSURE_STORE_KEY_PREFIX = dataKey("spy_pressure_prints_v5");
const PRESSURE_CHANNEL_NAME = dataKey("spy-flow-pressure-v4");
const pressureInstanceId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
let pressurePersistTimer = null;
let pressureQuoteRenderTimer = null;
let pressureChannel = null;
const CANCELED_OPTION_CONDITIONS = new Set([201,203,205,207]);
const LATE_OPTION_CONDITIONS = new Set([202,204,206,208]);
const MULTILEG_OPTION_CONDITIONS = new Set([232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247]);

// ─── formatters ───────────────────────────────────────────────────────────────
const fD  = v => v==null?"—":v>=1e6?`$${(v/1e6).toFixed(2)}M`:v>=1e3?`$${(v/1e3).toFixed(1)}K`:`$${Number(v).toFixed(2)}`;
const fN  = v => v==null?"—":v>=1e6?`${(v/1e6).toFixed(1)}M`:v>=1e3?`${(v/1e3).toFixed(0)}K`:String(v);
const fP  = v => `${(v*100).toFixed(1)}%`;
const fNS = v => v>=1e6?`${(v/1e6).toFixed(2)}M`:v>=1e3?`${(v/1e3).toFixed(1)}K`:v.toFixed(0);
const rowP= c => (c.last_trade?.price??c.last_quote?.midpoint??0)*(c.day?.volume??0)*100;

// All visible timestamps use the New York market clock. Incoming and restored
// records may be Unix seconds, milliseconds, microseconds, or nanoseconds, so
// convert through tapeTsMs() before formatting or comparing them.
const MARKET_TIME_ZONE = "America/New_York";
function marketZoneName(date=new Date()){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:MARKET_TIME_ZONE,timeZoneName:"short"}).formatToParts(date);
  return parts.find(p=>p.type==="timeZoneName")?.value || "ET";
}
function formatMarketTime(date, includeZone=false, includeSeconds=true){
  const opts={timeZone:MARKET_TIME_ZONE,hour12:false,hour:"2-digit",minute:"2-digit"};
  if(includeSeconds) opts.second="2-digit";
  const value=new Intl.DateTimeFormat("en-US",opts).format(date);
  return includeZone ? `${value} ${marketZoneName(date)}` : value;
}
function chartTimeDate(time){
  if(typeof time==="number") return new Date(time*1000);
  if(time && typeof time==="object" && "year" in time) return new Date(Date.UTC(time.year,(time.month||1)-1,time.day||1));
  return new Date(time);
}
function formatChartHoverTime(time){
  const date=chartTimeDate(time);
  const day=new Intl.DateTimeFormat("en-US",{timeZone:MARKET_TIME_ZONE,month:"2-digit",day:"2-digit",year:"numeric"}).format(date);
  return `${day} ${formatMarketTime(date,false,false)} ${marketZoneName(date)}`;
}
function marketDateKey(value=Date.now()){
  const date=value instanceof Date?value:new Date(tapeTsMs(value));
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:MARKET_TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// Every visible market timestamp is normalized to New York time (EDT/EST automatically).
const fT = ts => {const ms=tapeTsMs(ts);return ms?formatMarketTime(new Date(ms)):"——:——:——";};
const fTET = ts => {const ms=tapeTsMs(ts);return ms?`${formatMarketTime(new Date(ms))} ${marketZoneName(new Date(ms))}`:"—";};
const fTS = ts => tapeTsMs(ts);

function pressureFilterLabel(value=pressureMinPremium){
  return value===0 ? "ALL PRINTS" : `≥ $${value/1000}K`;
}

function setPressurePremiumFilter(value,broadcast=true){
  const next = +value;
  if(!PRESSURE_FILTER_LEVELS.has(next)) return;
  pressureMinPremium = next;
  localStorage.setItem("spy_pressure_min_premium",String(next));
  const select = document.getElementById("pressure-premium-filter");
  if(select && +select.value!==next) select.value=String(next);
  const title = document.getElementById("pressure-title");
  if(title) title.textContent = `INDIVIDUAL ORDER PRESSURE (${pressureFilterLabel(next)})`;
  renderPressureTape();
  if(broadcast && pressureChannel){
    try { pressureChannel.postMessage({type:"filter",source:pressureInstanceId,value:next}); } catch(_){}
  }
}

function normalizePressureRecord(raw){
  if(!raw || typeof raw!=="object") return null;
  const ts=tapeTsMs(raw.ts),price=+raw.price,size=+raw.size,prem=+raw.prem,strike=+raw.strike;
  if(!Number.isFinite(ts)||!Number.isFinite(price)||!Number.isFinite(size)||!Number.isFinite(prem)||!Number.isFinite(strike)) return null;
  if(ts<=0||price<=0||size<=0||prem<0) return null;
  const expiration=isValidExpiry(raw.expiration)?raw.expiration:getSelectedExpiry();
  const side=raw.side==="call"?"call":raw.side==="put"?"put":null;
  if(!side) return null;
  const direction=["BULLISH","BEARISH","UNCLEAR"].includes(raw.direction)?raw.direction:"UNCLEAR";
  const allowedExec=["ASK BUY","BID SELL","MID / UNCLEAR","MULTI-LEG","LATE PRINT","NO NBBO","STALE NBBO"];
  const allowedQuality=["LIVE NBBO","ISO","MULTI-LEG","LATE","NO LIVE NBBO","STALE QUOTE"];
  const execution=allowedExec.includes(raw.execution)?raw.execution:"MID / UNCLEAR";
  const quality=allowedQuality.includes(raw.quality)?raw.quality:"NO LIVE NBBO";
  const bid=raw.bid==null?null:+raw.bid;
  const ask=raw.ask==null?null:+raw.ask;
  const conditions=Array.isArray(raw.conditions)?raw.conditions.map(Number).filter(Number.isFinite).slice(0,8):[];
  const id=String(raw.id||`${side}:${strike}:${ts}:${price}:${size}`).slice(0,180);
  const sym=typeof raw.sym==="string"?raw.sym.slice(0,80):"";
  return {
    id,sym,ts,expiration,side,strike,price,size,prem,direction,execution,quality,
    bid:Number.isFinite(bid)?bid:null,
    ask:Number.isFinite(ask)?ask:null,
    conditions
  };
}

function prunePressurePrints(){
  const cutoff=Date.now()-PRESSURE_RETENTION_MS;
  pressurePrints=pressurePrints
    .filter(p=>fTS(p.ts)>=cutoff)
    .sort((a,b)=>b.ts-a.ts)
    .slice(0,PRESSURE_MEMORY_MAX);
  pressurePrintIds=new Set(pressurePrints.map(p=>p.id));
}

function schedulePressurePersist(){
  if(pressurePersistTimer) return;
  pressurePersistTimer=setTimeout(()=>{
    pressurePersistTimer=null;
    persistPressurePrints();
  },1500);
}

function persistPressurePrints(expiry=getSelectedExpiry()){
  try{
    prunePressurePrints();
    localStorage.setItem(pressureStoreKey(expiry),JSON.stringify(pressurePrints.slice(0,PRESSURE_STORE_MAX)));
    const bg=document.getElementById("pressure-bg-status");
    if(bg){bg.textContent="● BACKGROUND BUFFER ON";bg.style.color="var(--green)";}
  }catch(_){
    const bg=document.getElementById("pressure-bg-status");
    if(bg){bg.textContent="● BUFFER STORAGE FULL";bg.style.color="var(--amber)";}
  }
}

function addPressurePrint(raw,{broadcast=false,persist=true}={}){
  const p=normalizePressureRecord(raw);
  if(!p || p.expiration!==getSelectedExpiry() || pressurePrintIds.has(p.id)) return false;
  pressurePrintIds.add(p.id);
  pressurePrints.unshift(p);
  if(pressurePrints.length>PRESSURE_MEMORY_MAX || fTS(pressurePrints.at(-1)?.ts)<Date.now()-PRESSURE_RETENTION_MS) prunePressurePrints();
  if(persist) schedulePressurePersist();
  if(broadcast && pressureChannel){
    try { pressureChannel.postMessage({type:"print",source:pressureInstanceId,record:p}); } catch(_){}
  }
  return true;
}

function loadPressurePrints(serialized=null){
  try{
    const raw=JSON.parse(serialized??localStorage.getItem(pressureStoreKey())??"[]");
    if(!Array.isArray(raw)) return;
    raw.forEach(p=>addPressurePrint(p,{broadcast:false,persist:false}));
    prunePressurePrints();
  }catch(_){}
}

function clearPressureState(broadcast=true){
  const expiration=getSelectedExpiry();
  pressurePrints=[];pressurePrintIds.clear();
  try { localStorage.removeItem(pressureStoreKey(expiration)); } catch(_){}
  if(broadcast && pressureChannel){
    try { pressureChannel.postMessage({type:"clear",source:pressureInstanceId,expiration}); } catch(_){}
  }
  renderPressureTape(true);
}

function resumePressureFlow(){
  loadPressurePrints();
  setPressurePremiumFilter(pressureMinPremium,false);
  renderPressureTape(true);
  if(MASSIVE_KEY){
    if(!massiveWS || massiveWS.readyState>=2) connectMassiveWS();
    else if(massiveAlive) syncMassiveSubs();
  }
}

function initPressureContinuity(){
  const select=document.getElementById("pressure-premium-filter");
  if(select) select.value=String(pressureMinPremium);
  loadPressurePrints();
  setPressurePremiumFilter(pressureMinPremium,false);

  if("BroadcastChannel" in globalThis){
    try{
      pressureChannel=new BroadcastChannel(PRESSURE_CHANNEL_NAME);
      pressureChannel.onmessage=e=>{
        const m=e.data||{};
        if(m.source===pressureInstanceId) return;
        if(m.type==="print" && addPressurePrint(m.record,{broadcast:false,persist:true}) && !document.hidden) renderPressureTape();
        if(m.type==="clear" && (!m.expiration || m.expiration===getSelectedExpiry())) clearPressureState(false);
        if(m.type==="filter") setPressurePremiumFilter(m.value,false);
      };
    }catch(_){pressureChannel=null;}
  }

  window.addEventListener("storage",e=>{
    if(e.key===pressureStoreKey()){
      if(e.newValue) loadPressurePrints(e.newValue);
      else clearPressureState(false);
      if(!document.hidden) renderPressureTape();
    }
    if(e.key==="spy_pressure_min_premium" && e.newValue!=null) setPressurePremiumFilter(+e.newValue,false);
  });
  document.addEventListener("visibilitychange",()=>{
    if(!document.hidden) resumePressureFlow();
  });
  window.addEventListener("focus",resumePressureFlow);
  window.addEventListener("pageshow",resumePressureFlow);
  window.addEventListener("pagehide",()=>persistPressurePrints());
}

// ─── tape accumulator ─────────────────────────────────────────────────────────
function diffAndAccumulate(contracts){
  const today = marketDateKey();
  let newCount = 0;
  // clear isNew flags on existing prints
  tapePrints.forEach(p=>p.isNew=false);

  contracts.forEach(c=>{
    const det = c.details||{};
    const lt  = c.last_trade;
    if(!lt?.sip_timestamp || !det.strike_price || !det.contract_type) return;
    const key = `${det.strike_price}_${det.contract_type}`;
    const prevTs = prevSnaps[key];
    if(prevTs === lt.sip_timestamp) return; // no new trade on this contract
    prevSnaps[key] = lt.sip_timestamp;
    if(isFirstLoad) return; // don't flood tape on first load

    // verify trade is from today
    const tradeMs = tapeTsMs(lt.sip_timestamp);
    const tradeDate = marketDateKey(tradeMs);
    if(tradeDate !== today) return;

    const price = lt.price ?? 0;
    const size  = lt.size  ?? 1;
    const prem  = price * size * 100;
    // Snapshot latest trades are an estimate, used only while the SSE options feed is stale.
    const quote=c.last_quote||{},bid=Number(quote.bid??quote.bid_price),ask=Number(quote.ask??quote.ask_price);
    let direction="UNCLEAR",execution="MID / UNCLEAR";
    if(bid>0&&ask>=bid){
      const pos=(price-bid)/Math.max(.01,ask-bid);
      if(pos>=.65){execution="ASK BUY";direction=det.contract_type==="call"?"BULLISH":"BEARISH";}
      else if(pos<=.35){execution="BID SELL";direction=det.contract_type==="call"?"BEARISH":"BULLISH";}
    }
    if(Date.now()-lastOptionTradeTs>=15000){
      recordCandleContracts(tradeMs,det.contract_type,size,prem);
      flowForceRecord(tradeMs,prem,c.greeks?.delta,direction,"estimated");
    }
    tapePrints.unshift({
      ts:    tradeMs,
      side:  det.contract_type,
      strike:det.strike_price,
      price, size, prem,
      iv:    c.implied_volatility,
      delta: c.greeks?.delta,
      sym:det.ticker||"",direction,execution,source:"rest-estimated",
      isNew: true
    });
    newCount++;
  });

  isFirstLoad = false;
  // cap at 400, keep newest first
  tapePrints = tapePrints.sort((a,b)=>tapeTsMs(b.ts)-tapeTsMs(a.ts)).slice(0,TAPE_RAW_MAX);
  if(newCount){scheduleTapePersist();scheduleChartFlowArchive();}
  return newCount;
}

function clearTape(){
  tapePrints=[];tapeGroupedCache=[];tapeGroupedCacheAt=0;tapeGroupedDirty=true;seenOptionTradeKeys.clear();seenOptionTradeQueue=[];prevSnaps={};isFirstLoad=true;
  const cutoff=Date.now()-TAPE_RETENTION_MS,expiry=getSelectedExpiry();
  chartFlowOrders=chartFlowOrders.filter(order=>order.expiration!==expiry||Number(order.ts)<cutoff);
  tapeRecoveredArchiveCount=0;
  try{localStorage.removeItem(tapeStoreKey());}catch(_){}
  clearPressureState(true);
  scheduleChartFlowArchive();
  const tapeMode=document.getElementById("tape-view-mode"); if(tapeMode) tapeMode.value=tapeViewMode;
  renderFlowTape();
  if(document.getElementById("tc-chart")?.classList.contains("on")) scheduleFlowCandleLabels();
}

// ─── tape row renderer ────────────────────────────────────────────────────────

function tapeStoreKey(expiry=getSelectedExpiry()){ return `${TAPE_STORE_KEY_PREFIX}:${expiry}`; }
function pruneTapePrints(now=Date.now()){
  const cutoff=now-TAPE_RETENTION_MS;
  const before=tapePrints.length;
  tapePrints=tapePrints.filter(p=>tapeTsMs(p?.ts)>=cutoff).slice(0,TAPE_RAW_MAX);
  const removed=before-tapePrints.length;
  if(removed>0){
    tapeGroupedCache=[];
    tapeGroupedCacheAt=0;
    tapeGroupedDirty=true;
  }
  return removed;
}
function expireFlowTape(render=true){
  const removed=pruneTapePrints();
  if(!removed) return 0;
  persistTape();
  if(render&&document.getElementById("tc-flow")?.classList.contains("on")){
    renderFlowTape();
  }else{
    const count=document.getElementById("rct");
    if(count) count.textContent=`${tapePrints.length} prints · rolling 30 min`;
  }
  if(document.getElementById("tc-chart")?.classList.contains("on")) scheduleFlowCandleLabels();
  return removed;
}
function startTapeRetentionWatch(){
  clearInterval(tapeRetentionTimer);
  expireFlowTape(true);
  tapeRetentionTimer=setInterval(()=>expireFlowTape(true),TAPE_CLEANUP_INTERVAL_MS);
}
function scheduleTapePersist(){
  if(tapePersistTimer) return;
  tapePersistTimer=setTimeout(()=>{tapePersistTimer=null;persistTape();},750);
}
function persistTape(expiry=getSelectedExpiry()){
  try{
    pruneTapePrints();
    const keep=tapePrints.slice(0,TAPE_PERSIST_MAX).map(p=>({...p,ts:tapeTsMs(p.ts),firstMs:p.firstMs==null?p.firstMs:tapeTsMs(p.firstMs),isNew:false}));
    localStorage.setItem(tapeStoreKey(expiry),JSON.stringify({savedAt:Date.now(),prints:keep}));
  }catch(e){ console.warn("Flow tape persistence skipped",e); }
}
function normalizeTapeRecord(raw){
  if(!raw||typeof raw!=="object")return null;
  const ts=tapeTsMs(raw.ts),strike=Number(raw.strike),price=Number(raw.price),size=Number(raw.size),prem=Number(raw.prem);
  if(!Number.isFinite(ts)||!Number.isFinite(strike)||!Number.isFinite(price)||!Number.isFinite(size)||!Number.isFinite(prem))return null;
  if(ts<=0||strike<=0||price<=0||size<=0||prem<0||!['call','put'].includes(raw.side))return null;
  const sym=typeof raw.sym==="string"&&/^O:SPY\d{6}[CP]\d{8}$/.test(raw.sym)?raw.sym:"";
  const executions=new Set(["ASK BUY","BID SELL","MULTI-LEG","LATE PRINT","NO NBBO","STALE NBBO","MID / UNCLEAR","MID/UNCLEAR"]);
  const directions=new Set(["BULLISH","BEARISH","UNCLEAR"]);
  return {
    sym,ts,side:raw.side,strike,price,size,prem,
    iv:Number.isFinite(Number(raw.iv))?Number(raw.iv):null,
    delta:Number.isFinite(Number(raw.delta))?Number(raw.delta):null,
    conditions:Array.isArray(raw.conditions)?raw.conditions.slice(0,32).map(Number).filter(Number.isFinite):[],
    execution:executions.has(raw.execution)?raw.execution:"MID / UNCLEAR",
    direction:directions.has(raw.direction)?raw.direction:"UNCLEAR",
    bid:Number.isFinite(Number(raw.bid))?Number(raw.bid):null,
    ask:Number.isFinite(Number(raw.ask))?Number(raw.ask):null,
    exchange:Number.isFinite(Number(raw.exchange))?Number(raw.exchange):null,
    source:raw.source==="ws"?"ws":"snapshot",
    isNew:false
  };
}

function loadTape(){
  try{
    const raw=localStorage.getItem(tapeStoreKey());
    if(!raw) return;
    const parsed=JSON.parse(raw);
    const prints=(Array.isArray(parsed?.prints)?parsed.prints:[]).map(normalizeTapeRecord).filter(Boolean);
    const cutoff=Date.now()-TAPE_RETENTION_MS;
    tapePrints=prints.filter(p=>tapeTsMs(p?.ts)>=cutoff).slice(0,TAPE_RAW_MAX);
    tapeGroupedDirty=true; tapeGroupedCacheAt=0;
    scheduleChartFlowArchive();
    if(document.getElementById("tc-chart")?.classList.contains("on")) scheduleFlowCandleLabels();
  }catch(e){ console.warn("Unable to restore flow tape",e); }
}
function setTapeStatusFilter(value){
  resetTapePage();
  tapeStatusFilter=["all","active","winner","loser","stale","possible_exit"].includes(value)?value:"all";
  localStorage.setItem("tape_status_filter",tapeStatusFilter);
  renderFlowTape();
}
function classifyTapeStatus(order, allOrders){
  const live=tapeEstimatedPnL(order);
  const laterOpposite=allOrders.some(other=>{
    if(other===order) return false;
    const ot=tapeTsMs(other.ts), tt=tapeTsMs(order.ts);
    if(ot<=tt || ot-tt>2*60*60*1000) return false;
    if(other.side!==order.side || Number(other.strike)!==Number(order.strike)) return false;
    if(!order.execution || !other.execution || order.execution===other.execution) return false;
    const ratio=Number(other.size||0)/Math.max(1,Number(order.size||0));
    return ratio>=0.5 && ratio<=1.5;
  });
  if(laterOpposite) return {key:"possible_exit",label:"POSSIBLE EXIT",color:"#fbbf24"};
  if(live.mark!=null && live.stale) return {key:"stale",label:"STALE QUOTE",color:"#fbbf24"};
  if(live.pnl>0) return {key:"winner",label:"WINNER",color:"#34d399"};
  if(live.pnl<0) return {key:"loser",label:"LOSER",color:"#f87171"};
  return {key:"active",label:"ACTIVE",color:"#60a5fa"};
}

function institutionalScore(order, contextOrders=[], liveOverride=null){
  const prem=Math.max(0,Number(order.prem||0));
  const size=Math.max(0,Number(order.size||0));
  const prints=Math.max(1,Number(order.printCount||1));
  const execution=String(order.execution||"");
  const quality=String(order.quality||"").toUpperCase();
  const live=liveOverride||tapeEstimatedPnL(order);
  let score=25;

  // Capital commitment: 0–25 points, saturating near $1M.
  if(prem>0){
    const scaled=(Math.log10(Math.max(10000,prem))-4)/(6-4);
    score+=Math.max(0,Math.min(1,scaled))*25;
  }
  // Contract size: 0–12 points, saturating near 1,000 contracts.
  score+=Math.max(0,Math.min(1,size/1000))*12;
  // Aggressive NBBO execution is stronger evidence than midpoint/unclear prints.
  if(execution==="ASK BUY"||execution==="BID SELL") score+=16;
  else if(execution.includes("BUY")||execution.includes("SELL")) score+=8;
  else score-=8;
  // Repeated/sweep-style prints add persistence evidence.
  score+=Math.min(10,Math.max(0,prints-1)*2.5);
  if(/SWEEP|SPLIT/.test(String(order.orderType||""))) score+=5;
  if(order.delta!=null && Number.isFinite(Number(order.delta))) score+=Math.min(5,Math.abs(Number(order.delta))*7);

  // Same-contract continuation and opposing flow within two hours.
  const tt=tapeTsMs(order.ts);
  let samePremium=0, oppositePremium=0;
  for(const other of contextOrders||[]){
    if(other===order || other.side!==order.side || Number(other.strike)!==Number(order.strike)) continue;
    const ot=tapeTsMs(other.ts);
    if(ot<=tt || ot-tt>2*60*60*1000) continue;
    if(!execution || !other.execution) continue;
    if(other.execution===execution) samePremium+=Number(other.prem||0);
    else if(other.execution!=="UNCLEAR") oppositePremium+=Number(other.prem||0);
  }
  if(samePremium>0) score+=Math.min(8,8*samePremium/Math.max(prem,samePremium));
  if(oppositePremium>0) score-=Math.min(22,22*oppositePremium/Math.max(prem,oppositePremium));

  if(live?.stale) score-=10;
  if(quality.includes("MULTI")||quality.includes("UNCLEAR")||quality.includes("LATE")) score-=10;
  if(live?.pct!=null && live.pct<-0.35) score-=6;
  if(live?.pct!=null && live.pct>0.25) score+=4;

  score=Math.round(Math.max(0,Math.min(100,score)));
  const label=score>=80?"HIGH":score>=60?"SOLID":score>=40?"MIXED":"LOW";
  const color=score>=80?"#34d399":score>=60?"#60a5fa":score>=40?"#fbbf24":"#f87171";
  return {score,label,color,samePremium,oppositePremium};
}

function institutionalScoreHtml(result){
  return `<span title="Flow-confidence estimate only — not proof that an institution opened or still holds the position" style="color:${result.color};font-size:9px;font-weight:900">${result.score}%</span>`;
}

function tapeExecutionDetails(p,live){
  const raw=String(p.execution||"").toUpperCase();
  const execution=raw==="ASK BUY"?"ASK BUY":raw==="BID SELL"?"BID SELL":raw==="MULTI-LEG"?"MULTI-LEG":raw==="LATE PRINT"?"LATE PRINT":raw==="NO NBBO"?"NO NBBO":raw==="STALE NBBO"?"STALE NBBO":"MID/UNCLEAR";
  let direction=["BULLISH","BEARISH","UNCLEAR"].includes(p.direction)?p.direction:"UNCLEAR";
  if(direction==="UNCLEAR"&&execution==="ASK BUY") direction=p.side==="call"?"BULLISH":"BEARISH";
  if(direction==="UNCLEAR"&&execution==="BID SELL") direction=p.side==="call"?"BEARISH":"BULLISH";
  const executionColor=execution==="ASK BUY"?"#34d399":execution==="BID SELL"?"#f87171":"#fbbf24";
  const directionColor=direction==="BULLISH"?"#34d399":direction==="BEARISH"?"#f87171":"#fbbf24";
  const directionGlyph=direction==="BULLISH"?"▲":direction==="BEARISH"?"▼":"◆";
  const exitSide=execution==="ASK BUY"?"BID":execution==="BID SELL"?"ASK":"";
  const exitText=exitSide&&live.exitPrice!=null?`${exitSide} $${live.exitPrice.toFixed(2)}${live.stale?"*":""}`:"—";
  const pnlRole=execution==="ASK BUY"?"buyer":execution==="BID SELL"?"seller":"unclassified trade";
  const pnlTitle=execution==="ASK BUY"
    ? `Estimated buyer P&L uses the current executable bid${live.exitPrice!=null?` ($${live.exitPrice.toFixed(2)})`:""}, not the midpoint mark.`
    : execution==="BID SELL"
      ? `Estimated seller P&L uses the current executable ask${live.exitPrice!=null?` ($${live.exitPrice.toFixed(2)})`:""}, not the midpoint mark.`
      : "P&L is unavailable because the execution could not be classified as an ask buy or bid sell.";
  return {execution,direction,executionColor,directionColor,directionGlyph,exitText,pnlRole,pnlTitle};
}

function mkTapeRow(p,allOrders=[]){
  const isC=p.side==="call";
  const col=isC?"#34d399":"#f87171";
  const isW=p.prem>=500000;
  const isWS=p.source==="ws";
  const premCol=isW?"#fbbf24":p.prem>=200000?"#fb923c":"#7a8ba8";
  const d=document.createElement("div");
  d.className="trow"+(isW?" wh":"")+(p.isNew?" flash":"");
  d.style.borderLeft=isW?"2px solid var(--amber)":(isWS?"2px solid #a78bfa":"2px solid transparent");
  const prints=Math.max(1,Number(p.printCount||1));
  const rawType=p.orderType || (prints>1?"GROUPED":"PRINT");
  const type=["SPLIT","SWEEP","CLUSTER","BLOCK","PRINT","GROUPED"].includes(rawType)?rawType:"PRINT";
  const typeCol=type.includes("SPLIT")?"#34d399":type.includes("SWEEP")?"#fbbf24":type.includes("CLUSTER")?"#22d3ee":"#7a8ba8";
  const typeText=type.includes("SPLIT")&&Number(p.venueCount)>1?`${type} ${p.venueCount}X`:type;
  const venueNote=Number(p.venueCount)>1?` across ${p.venueCount} exchanges`:"";
  d.title = p.priceMin!=null && p.priceMax!=null && p.priceMin!==p.priceMax
    ? `Fill range $${p.priceMin.toFixed(2)}–$${p.priceMax.toFixed(2)} · ${prints} original prints${venueNote}`
    : `${prints} original print${prints===1?"":"s"}${venueNote}`;
  const live=tapeEstimatedPnL(p);
  const pnlColor=live.pnl==null?"#7a8ba8":live.pnl>0?"#34d399":live.pnl<0?"#f87171":"#fbbf24";
  const pnlText=live.pnl==null?"—":`${live.pnl>=0?"+":""}${fD(live.pnl)} · ${live.pct>=0?"+":""}${(live.pct*100).toFixed(1)}%`;
  const markText=live.mark==null?"—":`$${live.mark.toFixed(2)}${live.stale?"*":""}`;
  const status=p._status||classifyTapeStatus(p,allOrders);
  const inst=institutionalScore(p,allOrders,live);
  const exec=tapeExecutionDetails(p,live);
  d.innerHTML=`
    <span class="mono" style="color:#9fb4c8;font-size:9px">${fT(p.ts)}</span>
    <span title="${exec.direction} pressure" style="color:${exec.directionColor};font-size:12px;font-weight:900">${exec.directionGlyph}</span>
    <span style="color:${col};font-size:8px;font-weight:700;padding:1px 4px;background:${col}18;border-radius:3px">${isC?"CALL":"PUT"}${isWS?'<span style="color:#a78bfa;margin-left:2px">⚡</span>':''}</span>
    <span style="color:#d8e6f5;font-weight:600">$${p.strike}</span>
    <span style="color:#7a8ba8">$${Number(p.price||0).toFixed(2)}</span>
    <span style="color:${p.size>=100?"#d8e6f5":"#7a8ba8"};font-weight:${p.size>=100?700:400}">${fN(p.size)}</span>
    <span style="color:${premCol};font-weight:${isW?700:400}">${fD(p.prem)}</span>
    <span style="color:${prints>1?"#d8e6f5":"#7f96ab"};font-weight:${prints>1?700:400}">${prints}</span>
    <span style="color:${typeCol};font-size:8px;font-weight:700">${typeText}</span>
    <span style="color:${p.delta==null?"#7f96ab":Math.abs(p.delta)>.5?"#d8e6f5":"#afc2d3"};font-size:9px">${p.delta!=null?p.delta.toFixed(2):"—"}</span>
    <span title="Execution classification from the trade price versus live NBBO" style="color:${exec.executionColor};font-size:8px;font-weight:900">${exec.execution}</span>
    <span title="Directional meaning of ${exec.execution} ${isC?"call":"put"}" style="color:${exec.directionColor};font-size:8px;font-weight:900">${exec.direction}</span>
    <span style="color:${live.stale&&live.mark!=null?"#fbbf24":"#d8e6f5"};font-size:9px;font-weight:700">${markText}</span>
    <span title="Executable price used for estimated ${exec.pnlRole} P&L" style="color:${live.stale&&live.exitPrice!=null?"#fbbf24":"#d8e6f5"};font-size:8px;font-weight:800">${exec.exitText}</span>
    <span title="${exec.pnlTitle}" style="color:${pnlColor};font-size:9px;font-weight:800">${pnlText}</span>
    ${institutionalScoreHtml(inst)}
    <span style="color:${status.color};font-size:8px;font-weight:800">${status.label}</span>`;
  return d;
}

function tapeEstimatedPnL(p){
  const live=pressureLiveMark(p);
  if(live.exitPrice==null) return {...live,pnl:null,pct:null};
  let pnl=null;
  if(p.execution==="ASK BUY") pnl=(live.exitPrice-Number(p.price||0))*Number(p.size||0)*100;
  else if(p.execution==="BID SELL") pnl=(Number(p.price||0)-live.exitPrice)*Number(p.size||0)*100;
  if(pnl==null) return {...live,pnl:null,pct:null};
  const basis=Math.max(0.01,Number(p.price||0)*Number(p.size||0)*100);
  return {...live,pnl,pct:pnl/basis};
}

function tapeTsMs(ts){
  const n=Number(ts||0);
  if(!Number.isFinite(n)) return 0;
  if(n>1e17) return n/1e6;
  if(n>1e14) return n/1e3;
  if(n>1e12) return n;
  if(n>1e10) return n;
  return n*1000;
}

function reconstructTape(raw){
  const sorted=[...raw].sort((a,b)=>tapeTsMs(a.ts)-tapeTsMs(b.ts));
  // Consolidated feeds report one routed order as several prints from different
  // exchanges. Merge those near-simultaneous pieces before sweep clustering so
  // contracts and premium represent the parent order instead of each venue leg.
  const splitOrders=[];
  for(const p of sorted){
    const t=tapeTsMs(p.ts),venue=p.exchange??p.venue??null;
    const tolerance=Math.max(0.02,Number(p.price||0)*0.005);
    let parent=null;
    for(let i=splitOrders.length-1;i>=0;i--){
      const candidate=splitOrders[i];
      if(t-candidate.lastMs>TAPE_SPLIT_PRINT_WINDOW_MS)break;
      if(candidate.sym===p.sym&&candidate.side===p.side&&candidate.execution===p.execution&&
         Number(candidate.strike)===Number(p.strike)&&
         Math.abs(Number(candidate.lastPrice)-Number(p.price))<=tolerance){parent=candidate;break;}
    }
    if(parent){
      parent.ts=Math.max(Number(parent.ts)||0,Number(p.ts)||0);parent.lastMs=t;parent.lastPrice=Number(p.price||0);
      parent.size+=Number(p.size||0);parent.prem+=Number(p.prem||0);parent.printCount++;
      parent.weightedPriceTotal+=Number(p.price||0)*Number(p.size||0);parent.price=parent.size?parent.weightedPriceTotal/parent.size:Number(p.price||0);
      parent.priceMin=Math.min(parent.priceMin,Number(p.price||0));parent.priceMax=Math.max(parent.priceMax,Number(p.price||0));
      parent.isNew=parent.isNew||p.isNew;if(p.delta!=null)parent.delta=p.delta;
      if(venue!=null&&!parent.exchangeIds.includes(String(venue)))parent.exchangeIds.push(String(venue));
      continue;
    }
    splitOrders.push({...p,firstMs:t,lastMs:t,lastPrice:Number(p.price||0),printCount:1,
      exchangeIds:venue==null?[]:[String(venue)],weightedPriceTotal:Number(p.price||0)*Number(p.size||0),
      priceMin:Number(p.price||0),priceMax:Number(p.price||0)});
  }

  const sweeps=[];
  for(const p of splitOrders){
    const t=tapeTsMs(p.ts);
    const tolerance=Math.max(0.03,Number(p.price||0)*0.015);
    let last=null;
    for(let i=sweeps.length-1;i>=0;i--){
      const candidate=sweeps[i];
      if(t-candidate.lastMs>TAPE_SWEEP_WINDOW_MS) break;
      if(candidate.sym===p.sym && candidate.side===p.side && candidate.execution===p.execution &&
         Number(candidate.strike)===Number(p.strike) &&
         Math.abs(Number(candidate.lastPrice)-Number(p.price))<=tolerance){last=candidate;break;}
    }
    if(last){
      last.ts=Math.max(Number(last.ts)||0,Number(p.ts)||0);
      last.lastMs=t;
      last.lastPrice=Number(p.price||0);
      last.size+=Number(p.size||0);
      last.prem+=Number(p.prem||0);
      last.printCount+=Number(p.printCount||1);
      last.weightedPriceTotal+=Number(p.price||0)*Number(p.size||0);
      last.price=last.size?last.weightedPriceTotal/last.size:Number(p.price||0);
      last.priceMin=Math.min(last.priceMin,Number(p.price||0));
      last.priceMax=Math.max(last.priceMax,Number(p.price||0));
      last.isNew=last.isNew||p.isNew;
      last.source=last.source||p.source;
      last.hasSplitPrints=last.hasSplitPrints||Number(p.printCount||1)>1;
      for(const venue of p.exchangeIds||[])if(!last.exchangeIds.includes(venue))last.exchangeIds.push(venue);
      if(last.execution!==p.execution) last.execution="UNCLEAR";
      if(p.delta!=null) last.delta=p.delta;
      continue;
    }
    sweeps.push({...p,lastMs:t,lastPrice:Number(p.price||0),hasSplitPrints:Number(p.printCount||1)>1,
      exchangeIds:[...(p.exchangeIds||[])]});
  }

  const clusters=[];
  for(const p of sweeps){
    const t=tapeTsMs(p.ts);
    let last=null;
    for(let i=clusters.length-1;i>=0;i--){
      const candidate=clusters[i];
      if(t-candidate.lastMs>TAPE_CLUSTER_WINDOW_MS) break;
      if(candidate.sym===p.sym && candidate.side===p.side && candidate.execution===p.execution &&
         Number(candidate.strike)===Number(p.strike)){last=candidate;break;}
    }
    if(last){
      last.ts=Math.max(Number(last.ts)||0,Number(p.ts)||0);
      last.lastMs=t;
      last.size+=Number(p.size||0);
      last.prem+=Number(p.prem||0);
      last.printCount+=Number(p.printCount||1);
      last.groupCount++;
      last.weightedPriceTotal+=Number(p.price||0)*Number(p.size||0);
      last.price=last.size?last.weightedPriceTotal/last.size:Number(p.price||0);
      last.priceMin=Math.min(last.priceMin,Number(p.priceMin??p.price)||0);
      last.priceMax=Math.max(last.priceMax,Number(p.priceMax??p.price)||0);
      last.isNew=last.isNew||p.isNew;
      last.hasSplitPrints=last.hasSplitPrints||p.hasSplitPrints;
      for(const venue of p.exchangeIds||[])if(!last.exchangeIds.includes(venue))last.exchangeIds.push(venue);
      if(last.execution!==p.execution) last.execution="UNCLEAR";
      if(p.delta!=null) last.delta=p.delta;
    }else{
      clusters.push({...p,lastMs:t,groupCount:1,exchangeIds:[...(p.exchangeIds||[])]});
    }
  }
  return clusters.map(p=>({...p,venueCount:p.exchangeIds.length,
    orderType:p.hasSplitPrints?"SPLIT":p.groupCount>1?"CLUSTER":p.printCount>1?"SWEEP":"BLOCK"})).sort((a,b)=>tapeTsMs(b.ts)-tapeTsMs(a.ts));
}

function etTodayYmd(){
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date()).filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nextWeekday(n=0){
  const [year,month,day]=etTodayYmd().split("-").map(Number);
  const d=new Date(Date.UTC(year,month-1,day+n));
  while(d.getUTCDay()===0||d.getUTCDay()===6) d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
}

function isValidExpiry(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))) return false;
  const d=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.getUTCDay()!==0 && d.getUTCDay()!==6;
}

function getSelectedExpiry(){
  const input=document.getElementById("expiry-select");
  const selected=String(input?.value||localStorage.getItem(EXPIRY_STORAGE_KEY)||"");
  return isValidExpiry(selected) ? selected : nextWeekday(0);
}

function expiryDteLabel(value){
  const today=new Date(`${etTodayYmd()}T00:00:00Z`);
  const expiry=new Date(`${value}T00:00:00Z`);
  const days=Math.max(0,Math.round((expiry-today)/86400000));
  return days===0 ? "0DTE · today" : `${days}DTE · selected expiration`;
}

function updateExpiryNote(value){
  const note=document.getElementById("expiry-note");
  if(note) note.textContent=expiryDteLabel(value);
}

function initExpirySelector(){
  const input=document.getElementById("expiry-select");
  if(!input) return;
  const minimum=nextWeekday(0);
  let selected=localStorage.getItem(EXPIRY_STORAGE_KEY)||minimum;
  if(!isValidExpiry(selected)||selected<minimum) selected=minimum;
  input.min=minimum;
  input.value=selected;
  localStorage.setItem(EXPIRY_STORAGE_KEY,selected);
  updateExpiryNote(selected);
}

function changeExpiration(value){
  const input=document.getElementById("expiry-select");
  if(!isValidExpiry(value)){
    const fallback=getSelectedExpiry();
    if(input) input.value=fallback;
    showErr("Select a weekday expiration date.");
    return;
  }
  const previous=String(localStorage.getItem(EXPIRY_STORAGE_KEY)||nextWeekday(0));
  if(value===previous && chain.length) return;

  if(pressurePersistTimer){
    clearTimeout(pressurePersistTimer);
    pressurePersistTimer=null;
  }
  mergeChartFlowOrders(currentQualifyingChartFlowOrders());
  persistPressurePrints(previous);
  persistTape(previous);
  clearTimeout(flowForcePersistTimer);flowForcePersistTimer=null;
  clearTimeout(candleContractPersistTimer);candleContractPersistTimer=null;
  persistFlowForce(previous);
  persistCandleContractTotals(previous);
  localStorage.setItem(EXPIRY_STORAGE_KEY,value);
  if(input) input.value=value;
  updateExpiryNote(value);

  chainRequestId++;
  unsubscribeAllMassiveContracts();
  optionQuoteMap.clear();
  chain=[];
  tapePrints=[];
  loadTape();
  pressurePrints=[];
  loadFlowForce();
  loadCandleContractTotals();
  lastOptionTradeTs=0;
  pressurePrintIds.clear();
  seenOptionTradeKeys.clear();
  seenOptionTradeQueue=[];
  prevSnaps={};
  isFirstLoad=true;
  loadPressurePrints();
  document.getElementById("ct-v").textContent="—";
  document.getElementById("ct-s").textContent="";
  setStatus(`loading ${value} expiration…`);
  renderFlowTape();
  renderPressureTape(true);
  scheduleChartFlowArchive();
  scheduleFlowCandleLabels();
  refreshFlowVolumeSeries();
  fetchAll();
}

function pressureStoreKey(expiry=getSelectedExpiry()){
  return `${PRESSURE_STORE_KEY_PREFIX}:${expiry}`;
}

// clock
function updateMarketClock(){
  const el=document.getElementById("clk");
  if(el) el.textContent=`${formatMarketTime(new Date())} ${marketZoneName(new Date())}`;
}
updateMarketClock();
setInterval(updateMarketClock,1000);

// ─── simulation engine ────────────────────────────────────────────────────────
const simPrice0 = 562.45;   // starting price
let simPrice   = 562.45;   // current sim price
let simIv      = 0.18;
let simTick    = 0;        // ticks elapsed
let simElapsed = 0;        // seconds elapsed
let simScenario= "bull";   // bull | bear | chop | spike
let simSpeed   = 1;        // 1 | 2 | 5
const demoStartMinute = Math.floor(Date.now()/60000)*60000;
const demoCandles = new Map();
const demoSeededExpiries = new Set();
let demoTradeSequence = 0;
let simOIMap   = {};       // stable OI per strike_type
let simVolMap  = {};       // accumulated volume per strike_type

// Black-Scholes helpers
function _erf(x){
  const t=1/(1+0.3275911*Math.abs(x));
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
  return x>=0?y:-y;
}
function _N(x){return 0.5*(1+_erf(x/Math.SQRT2));}
function bsPrice(S,K,T,sigma,isCall){
  if(T<=1e-6) return Math.max(0,isCall?S-K:K-S);
  const d1=(Math.log(S/K)+(0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T));
  const d2=d1-sigma*Math.sqrt(T);
  if(isCall) return Math.max(0.01,S*_N(d1)-K*_N(d2));
  return Math.max(0.01,K*_N(-d2)-S*_N(-d1));
}
function bsDelta(S,K,T,sigma,isCall){
  if(T<=1e-6) return isCall?(S>K?1:0):(S<K?-1:0);
  const d1=(Math.log(S/K)+(0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T));
  return isCall?_N(d1):_N(d1)-1;
}
function bsGamma(S,K,T,sigma){
  if(T<=1e-6) return 0;
  const d1=(Math.log(S/K)+(0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T));
  return Math.exp(-d1*d1/2)/(S*sigma*Math.sqrt(T)*Math.sqrt(2*Math.PI));
}
function bsTheta(S,K,T,sigma,isCall){
  if(T<=1e-6) return 0;
  const d1=(Math.log(S/K)+(0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T));
  const d2=d1-sigma*Math.sqrt(T);
  const nd1=Math.exp(-d1*d1/2)/Math.sqrt(2*Math.PI);
  const base=-(S*nd1*sigma)/(2*Math.sqrt(T));
  return isCall?base/365:base/365;
}
function bsVega(S,K,T,sigma){
  if(T<=1e-6) return 0;
  const d1=(Math.log(S/K)+(0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T));
  const nd1=Math.exp(-d1*d1/2)/Math.sqrt(2*Math.PI);
  return S*nd1*Math.sqrt(T)*0.01;  // $ per 1% IV change
}

// Init stable OI when sim launches
function initSimOI(base){
  simOIMap={};simVolMap={};
  base=Math.round(base*2)/2;
  for(let s=base-25;s<=base+25;s+=0.5){
    ["call","put"].forEach(type=>{
      const isC=type==="call",dist=Math.abs(s-base);
      const oiBase=Math.max(500,Math.round(15000*Math.exp(-dist*.12)*(0.7+Math.random()*.6)));
      simOIMap[`${s}_${type}`]=oiBase;
      simVolMap[`${s}_${type}`]=Math.round(oiBase*(0.1+Math.random()*.15));
    });
  }
}

// Generate full chain snapshot at current sim state
function simChain(expiry){
  const S=simPrice, T=simTimeToExpiry(expiry);
  const sigma0=simIv;
  const priceMove=(S-simPrice0)/simPrice0;
  // skew: IV rises for OTM puts on down moves
  const skewFactor=Math.max(0,-(priceMove)*8);

  const result=[];
  for(let s=S-25;s<=S+25;s+=0.5){
    s=Math.round(s*2)/2;
    ["call","put"].forEach(type=>{
      const isC=type==="call",dist=Math.abs(s-S);
      // IV smile + skew
      const itmDist=(s-S)/S;
      const smile=0.015+dist*0.0012;
      const skew=(!isC&&s<S)?skewFactor*0.008:0;
      const iv=Math.min(2.0,Math.max(0.08,sigma0+smile+skew));
      const lp=bsPrice(S,s,T,iv,isC);
      const delta=bsDelta(S,s,T,iv,isC);
      const gamma=bsGamma(S,s,T,iv);
      const theta=bsTheta(S,s,T,iv,isC);
      const vega=bsVega(S,s,T,iv);
      const key=`${s}_${type}`;
      if(!simOIMap[key]){simOIMap[key]=Math.max(200,Math.round(5000*Math.exp(-dist*.15)));simVolMap[key]=0;}
      result.push({
        details:{ticker:occTicker(expiry,type,s),expiration_date:expiry,strike_price:s,contract_type:type},
        day:{volume:simVolMap[key]},
        open_interest:simOIMap[key],
        implied_volatility:iv,
        greeks:{delta:+delta.toFixed(3),gamma:+gamma.toFixed(5),theta:+theta.toFixed(4),vega:+vega.toFixed(4)},
        last_trade:{price:+lp.toFixed(2)},
        last_quote:(()=>{
          // Simulated NBBO with strike-distance dependent spread + size depth
          const spread = Math.max(0.01, lp*0.01 + dist*0.002);
          const ask = +(lp + spread/2).toFixed(2);
          const bid = +Math.max(0.01, lp - spread/2).toFixed(2);
          // Larger sizes nearer the money + occasional iceberg-like blocks
          const baseSz = Math.max(1, Math.round(80*Math.exp(-dist*0.2) + Math.random()*40));
          const askSz = baseSz + (Math.random()<0.08 ? Math.round(Math.random()*400) : 0);
          const bidSz = baseSz + (Math.random()<0.08 ? Math.round(Math.random()*400) : 0);
          return {midpoint:+lp.toFixed(2), ask, bid, ask_size:askSz, bid_size:bidSz};
        })()
      });
    });
  }
  return result;
}

function simTimeToExpiry(expiry){
  const days=Math.round((Date.parse(expiry)-Date.parse(etTodayYmd()))/86400000);
  return Math.max(.25,days+.5-simElapsed/86400)/365;
}

// Scenario drift + vol params
function simParams(){
  switch(simScenario){
    case "bull":  return{drift:+0.00035,vol:0.008,ivDrift:-0.0003,flowBias:0.6};
    case "bear":  return{drift:-0.00035,vol:0.009,ivDrift:+0.0006,flowBias:-0.6};
    case "chop":  return{drift:0,       vol:0.006,ivDrift:0,      flowBias:0};
    case "spike": return{drift:0,       vol:0.025,ivDrift:+0.0012,flowBias:0};
    default:      return{drift:0,       vol:0.008,ivDrift:0,      flowBias:0};
  }
}

// Advance the synthetic market independently of snapshot refreshes.
function simStep(){
  simTick++;
  simElapsed+=12;
  const {drift,vol,ivDrift,flowBias}=simParams();

  // GBM price step
  const z=(Math.random()+Math.random()+Math.random()-1.5)*0.8165; // approx normal
  const dt=3/3600; // 3s as fraction of hour
  const dP=simPrice*(drift+vol*Math.sqrt(dt)*z);
  simPrice=Math.max(400,+(simPrice+dP).toFixed(2));

  // Generic simulated option IV, independent of any external volatility index.
  const ivNoise=(Math.random()+Math.random()-1)*0.5;
  const dIv=-dP/simPrice*simIv*8+ivDrift*dt*10+ivNoise*0.0015;
  simIv=Math.max(0.10,Math.min(0.80,simIv+dIv));

  // Volume accumulation — bias toward scenario direction
  const bias=flowBias+(dP>0?0.3:-0.3); // momentum
  const S=simPrice;
  for(const key of Object.keys(simOIMap)){
    const [strikeStr,type]=key.split("_");
    const strike=+strikeStr,isC=type==="call";
    const dist=Math.abs(strike-S);
    const atm=Math.exp(-dist*.18);
    // directional flow: bull→calls, bear→puts
    const dirBias=isC?Math.max(0,bias):Math.max(0,-bias);
    const baseFlow=Math.round(atm*(150+Math.random()*200)*dirBias+atm*(30+Math.random()*60));
    simVolMap[key]=(simVolMap[key]||0)+Math.max(0,baseFlow);
  }

  const move=simPrice-simPrice0;
  const moveText=document.getElementById("sim-move");
  moveText.textContent=`${move.toFixed(2)} (${(move/simPrice0*100).toFixed(2)}%)`;
  moveText.style.color=move>=0?"var(--green)":"var(--red)";
  document.getElementById("sim-elapsed").textContent=`t+${Math.floor(simElapsed/60)}m ${simElapsed%60}s`;
}

function setScenario(s){
  simScenario=s;
  ["bull","bear","chop","spike"].forEach(x=>{
    const btn=document.getElementById("sc-"+x);
    if(!btn)return;
    const cols={bull:"#34d399",bear:"#f87171",chop:"#fbbf24",spike:"#a78bfa"};
    if(x===s){btn.style.borderColor=cols[s];btn.style.background=cols[s]+"22";btn.style.color=cols[s];btn.classList.add("on");}
    else{btn.style.borderColor="";btn.style.background="";btn.style.color="";btn.classList.remove("on");}
  });
}
function setSimSpeed(v){
  simSpeed=v;
  [1,2,5].forEach(x=>{
    const b=document.getElementById("sp-"+x);if(!b)return;
    if(x===v){b.classList.add("on");b.style.borderColor="var(--accent)";b.style.background="rgba(56,189,248,.12)";b.style.color="var(--accent)";}
    else{b.classList.remove("on");b.style.borderColor="";b.style.background="";b.style.color="";}
  });
}

function setDemoUrl(url, enabled){
  if(enabled) url.searchParams.set("demo","1");
  else url.searchParams.delete("demo");
  return url;
}

function toggleDemoMode(){
  const nextMode=!DEMO_MODE;
  const url=setDemoUrl(new URL(location.href),nextMode);
  const activeTab=document.querySelector(".tc.on");
  if(activeTab) url.hash=activeTab.id.slice(3);
  // Start a fresh page so pending live requests and in-memory data cannot carry over.
  if(isChartWindowOpen()){
    const chartUrl=new URL(url);
    chartUrl.searchParams.set("chartWindow","1");
    chartUrl.searchParams.delete("popout");
    chartUrl.hash="chart";
    chartExternalWindow.location.href=chartUrl;
  }
  if(isPremiumWindowOpen()) premiumExternalWindow.location.href=setDemoUrl(new URL(premiumPopoutUrl()),nextMode);
  closeRealtimeStream();
  location.replace(url);
}

function demoBootstrap(expiry){
  return {stock:{price:simPrice,previousClose:simPrice0,source:"demo",timestamp:Date.now()},chain:simChain(expiry)};
}

function demoHistoricalPrice(timestamp){
  const offset=(timestamp-demoStartMinute)/60000;
  return simPrice0+Math.sin(offset/18)*1.6+Math.sin(offset/4)*.25+Math.sin(offset/390)*2;
}

function demoGexHistory(interval){
  const bucket=Math.floor(Date.now()/interval)*interval;
  return Array.from({length:28},(_,i)=>{
    const t=bucket-(28-i)*interval;
    return {t,r:16*Math.sin(i/4)+6*Math.sin(i/2),spotOpen:demoHistoricalPrice(t),spotLast:demoHistoricalPrice(t+interval)};
  });
}

function demoCandle(t,open,close){
  const o=+open.toFixed(2),c=+close.toFixed(2);
  return {t,o,c,h:+(Math.max(o,c)+.12).toFixed(2),l:+(Math.min(o,c)-.12).toFixed(2),v:12000+(t/60000%17)*1700,vw:(o+c)/2};
}

function demoCandleHistory(from,to){
  const start=Date.parse(from+"T00:00:00Z");
  const end=Date.parse(to+"T00:00:00Z")+86400000;
  const now=Math.floor(Date.now()/60000)*60000;
  const results=[];
  let lastClose=simPrice0;
  const boundaryWindow=6*60*60*1000;
  const lastMinute=Math.min(now,end+boundaryWindow);
  for(let t=start;t<=lastMinute;t+=60000){
    // Check the New York date near the UTC boundaries of the requested range.
    if(t<start+boundaryWindow || t>=end){
      const day=chartDateET(new Date(t));
      if(day<from || day>to) continue;
    }
    const bar=demoCandles.get(t) || (t<demoStartMinute
      ? demoCandle(t,demoHistoricalPrice(t-60000),demoHistoricalPrice(t))
      : demoCandle(t,lastClose,lastClose));
    results.push(bar);
    lastClose=bar.c;
  }
  return {results};
}

function openDemoStream(expiry,range){
  const stream=new EventTarget();
  const emit=(type,data)=>stream.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));
  stream.readyState=EventSource.CONNECTING;
  let timer=setTimeout(start,0);
  stream.close=()=>{clearTimeout(timer);stream.readyState=EventSource.CLOSED;};

  function optionSamples(){
    const contracts=simChain(expiry)
      .filter(c=>!range||Math.abs(c.details.strike_price-simPrice)<=range)
      .sort((a,b)=>Math.abs(a.details.strike_price-simPrice)-Math.abs(b.details.strike_price-simPrice));
    return ["call","put"].map(side=>contracts.filter(c=>c.details.contract_type===side).slice(0,6));
  }

  function printOptions(samples,timestamp,index){
    const quotes=samples.filter(group=>group.length).map(group=>{
      const contract=group[index%group.length];
      const {bid,ask,bid_size,ask_size}=contract.last_quote;
      return {sym:contract.details.ticker,bp:bid,ap:ask,bs:bid_size,as:ask_size,t:timestamp-1};
    });
    emit("option_quote_batch",quotes);
    quotes.forEach((quote,i)=>{
      const price=(index+i)%4===3?quote.bp:quote.ap;
      const premium=[240000,370000,520000,680000][(index+i)%4];
      emit("option_trade",{sym:quote.sym,p:price,s:Math.ceil(premium/(price*100)),q:++demoTradeSequence,t:timestamp,x:1,c:[]});
    });
  }

  function start(){
    stream.readyState=EventSource.OPEN;
    emit("open");
    emit("feed_status",{stocks:"demo",options:"demo"});
    if(!CHART_WINDOW_MODE && !demoSeededExpiries.has(expiry)){
      demoSeededExpiries.add(expiry);
      if(!tapePrints.length){
        const now=Date.now(),samples=optionSamples();
        for(let i=0;i<20;i++) printOptions(samples,now-(20-i)*60000,i);
      }
    }
    tick();
  }

  function tick(){
    const open=simPrice;
    simStep();
    const timestamp=Date.now(),minute=Math.floor(timestamp/60000)*60000;
    const bar=demoCandles.get(minute) || demoCandle(minute,open,simPrice);
    bar.c=simPrice;
    bar.h=Math.max(bar.h,simPrice);
    bar.l=Math.min(bar.l,simPrice);
    bar.vw=(bar.o+bar.c)/2;
    demoCandles.set(minute,bar);
    emit("stock_quote",{bid:simPrice-.01,ask:simPrice+.01});
    emit("stock_tick",{price:simPrice,timestamp,source:"demo"});
    if(!CHART_WINDOW_MODE) printOptions(optionSamples(),timestamp,simTick);
    timer=setTimeout(tick,Math.max(1000,Math.round(3000/simSpeed)));
  }
  return stream;
}

// Same-origin Node market-data API
function optionsApiKey(){
  return MASSIVE_KEY || API_KEY;
}

async function pg(path){
  const match=/^\/v2\/aggs\/ticker\/SPY\/range\/1\/minute\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})(?:\?|$)/.exec(String(path||""));
  if(!match) throw Object.assign(new Error("Unsupported market-data request."),{status:400});
  if(DEMO_MODE) return demoCandleHistory(match[1],match[2]);
  const query=new URLSearchParams({from:match[1],to:match[2]});
  const r=await fetch(`/api/v1/candles?${query}`,{headers:{Accept:"application/json"},credentials:"same-origin"});
  const body=await r.json().catch(()=>({}));
  if(!r.ok) throw Object.assign(new Error(body.error||`${r.status} ${r.statusText}`),{status:r.status});
  return body;
}

async function fetchAll(){
  if(!API_KEY&&!MASSIVE_KEY) return;
  const requestId=++chainRequestId;
  const expiry=getSelectedExpiry();
  updateExpiryNote(expiry);
  document.getElementById("spin").style.display="inline";
  document.getElementById("errbox").style.display="none";
  document.getElementById("plan-box").style.display="none";
  setStatus("fetching…");

  try{
    let payload;
    if(DEMO_MODE){
      payload=demoBootstrap(expiry);
    }else{
      const query=new URLSearchParams({expiry});
      const response=await fetch(`/api/v1/bootstrap?${query}`,{headers:{Accept:"application/json"},credentials:"same-origin"});
      payload=await response.json().catch(()=>({}));
      if(!response.ok) throw Object.assign(new Error(payload.error||`${response.status} ${response.statusText}`),{status:response.status});
    }
    if(requestId!==chainRequestId || expiry!==getSelectedExpiry()) return;
    const nextChain=Array.isArray(payload.chain)?payload.chain:[];
    chain=nextChain;
    if(chain.length)diffAndAccumulate(chain);
    if(payload.stock?.previousClose) spyPrevClose=+Number(payload.stock.previousClose).toFixed(2);
    if(payload.stock?.price) applySpyPrice(+Number(payload.stock.price).toFixed(2),payload.stock.source||"rest",payload.stock.timestamp);
    const hasOptions=chain.length>0;
    document.getElementById("mode-badge").className=DEMO_MODE?"badge demo-badge":hasOptions?"badge bl":"badge bw";
    document.getElementById("mode-badge").textContent=DEMO_MODE?"DEMO · MOCK DATA":hasOptions?"⚡ LIVE":"STOCKS ONLY";
    document.getElementById("ct-v").textContent=chain.length;
    document.getElementById("ct-s").textContent=`C ${chain.filter(c=>c.details?.contract_type==="call").length} · P ${chain.filter(c=>c.details?.contract_type==="put").length}`;
    if(hasOptions)setStatus(`${chain.length} contracts · ${expiry}`);
    else{
      const notice=document.getElementById("plan-box"),issue=payload.optionsError;
      notice.style.display="block";
      notice.textContent=issue?.status===403
        ? "OPTIONS ACCESS UNAVAILABLE · The current Options plan does not allow the chain snapshot. SPY candles, EMA, ADX/DI and price studies remain available through the Stocks feed. Option flow, GEX and option walls require Options data."
        : `OPTIONS UNAVAILABLE · ${issue?.message||`No contracts returned for ${expiry}. Select an active expiration.`} · The Stocks chart remains available independently.`;
      setStatus("Stocks feed available · options unavailable");
    }
    if(payload.stockWarning) console.warn(payload.stockWarning);
  }catch(e){
    if(requestId!==chainRequestId) return;
    chain=[];
    if(e.status===403){document.getElementById("plan-box").style.display="block";document.getElementById("mode-badge").className="badge bw";document.getElementById("mode-badge").textContent="OPTIONS PLAN NEEDED";}
    else if(e.status===401){showErr("Your dashboard session expired. Reopen this feature from the PHP application.");document.getElementById("mode-badge").className="badge be";document.getElementById("mode-badge").textContent="SIGN IN REQUIRED";}
    else{showErr(e.message);}
    setStatus(e.message||"error");
  }

  if(requestId===chainRequestId){
    renderAll();
    document.getElementById("spin").style.display="none";
  }
}

// ─── derive & render ──────────────────────────────────────────────────────────

function updatePremiumWallDisplays(calls=chain.filter(c=>c.details?.contract_type==="call"), puts=chain.filter(c=>c.details?.contract_type==="put")){
  const sessionCutoff=new Date(); sessionCutoff.setHours(0,0,0,0);
  const cutoffMs=sessionCutoff.getTime(), selectedExpiry=getSelectedExpiry();
  const liveBySide={call:new Map(),put:new Map()}, pressureBySide={call:new Map(),put:new Map()};
  for(const p of tapePrints){
    if(!p||!Number.isFinite(+p.prem)||tapeTsMs(p.ts)<cutoffMs) continue;
    const parsed=p.sym?parseOCC(p.sym):null;
    if(parsed?.expiration&&selectedExpiry&&parsed.expiration!==selectedExpiry) continue;
    if(p.side!=="call"&&p.side!=="put") continue;
    const strike=Number(p.strike), premium=Number(p.prem||0);
    if(!Number.isFinite(strike)||premium<=0) continue;
    if(p.execution==="ASK BUY"){
      liveBySide[p.side].set(strike,(liveBySide[p.side].get(strike)||0)+premium);
      pressureBySide[p.side].set(strike,(pressureBySide[p.side].get(strike)||0)+premium);
    }else if(p.execution==="BID SELL"){
      pressureBySide[p.side].set(strike,(pressureBySide[p.side].get(strike)||0)-premium);
    }
  }
  const maxEntry=m=>{let b=null;for(const [strike,premium] of m)if(!b||premium>b.premium)b={strike,premium};return b;};
  const maxAbsEntry=m=>{let b=null;for(const [strike,net] of m)if(!b||Math.abs(net)>Math.abs(b.net))b={strike,net};return b;};
  const callLive=maxEntry(liveBySide.call),putLive=maxEntry(liveBySide.put);
  const callPressure=maxAbsEntry(pressureBySide.call),putPressure=maxAbsEntry(pressureBySide.put);
  const S2=spyPrice?spyPrice*spyPrice/100:1,gexBySide={call:new Map(),put:new Map()};
  for(const c of calls){const strike=Number(c.details?.strike_price);if(!Number.isFinite(strike))continue;const g=(c.greeks?.gamma??0)*(c.open_interest??0)*100*S2;gexBySide.call.set(strike,(gexBySide.call.get(strike)||0)+g);}
  for(const c of puts){const strike=Number(c.details?.strike_price);if(!Number.isFinite(strike))continue;const g=(c.greeks?.gamma??0)*(c.open_interest??0)*100*S2;gexBySide.put.set(strike,(gexBySide.put.get(strike)||0)+g);}
  const callGex=maxEntry(gexBySide.call),putGex=maxEntry(gexBySide.put);
  const fmtGex=v=>{const a=Math.abs(v||0);if(a>=1e9)return `$${(a/1e9).toFixed(2)}B`;if(a>=1e6)return `$${(a/1e6).toFixed(0)}M`;if(a>=1e3)return `$${(a/1e3).toFixed(0)}K`;return `$${a.toFixed(0)}`;};
  const fmtSigned=v=>`${v>=0?"+":"-"}${fD(Math.abs(v||0))}`,set=(id,text)=>{const e=document.getElementById(id);if(e)e.textContent=text;};
  set("cw-live",callLive?`$${callLive.strike} · ${fD(callLive.premium)}`:"—"); set("pw-live",putLive?`$${putLive.strike} · ${fD(putLive.premium)}`:"—");
  set("cw-live-sub",callLive?"today's aggressive call ask-buy premium":"waiting for aggressive call buys"); set("pw-live-sub",putLive?"today's aggressive put ask-buy premium":"waiting for aggressive put buys");
  set("cw-gex",callGex?`$${callGex.strike} · ${fmtGex(callGex.premium)}`:"—"); set("pw-gex",putGex?`$${putGex.strike} · ${fmtGex(putGex.premium)}`:"—");
  set("cw-pressure",callPressure?`$${callPressure.strike} · ${fmtSigned(callPressure.net)}`:"—"); set("pw-pressure",putPressure?`$${putPressure.strike} · ${fmtSigned(putPressure.net)}`:"—");
  set("cw-pressure-sub",callPressure?(callPressure.net>=0?"net aggressive call buying":"net aggressive call selling"):"waiting for classified prints");
  set("pw-pressure-sub",putPressure?(putPressure.net>=0?"net aggressive put buying":"net aggressive put selling"):"waiting for classified prints");
  liveWallLevels={callPremium:callLive?.strike??null,putPremium:putLive?.strike??null,callPressure:callPressure?.strike??null,putPressure:putPressure?.strike??null,callGex:callGex?.strike??null,putGex:putGex?.strike??null};
  refreshChartLevels();
}

function gexRatioIntervalLabel(ms){
  if(ms<60000) return `${Math.round(ms/1000)}-second`;
  return `${Math.round(ms/60000)}-minute`;
}
function gexRatioStorageKey(expiry,intervalMs){
  return dataKey(`options_swift_gex_ratio_${String(expiry||"unknown").replace(/[^0-9A-Za-z_-]/g,"_")}_${intervalMs}`);
}
function loadGexRatioHistory(expiry){
  const key=`${expiry}|${GEX_RATIO_BUCKET_MS}`;
  if(gexRatioHistoryExpiry===key) return;
  gexRatioHistoryExpiry=key;
  gexRatioHistory=[];
  try{
    const parsed=JSON.parse(localStorage.getItem(gexRatioStorageKey(expiry,GEX_RATIO_BUCKET_MS))||"[]");
    if(Array.isArray(parsed)) gexRatioHistory=parsed.filter(p=>Number.isFinite(+p.t)&&Number.isFinite(+p.r)).slice(-GEX_RATIO_MAX_POINTS).map(p=>({t:+p.t,r:+p.r,spotOpen:Number.isFinite(+p.spotOpen)?+p.spotOpen:null,spotLast:Number.isFinite(+p.spotLast)?+p.spotLast:null}));
  }catch(_){gexRatioHistory=[];}
  if(DEMO_MODE&&!gexRatioHistory.length) gexRatioHistory=demoGexHistory(GEX_RATIO_BUCKET_MS);
  if(chartGexRatio){try{chartGexRatio.destroy();}catch(_){} chartGexRatio=null;}
}
function saveGexRatioHistory(){
  const [expiry]=String(gexRatioHistoryExpiry).split("|");
  try{localStorage.setItem(gexRatioStorageKey(expiry,GEX_RATIO_BUCKET_MS),JSON.stringify(gexRatioHistory.slice(-GEX_RATIO_MAX_POINTS)));}catch(_){}
}
// Called from the GEX Ratio Histogram's candle-interval dropdown. Switches the
// bucket width, forces a fresh load/redraw for that interval's own saved
// history (each interval keeps its own history so switching never mixes
// mismatched candle widths), and re-renders immediately if data is available.
function setGexRatioInterval(ms){
  const val=+ms;
  if(!GEX_RATIO_INTERVAL_OPTIONS.includes(val)) return;
  GEX_RATIO_BUCKET_MS=val;
  try{localStorage.setItem("options_swift_gex_ratio_interval_ms",String(val));}catch(_){}
  gexRatioHistoryExpiry=""; // force loadGexRatioHistory to reload under the new interval's key
  if(chartGexRatio){try{chartGexRatio.destroy();}catch(_){} chartGexRatio=null;}
  if(chain.length) renderAll();
}
function rollingGexRatioBands(rows,len=20,mult=2){
  const upper=[],mid=[],lower=[];
  for(let i=0;i<rows.length;i++){
    const start=Math.max(0,i-len+1), win=rows.slice(start,i+1).map(x=>x.r);
    const mean=win.reduce((a,b)=>a+b,0)/win.length;
    const variance=win.reduce((a,x)=>a+(x-mean)*(x-mean),0)/win.length;
    const sd=Math.sqrt(variance);
    upper.push(mean+mult*sd); mid.push(mean); lower.push(mean-mult*sd);
  }
  return {upper,mid,lower};
}
function updateGexRatioHistogram(totalCallGEX,totalPutGEX,fallbackCallGamma=0,fallbackPutGamma=0){
  const canvas=document.getElementById("gex-ratio-c");
  if(!canvas||typeof Chart!=="function") return;
  const expiry=getSelectedExpiry?.()||"unknown";
  loadGexRatioHistory(expiry);
  let call=Math.max(0,Number(totalCallGEX)||0), put=Math.max(0,Number(totalPutGEX)||0);
  let denom=call+put, sourceLabel="OI GEX";
  const currentEl=document.getElementById("gexr-current"), statusEl=document.getElementById("gex-ratio-status"), timeEl=document.getElementById("gex-ratio-time");
  const etNow=()=>new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"numeric",minute:"2-digit",second:"2-digit",hour12:true});

  // Some option-chain responses can temporarily omit/zero OI even while Greeks + day volume are present.
  // Keep the histogram alive with a clearly-labeled gamma×volume fallback instead of leaving the graph blank.
  if(!(denom>0)){
    call=Math.max(0,Number(fallbackCallGamma)||0);
    put =Math.max(0,Math.abs(Number(fallbackPutGamma)||0));
    denom=call+put;
    sourceLabel="FLOW GAMMA FALLBACK";
  }
  if(!(denom>0)){
    if(currentEl){currentEl.textContent="WAIT";currentEl.style.color="var(--amber)";}
    if(statusEl){
      statusEl.textContent="No ratio source yet — selected chain has no usable gamma×OI and no usable gamma×volume. Verify the expiration returned Greeks, OI, or day volume.";
      statusEl.style.color="var(--amber)";
    }
    if(timeEl)timeEl.textContent=`RATIO UPDATED ${etNow()} ET`;
    // Draw a visible zero baseline even while waiting so the panel is never visually blank.
    call=0; put=0; denom=1;
  }

  // Signed balance: +100% = all call gamma exposure, -100% = all put gamma exposure, 0% = balanced.
  const ratio=((call-put)/denom)*100;
  const now=Date.now(), bucket=Math.floor(now/GEX_RATIO_BUCKET_MS)*GEX_RATIO_BUCKET_MS;
  const liveSpot=Number.isFinite(+spyPrice)?+spyPrice:null;
  const last=gexRatioHistory[gexRatioHistory.length-1];
  if(last&&last.t===bucket){
    last.r=ratio;
    if(last.spotOpen==null&&liveSpot!=null) last.spotOpen=liveSpot;
    if(liveSpot!=null) last.spotLast=liveSpot;
  }else{
    const prevSpot=last&&Number.isFinite(+last.spotLast)?+last.spotLast:liveSpot;
    gexRatioHistory.push({t:bucket,r:ratio,spotOpen:prevSpot,spotLast:liveSpot});
  }
  if(gexRatioHistory.length>GEX_RATIO_MAX_POINTS)gexRatioHistory=gexRatioHistory.slice(-GEX_RATIO_MAX_POINTS);
  saveGexRatioHistory();

  // Histogram direction follows SPY price movement inside each time bucket:
  // green above zero = SPY moved up; red below zero = SPY moved down.
  // Bar magnitude keeps the GEX-ratio strength, while the CURRENT GEX RATIO stat preserves its original call-vs-put sign.
  const marketRows=gexRatioHistory.map((p,i)=>{
    const open=Number.isFinite(+p.spotOpen)?+p.spotOpen:(i>0&&Number.isFinite(+gexRatioHistory[i-1]?.spotLast)?+gexRatioHistory[i-1].spotLast:null);
    const close=Number.isFinite(+p.spotLast)?+p.spotLast:open;
    let dir=0;
    if(open!=null&&close!=null) dir=close>open?1:close<open?-1:0;
    else if(i>0) dir=p.r>gexRatioHistory[i-1].r?1:p.r<gexRatioHistory[i-1].r?-1:0;
    return {...p,marketDir:dir,plot:Math.abs(p.r)*(dir<0?-1:1)};
  });
  const bands=rollingGexRatioBands(marketRows.map(p=>({r:p.plot})),20,2);
  const fmtTime=t=>new Date(t).toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"numeric",minute:"2-digit",hour12:false});
  const labels=marketRows.map(row=>fmtTime(row.t));
  const vals=marketRows.map(row=>row.plot);
  const colors=marketRows.map(row=>row.marketDir<0?"rgba(248,113,113,.88)":"rgba(52,211,153,.88)");
  const zeroLine={id:"gexRatioZero",afterDraw(chart){const y=chart.scales?.y?.getPixelForValue(0);const a=chart.chartArea;if(!a||!Number.isFinite(y))return;const c=chart.ctx;c.save();c.strokeStyle="rgba(226,232,240,.48)";c.lineWidth=1;c.setLineDash([4,4]);c.beginPath();c.moveTo(a.left,y);c.lineTo(a.right,y);c.stroke();c.restore();}};
  const data={labels,datasets:[
    {type:"bar",label:"GEX / SPY Move",data:vals,backgroundColor:colors,borderColor:colors,borderWidth:0,minBarLength:3,barPercentage:.45,categoryPercentage:.8,order:2},
    {type:"line",label:"BB Upper",data:bands.upper,borderColor:"rgba(41,98,255,.9)",backgroundColor:"transparent",borderWidth:1,pointRadius:0,pointHoverRadius:3,tension:0,borderJoinStyle:"round",spanGaps:true,order:0,fill:false},
    {type:"line",label:"BB Mid",data:bands.mid,borderColor:"#fbbf24",backgroundColor:"transparent",borderWidth:1.2,borderDash:[4,3],pointRadius:0,pointHoverRadius:3,tension:0,spanGaps:true,order:0,fill:false},
    {type:"line",label:"BB Lower",data:bands.lower,borderColor:"rgba(41,98,255,.9)",backgroundColor:"rgba(41,98,255,.08)",borderWidth:1,pointRadius:0,pointHoverRadius:3,tension:0,borderJoinStyle:"round",spanGaps:true,order:0,fill:1}
  ]};
  const absMax=Math.max(1,...vals.map(v=>Math.abs(v||0)),...bands.upper.map(v=>Math.abs(v)),...bands.lower.map(v=>Math.abs(v)));
  const axis=Math.min(100,Math.max(10,Math.ceil(absMax*1.30/5)*5));
  // Only label a tick when the bar's direction (green/red) actually flips from the
  // previous bar — i.e. a new SPY-up/SPY-down run just started — instead of printing
  // a timestamp at every regularly-spaced tick regardless of what's happening.
  const xTickLabel=(value,index)=>{
    const row=marketRows[index];
    if(!row) return "";
    if(index===0) return labels[index];
    const prevRow=marketRows[index-1];
    if(prevRow && row.marketDir!==0 && row.marketDir!==prevRow.marketDir) return labels[index];
    return "";
  };
  const options={responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:"index",intersect:false},plugins:{legend:{display:true,labels:{color:"#c8d7e5",boxWidth:12,font:{family:"Courier New",size:10}}},tooltip:{callbacks:{label:c=>{
      if(c.dataset.type!=="bar") return `${c.dataset.label}: ${Number(c.raw).toFixed(1)}%`;
      const row=marketRows[c.dataIndex]||{};
      const dir=row.marketDir>0?"SPY UP":row.marketDir<0?"SPY DOWN":"SPY FLAT";
      return [`${dir} · bar ${Number(c.raw).toFixed(1)}%`,`Raw GEX ratio: ${Number(row.r||0)>=0?"+":""}${Number(row.r||0).toFixed(1)}%`];
    }}}},scales:{x:{grid:{display:false},ticks:{color:"#8ea4b8",font:{family:"Courier New",size:9},autoSkip:false,maxRotation:0,callback:xTickLabel}},y:{min:-axis,max:axis,grid:{color:"rgba(26,40,64,.72)"},ticks:{color:"#9fb4c8",font:{family:"Courier New",size:9},callback:v=>`${v}%`},title:{display:true,text:"Signed GEX Ratio (%)",color:"#9fb4c8",font:{family:"Courier New",size:10}}}}};
  if(chartGexRatio){
    try{
      chartGexRatio.data=data;
      chartGexRatio.options=options;
      chartGexRatio.update("none");
      chartGexRatio.resize();
    }catch(err){
      console.error("GEX ratio chart update failed:",err);
      try{chartGexRatio.destroy();}catch(_){}
      chartGexRatio=null;
    }
  }
  if(!chartGexRatio) {
    try{
      chartGexRatio=new Chart(canvas.getContext("2d"),{
        type:"bar",
        data,
        options,
        plugins:[zeroLine]
      });
    }catch(err){
      console.error("GEX ratio chart render failed:",err);
      if(statusEl){
        statusEl.textContent=`GEX ratio chart render error: ${err?.message||err}`;
        statusEl.style.color="var(--red)";
      }
      return;
    }
  }

  const lastIndex=bands.upper.length-1, upper=bands.upper[lastIndex], mid=bands.mid[lastIndex], lower=bands.lower[lastIndex];
  const set=(id,val,color)=>{const e=document.getElementById(id);if(!e)return;e.textContent=val;if(color)e.style.color=color;};
  set("gexr-current",`${ratio>=0?"+":""}${ratio.toFixed(1)}%`,ratio>5?"var(--green)":ratio<-5?"var(--red)":"var(--amber)");
  set("gexr-upper",`${upper.toFixed(1)}%`,"#c084fc"); set("gexr-mid",`${mid.toFixed(1)}%`,"#fbbf24"); set("gexr-lower",`${lower.toFixed(1)}%`,"#c084fc");
  set("gexr-count",`${gexRatioHistory.length} pts`,"#c8d7e5");
  if(timeEl)timeEl.textContent=`RATIO UPDATED ${etNow()} ET`;
  if(statusEl){
    const bias=ratio>10?"CALL GEX DOMINANT":ratio<-10?"PUT GEX DOMINANT":"GEX BALANCED";
    const bb=ratio>upper?" · ABOVE UPPER BB":ratio<lower?" · BELOW LOWER BB":" · INSIDE BB";
    const fmt=v=>{const a=Math.abs(v);if(a>=1e9)return `$${(a/1e9).toFixed(2)}B`;if(a>=1e6)return `$${(a/1e6).toFixed(1)}M`;if(a>=1e3)return `$${(a/1e3).toFixed(0)}K`;return a.toFixed(2);};
    statusEl.textContent=`${bias}${bb} · ${sourceLabel} · CALL ${fmt(call)} / PUT ${fmt(put)} · ${expiry} · ${gexRatioIntervalLabel(GEX_RATIO_BUCKET_MS)} buckets`;
    statusEl.style.color=ratio>10?"var(--green)":ratio<-10?"var(--red)":"var(--amber)";
  }
}

function renderAll(){
  if(!chain.length) return;
  const calls=chain.filter(c=>c.details?.contract_type==="call");
  const puts =chain.filter(c=>c.details?.contract_type==="put");

  const cVol  =calls.reduce((s,c)=>s+(c.day?.volume??0),0);
  const pVol  =puts.reduce((s,c)=>s+(c.day?.volume??0),0);
  const cPrem =calls.reduce((s,c)=>s+rowP(c),0);
  const pPrem =puts.reduce((s,c)=>s+rowP(c),0);
  const cOI   =calls.reduce((s,c)=>s+(c.open_interest??0),0);
  const pOI   =puts.reduce((s,c)=>s+(c.open_interest??0),0);
  const cDelta=calls.reduce((s,c)=>s+(c.greeks?.delta??0)*(c.day?.volume??0)*100,0);
  const pDelta=puts.reduce((s,c)=>s+Math.abs(c.greeks?.delta??0)*(c.day?.volume??0)*100,0);
  const cGamma=calls.reduce((s,c)=>s+(c.greeks?.gamma??0)*(c.day?.volume??0)*100,0);
  const pGamma=puts.reduce((s,c)=>s+(c.greeks?.gamma??0)*(c.day?.volume??0)*100,0);
  const netD  =cDelta-pDelta, pcR=pVol/(cVol||1);

  const vI =(cVol-pVol)/(cVol+pVol||1);
  const prI=(cPrem-pPrem)/(cPrem+pPrem||1);
  const dI =(cDelta-pDelta)/(cDelta+pDelta||1);
  const oI =(cOI-pOI)/(cOI+pOI||1);
  const pcI=(1-pcR)/(1+pcR);
  const score=vI*.25+prI*.30+dI*.25+oI*.10+pcI*.10;
  const abs=Math.abs(score);

  // signal
  let lbl,col,bg;
  if(score>.25){lbl="BULLISH";col="#34d399";bg="rgba(52,211,153,.07)";}
  else if(score>.08){lbl="SLIGHT BULL";col="#6ee7b7";bg="rgba(52,211,153,.04)";}
  else if(score<-.25){lbl="BEARISH";col="#f87171";bg="rgba(248,113,113,.07)";}
  else if(score<-.08){lbl="SLIGHT BEAR";col="#fca5a5";bg="rgba(248,113,113,.04)";}
  else{lbl="BALANCED";col="#fbbf24";bg="rgba(251,191,36,.05)";}
  document.getElementById("sig-dir").textContent=lbl; document.getElementById("sig-dir").style.color=col;
  document.getElementById("sig-sub").textContent=`Score: ${(score*100).toFixed(1)} · P/C ${pcR.toFixed(2)}`;
  document.getElementById("sig-str").textContent=`Strength: ${"█".repeat(Math.round(abs*10))}${"░".repeat(10-Math.round(abs*10))} ${(abs*100).toFixed(0)}%`;
  document.getElementById("sig-str").style.color=col;
  const sb=document.getElementById("signal-box"); sb.style.background=bg; sb.style.borderColor=col+"30";

  // imb bars
  setBar("b-vol","bv-vol",vI,`${(vI*100).toFixed(1)}%`);
  setBar("b-prem","bv-prem",prI,`${(prI*100).toFixed(1)}%`);
  setBar("b-delta","bv-delta",dI,`${(dI*100).toFixed(1)}%`);
  setBar("b-oi","bv-oi",oI,`${(oI*100).toFixed(1)}%`);
  setBar("b-pc","bv-pc",(1-pcR)/(1+pcR),pcR.toFixed(2));

  // meters
  setMeter("m-put","m-call",vI);
  setMeter("pm-put","pm-call",prI);

  // strike ladder
  const byS={};
  calls.forEach(c=>{const s=c.details?.strike_price;if(!s)return;if(!byS[s])byS[s]={s,cv:0,pv:0};byS[s].cv+=c.day?.volume??0;});
  puts.forEach(c=>{const s=c.details?.strike_price;if(!s)return;if(!byS[s])byS[s]={s,cv:0,pv:0};byS[s].pv+=c.day?.volume??0;});
  const ladder=Object.values(byS).sort((a,b)=>b.s-a.s);
  const mxV=Math.max(...ladder.map(r=>Math.max(r.cv,r.pv)),1);
  const ld=document.getElementById("strike-ladder"); ld.innerHTML="";
  ladder.filter(r=>!spyPrice||Math.abs(r.s-spyPrice)<=20).forEach(r=>{
    const isATM=spyPrice&&Math.abs(r.s-spyPrice)<1.5;
    const cw=(r.cv/mxV*48).toFixed(1), pw=(r.pv/mxV*48).toFixed(1);
    const imb=r.cv+r.pv>0?(r.cv-r.pv)/(r.cv+r.pv):0;
    const c2=imb>.2?"#34d399":imb<-.2?"#f87171":"#fbbf24";
    const div=document.createElement("div"); div.className="sk-row"+(isATM?" sk-atm":"");
    div.style.border=isATM?"1px solid rgba(56,189,248,.25)":"1px solid transparent";
    div.innerHTML=`<span class="sk-lbl" style="color:${c2}">$${r.s}</span>
      <div class="sk-track"><div class="sk-put" style="width:${pw}%"></div><div class="sk-call" style="width:${cw}%"></div><div class="sk-mid"></div></div>
      <span class="sk-vols" style="color:${c2}">C${fN(r.cv)} P${fN(r.pv)}</span>
      ${isATM?'<span class="mono" style="font-size:8px;color:var(--accent);flex-shrink:0">◄ATM</span>':''}`;
    ld.appendChild(div);
  });

  // Individual live $300K+ prints classified against live option NBBO
  renderPressureTape();

  // flow tape
  renderFlowTape();
  if(document.getElementById("tc-chart")?.classList.contains("on")) scheduleFlowCandleLabels();

  // premium tab
  document.getElementById("cp-total").textContent=fD(cPrem);
  document.getElementById("pp-total").textContent=fD(pPrem);
  document.getElementById("cp-ct").textContent=`${calls.length} call contracts`;
  document.getElementById("pp-ct").textContent=`${puts.length} put contracts`;
  document.getElementById("cp-avg").textContent=`avg ${fD(calls.length?cPrem/calls.length:0)} each`;
  document.getElementById("pp-avg").textContent=`avg ${fD(puts.length?pPrem/puts.length:0)} each`;
  const wh=chain.filter(c=>rowP(c)>=500000).sort((a,b)=>rowP(b)-rowP(a));
  document.getElementById("wh-lbl").textContent=`🐋 WHALE BLOCKS ≥$500K (${wh.length})`;
  renderRows("wh-body",wh,"No whale blocks yet — may appear during peak hours");

  // The Intelligence, Net Delta, Net GEX and Net VEX panels were removed.
  // Keep only the Premium-tab summaries and the remaining chart work on the
  // live refresh path so those hidden analytics no longer consume render time.
  {
    const callVolumeTotal=cVol||1, putVolumeTotal=pVol||1;
    const weightedCallStrike=calls.reduce((sum,c)=>sum+(c.details?.strike_price??0)*(c.day?.volume??0),0)/callVolumeTotal;
    const weightedCallPrice=calls.reduce((sum,c)=>sum+(c.last_trade?.price??0)*(c.day?.volume??0),0)/callVolumeTotal;
    const callItmVolume=calls.reduce((sum,c)=>spyPrice&&(c.details?.strike_price??0)<spyPrice?sum+(c.day?.volume??0):sum,0);
    const callItmFraction=cVol>0?callItmVolume/cVol:0;
    const callTheta=calls.reduce((sum,c)=>sum+Math.abs(c.greeks?.theta??0)*(c.day?.volume??0)*100,0);
    const largestCall=calls.reduce((best,c)=>{const premium=rowP(c);return premium>(best?.prem??0)?{strike:c.details?.strike_price,prem:premium}:best;},null);
    const callIvWeighted=calls.reduce((sum,c)=>sum+(c.implied_volatility??0)*(c.day?.volume??0),0)/callVolumeTotal;

    document.getElementById("cp-wacp").textContent=weightedCallPrice>0?`$${weightedCallPrice.toFixed(2)} avg · $${weightedCallStrike.toFixed(1)} center`:"—";
    document.getElementById("cp-itm-fill").style.width=(callItmFraction*100).toFixed(1)+"%";
    document.getElementById("cp-itm").textContent=`ITM ${(callItmFraction*100).toFixed(0)}%`;
    document.getElementById("cp-otm").textContent=`OTM ${((1-callItmFraction)*100).toFixed(0)}%`;
    document.getElementById("cp-theta").textContent=callTheta>0?fD(callTheta)+"/day":"—";
    document.getElementById("cp-largest").textContent=largestCall?.prem>0?`${fD(largestCall.prem)} @ $${largestCall.strike}`:"—";
    document.getElementById("cp-iv").textContent=callIvWeighted>0?(callIvWeighted*100).toFixed(1)+"%":"—";
    document.getElementById("cp-iv-sub").textContent=callIvWeighted>0?(callIvWeighted>.45?"🔴 elevated — speculative flow":callIvWeighted>.3?"🟡 normal call IV":"🟢 low call IV"):"";

    const weightedPutStrike=puts.reduce((sum,c)=>sum+(c.details?.strike_price??0)*(c.day?.volume??0),0)/putVolumeTotal;
    const weightedPutPrice=puts.reduce((sum,c)=>sum+(c.last_trade?.price??0)*(c.day?.volume??0),0)/putVolumeTotal;
    const putItmVolume=puts.reduce((sum,c)=>spyPrice&&(c.details?.strike_price??0)>spyPrice?sum+(c.day?.volume??0):sum,0);
    const putItmFraction=pVol>0?putItmVolume/pVol:0;
    const putTheta=puts.reduce((sum,c)=>sum+Math.abs(c.greeks?.theta??0)*(c.day?.volume??0)*100,0);
    const largestPut=puts.reduce((best,c)=>{const premium=rowP(c);return premium>(best?.prem??0)?{strike:c.details?.strike_price,prem:premium}:best;},null);
    const putIvWeighted=puts.reduce((sum,c)=>sum+(c.implied_volatility??0)*(c.day?.volume??0),0)/putVolumeTotal;

    document.getElementById("pp-wapp").textContent=weightedPutPrice>0?`$${weightedPutPrice.toFixed(2)} avg · $${weightedPutStrike.toFixed(1)} center`:"—";
    document.getElementById("pp-itm-fill").style.width=(putItmFraction*100).toFixed(1)+"%";
    document.getElementById("pp-itm").textContent=`ITM ${(putItmFraction*100).toFixed(0)}%`;
    document.getElementById("pp-otm").textContent=`OTM ${((1-putItmFraction)*100).toFixed(0)}%`;
    document.getElementById("pp-theta").textContent=putTheta>0?fD(putTheta)+"/day":"—";
    document.getElementById("pp-largest").textContent=largestPut?.prem>0?`${fD(largestPut.prem)} @ $${largestPut.strike}`:"—";
    document.getElementById("pp-iv").textContent=putIvWeighted>0?(putIvWeighted*100).toFixed(1)+"%":"—";
    document.getElementById("pp-iv-sub").textContent=putIvWeighted>0?(putIvWeighted>.45?"🔴 elevated — heavy hedging":putIvWeighted>.3?"🟡 normal put IV":"🟢 low put IV"):"";

    updatePremiumWallDisplays(calls,puts);
    renderCharts(calls,puts);

    // The GEX Ratio Histogram (still a live, visible panel) needs the same
    // call/put GEX totals that used to be computed further down in the
    // Intelligence/Net-GEX block below. That whole block is skipped by the
    // `return` right after this one (its own panels are hidden), which meant
    // updateGexRatioHistogram() was never being called and the histogram
    // stayed permanently blank. Compute just what it needs here instead.
    const cGammaForRatio = calls.reduce((s,c)=>s+(c.greeks?.gamma??0)*(c.day?.volume??0)*100,0);
    const pGammaForRatio = puts.reduce((s,c)=>s+(c.greeks?.gamma??0)*(c.day?.volume??0)*100,0);
    const S2ForRatio = spyPrice ? spyPrice*spyPrice/100 : 1;
    let totalCallGEXForRatio = 0, totalPutGEXForRatio = 0;
    calls.forEach(c=>{
      const s=c.details?.strike_price; if(!s) return;
      totalCallGEXForRatio += (c.greeks?.gamma??0)*(c.open_interest??0)*100*S2ForRatio;
    });
    puts.forEach(c=>{
      const s=c.details?.strike_price; if(!s) return;
      totalPutGEXForRatio += (c.greeks?.gamma??0)*(c.open_interest??0)*100*S2ForRatio;
    });
    updateGexRatioHistogram(totalCallGEXForRatio,totalPutGEXForRatio,cGammaForRatio,Math.abs(pGammaForRatio));
  }
  return;

  // ─── Put Intelligence metrics ──────────────────────────────────────────────
  const pVolTot = pVol || 1;
  const cVolTot = cVol || 1;

  // ─── Call Intelligence metrics ─────────────────────────────────────────────
  // Call Wall: max OI strike
  const callWall = calls.reduce((best,c) => {
    const oi = c.open_interest ?? 0;
    return oi > (best?.oi ?? 0) ? { strike: c.details?.strike_price, oi } : best;
  }, null);

  // Volume-weighted avg call strike & price (WACP)
  const waCallStrike = calls.reduce((s,c) => s + (c.details?.strike_price??0)*(c.day?.volume??0),0) / cVolTot;
  const waCallPrice  = calls.reduce((s,c) => s + (c.last_trade?.price??0)*(c.day?.volume??0),0) / cVolTot;

  // ITM vs OTM calls (ITM call = strike < spyPrice)
  const itmCallVol = calls.reduce((s,c) => spyPrice&&(c.details?.strike_price??0)<spyPrice ? s+(c.day?.volume??0) : s, 0);
  const cITMFrac   = cVol > 0 ? itmCallVol / cVol : 0;

  // Call theta burn / day
  const cTheta = calls.reduce((s,c) => s + Math.abs(c.greeks?.theta??0)*(c.day?.volume??0)*100, 0);

  // Largest single call block
  const largestCall = calls.reduce((best,c) => {
    const p=rowP(c); return p>(best?.prem??0)?{strike:c.details?.strike_price,prem:p}:best;
  }, null);

  // Avg call IV (vol-weighted)
  const cIVW = calls.reduce((s,c) => s + (c.implied_volatility??0)*(c.day?.volume??0),0) / cVolTot;

  // Call sweeps (vol/OI >= 2x)
  const callSweeps = calls
    .filter(c => (c.open_interest??0)>0 && (c.day?.volume??0)/c.open_interest >= 2)
    .sort((a,b) => (b.day?.volume??0)/(b.open_interest||1) - (a.day?.volume??0)/(a.open_interest||1));

  // Top 5 call strikes by OI
  const topCallOI = [...calls].filter(c=>(c.open_interest??0)>0)
    .sort((a,b)=>(b.open_interest??0)-(a.open_interest??0)).slice(0,5);

  // Top 3 call strikes by aggregate ask in $ (ask × ask_size × 100 = notional)
  const askNotional = c => (c.last_quote?.ask??0) * (c.last_quote?.ask_size??0) * 100;
  // Dollar-notional of OI = (last price ?? midpoint) × OI × 100
  const oiNotional  = c => (c.last_trade?.price ?? c.last_quote?.midpoint ?? 0) * (c.open_interest??0) * 100;
  const topCallAsk = [...calls].filter(c => askNotional(c) > 0)
    .sort((a,b) => askNotional(b) - askNotional(a))
    .slice(0,3);

  // ── Populate premium tab call card extras ─────────────────────────────────
  // NOTE: #cw-strike/#cw-oi/#cw-dist don't exist in this build's DOM (that mini
  // card was removed from the HTML). Left unguarded, getElementById() returned
  // null and the .textContent assignment threw, which silently aborted the
  // rest of renderAll() — including the GEX Ratio Histogram update further
  // down. Guarding each lookup keeps this harmless if those elements ever
  // come back, without changing any other behavior.
  if(callWall){
    const cwStrikeEl = document.getElementById("cw-strike");
    if(cwStrikeEl) cwStrikeEl.textContent = "$"+callWall.strike;
    const cwOiEl = document.getElementById("cw-oi");
    if(cwOiEl) cwOiEl.textContent = "OI: "+fN(callWall.oi)+" contracts";
    const dist = spyPrice ? (callWall.strike - spyPrice).toFixed(2) : null;
    const dEl  = document.getElementById("cw-dist");
    if(dEl){
      dEl.textContent = dist ? (dist>0 ? "\u25b2 $"+dist+" above SPY" : "\u25bc $"+Math.abs(dist)+" below SPY") : "";
      dEl.style.color = dist>0 ? "var(--green)" : "var(--red)";
    }
  }
  document.getElementById("cp-wacp").textContent = waCallPrice>0 ? "$"+waCallPrice.toFixed(2)+" avg \xb7 $"+waCallStrike.toFixed(1)+" center" : "\u2014";
  document.getElementById("cp-itm-fill").style.width = (cITMFrac*100).toFixed(1)+"%";
  document.getElementById("cp-itm").textContent = "ITM "+(cITMFrac*100).toFixed(0)+"%";
  document.getElementById("cp-otm").textContent  = "OTM "+((1-cITMFrac)*100).toFixed(0)+"%";
  document.getElementById("cp-theta").textContent = cTheta>0 ? fD(cTheta)+"/day" : "\u2014";
  document.getElementById("cp-largest").textContent = largestCall?.prem>0 ? fD(largestCall.prem)+" @ $"+largestCall.strike : "\u2014";
  document.getElementById("cp-iv").textContent = cIVW>0 ? (cIVW*100).toFixed(1)+"%" : "\u2014";
  const cIVLabel = cIVW>.45?"🔴 elevated \u2014 speculative flow":cIVW>.3?"🟡 normal call IV":"🟢 low call IV";
  document.getElementById("cp-iv-sub").textContent = cIVW>0 ? cIVLabel : "";

  // ── Populate CALL INTELLIGENCE panel ─────────────────────────────────────
  if(callWall){
    document.getElementById("ci-wall").textContent = "$"+callWall.strike;
    document.getElementById("ci-wall-sub").textContent = "OI: "+fN(callWall.oi)+" \xb7 key resistance";
  }
  document.getElementById("ci-sweeps").textContent = callSweeps.length || "0";
  document.getElementById("ci-sweeps").style.color = callSweeps.length>=3?"var(--green)":callSweeps.length>=1?"var(--amber)":"var(--dim)";
  document.getElementById("ci-wastr").textContent = waCallStrike>0 ? "$"+waCallStrike.toFixed(1) : "\u2014";
  document.getElementById("ci-iv").textContent = cIVW>0 ? (cIVW*100).toFixed(1)+"%" : "\u2014";
  document.getElementById("ci-iv-sub").textContent = cIVW>.45?"elevated \xb7 speculation":cIVW>.3?"normal":"low call IV";

  // Top call OI bar chart
  const topCOIEl = document.getElementById("ci-top-oi"); topCOIEl.innerHTML="";
  const maxTopCOI = Math.max(...topCallOI.map(c=>c.open_interest??0), 1);
  topCallOI.forEach(c => {
    const oi=c.open_interest??0, pct=(oi/maxTopCOI*100).toFixed(1);
    const isWall = callWall && c.details?.strike_price === callWall.strike;
    const dist   = spyPrice ? (+(c.details?.strike_price??0) - spyPrice).toFixed(1) : null;
    const notional = oiNotional(c);
    const row = document.createElement("div");
    row.style.cssText="display:flex;align-items:center;gap:8px;margin-bottom:5px";
    row.innerHTML="<span class='mono' style='font-size:9px;width:48px;text-align:right;color:"+(isWall?"var(--green)":"var(--text)")+";font-weight:"+(isWall?700:400)+"'>$"+c.details?.strike_price+"</span>"
      +"<div style='flex:1;height:9px;background:var(--dim);border-radius:2px;position:relative;overflow:hidden'>"
      +"<div style='position:absolute;left:0;top:0;height:100%;width:"+pct+"%;background:"+(isWall?"rgba(52,211,153,.9)":"rgba(52,211,153,.5)")+";border-radius:2px;transition:width .5s'></div></div>"
      +"<span class='mono' style='font-size:9px;width:74px;text-align:right;color:"+(isWall?"var(--green)":"var(--bright)")+";font-weight:"+(isWall?700:600)+"'>"
      +(notional>0?fD(notional):"\u2014")
      +"</span>"
      +"<span class='mono' style='font-size:8px;width:80px;color:"+(isWall?"var(--green)":"var(--dim)")+"'>"
      +fN(oi)+" OI"+(isWall?" \ud83e\uddf1":"")+(dist?" \xb7"+(+dist>=0?"\u25b2":"\u25bc")+Math.abs(dist):"")+
      "</span>";
    topCOIEl.appendChild(row);
  });
  if(!topCallOI.length) topCOIEl.innerHTML="<div style='font-family:Courier New,monospace;font-size:10px;color:var(--dim);padding:8px 0'>No call OI data yet</div>";

  // Top 3 call aggregate ask in $
  const topCAskEl = document.getElementById("ci-top-ask"); topCAskEl.innerHTML="";
  const maxCAskN = Math.max(...topCallAsk.map(askNotional), 1);
  topCallAsk.forEach(c => {
    const sz = c.last_quote?.ask_size??0;
    const ask = c.last_quote?.ask;
    const notional = askNotional(c);
    const pct = (notional/maxCAskN*100).toFixed(1);
    const row = document.createElement("div");
    row.style.cssText="display:flex;align-items:center;gap:8px;margin-bottom:5px";
    row.innerHTML="<span class='mono' style='font-size:9px;width:48px;text-align:right;color:var(--green);font-weight:700'>$"+c.details?.strike_price+"</span>"
      +"<div style='flex:1;height:9px;background:var(--dim);border-radius:2px;position:relative;overflow:hidden'>"
      +"<div style='position:absolute;left:0;top:0;height:100%;width:"+pct+"%;background:rgba(52,211,153,.55);border-radius:2px;transition:width .5s'></div></div>"
      +"<span class='mono' style='font-size:9px;width:90px;color:var(--green);font-weight:700;text-align:right'>"
      +fD(notional)
      +"</span>"
      +"<span class='mono' style='font-size:8px;width:78px;color:var(--dim)'>"
      +fN(sz)+"\xd7"+(ask!=null?" @ $"+(+ask).toFixed(2):"")
      +"</span>";
    topCAskEl.appendChild(row);
  });
  if(!topCallAsk.length) topCAskEl.innerHTML="<div style='font-family:Courier New,monospace;font-size:10px;color:var(--dim);padding:8px 0'>No quote depth data yet</div>";

  // Call sweep list
  const cSwpBox = document.getElementById("ci-sweep-box");
  if(callSweeps.length>0){
    cSwpBox.style.display="block";
    const cSwpList = document.getElementById("ci-sweep-list"); cSwpList.innerHTML="";
    callSweeps.slice(0,6).forEach(c => {
      const ratio=((c.day?.volume??0)/(c.open_interest||1)).toFixed(1);
      const div=document.createElement("div");
      div.style.cssText="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)";
      div.innerHTML="<span style='color:var(--green);font-size:11px'>\u25b2</span>"
        +"<span class='mono' style='font-size:9px;color:var(--green);font-weight:700'>$"+c.details?.strike_price+"</span>"
        +"<span class='mono' style='font-size:8px;color:var(--text);flex:1'>Vol "+fN(c.day?.volume??0)+" / OI "+fN(c.open_interest??0)+"</span>"
        +"<span class='mono' style='font-size:9px;color:var(--amber);font-weight:700'>"+ratio+"\xd7 sweep</span>"
        +(rowP(c)>=100000?"<span class='mono' style='font-size:8px;color:var(--amber)'>"+fD(rowP(c))+"</span>":"");
      cSwpList.appendChild(div);
    });
  } else { cSwpBox.style.display="none"; }

  // Put Wall: max OI strike
  const putWall = puts.reduce((best,c) => {
    const oi = c.open_interest ?? 0;
    return oi > (best?.oi ?? 0) ? { strike: c.details?.strike_price, oi } : best;
  }, null);

  // Volume-weighted avg put strike & price
  const waPutStrike = puts.reduce((s,c) => s + (c.details?.strike_price??0)*(c.day?.volume??0),0) / pVolTot;
  const waPutPrice  = puts.reduce((s,c) => s + (c.last_trade?.price??0)*(c.day?.volume??0),0) / pVolTot;

  // ITM vs OTM puts (ITM = strike > spyPrice)
  const itmPutVol = puts.reduce((s,c) => spyPrice&&(c.details?.strike_price??0)>spyPrice ? s+(c.day?.volume??0) : s, 0);
  const otmPutVol = pVol - itmPutVol;
  const itmFrac   = pVol > 0 ? itmPutVol / pVol : 0;

  // Theta burn / day (sum |theta| * vol * 100)
  const pTheta = puts.reduce((s,c) => s + Math.abs(c.greeks?.theta??0)*(c.day?.volume??0)*100, 0);

  // Largest single put block by premium
  const largestPut = puts.reduce((best,c) => {
    const p=rowP(c); return p>(best?.prem??0)?{strike:c.details?.strike_price,prem:p}:best;
  }, null);

  // Avg put IV (vol-weighted)
  const pIVW = puts.reduce((s,c) => s + (c.implied_volatility??0)*(c.day?.volume??0),0) / pVolTot;

  // Put sweeps (vol/OI ≥ 2×)
  const putSweeps = puts
    .filter(c => (c.open_interest??0)>0 && (c.day?.volume??0)/c.open_interest >= 2)
    .sort((a,b) => (b.day?.volume??0)/(b.open_interest||1) - (a.day?.volume??0)/(a.open_interest||1));

  // Top 5 put strikes by OI
  const topPutOI = [...puts].filter(c=>(c.open_interest??0)>0)
    .sort((a,b)=>(b.open_interest??0)-(a.open_interest??0)).slice(0,5);

  // Top 3 put strikes by aggregate ask in $ (ask × ask_size × 100 = notional)
  // (askNotional helper defined in the call block above)
  const topPutAsk = [...puts].filter(c => askNotional(c) > 0)
    .sort((a,b) => askNotional(b) - askNotional(a))
    .slice(0,3);

  // ── Populate premium tab put card extras ──────────────────────────────────
  document.getElementById("pp-wapp").textContent = waPutPrice > 0 ? `$${waPutPrice.toFixed(2)} avg · $${waPutStrike.toFixed(1)} center` : "—";
  document.getElementById("pp-itm-fill").style.width = (itmFrac*100).toFixed(1)+"%";
  document.getElementById("pp-itm").textContent = `ITM ${(itmFrac*100).toFixed(0)}%`;
  document.getElementById("pp-otm").textContent  = `OTM ${((1-itmFrac)*100).toFixed(0)}%`;
  document.getElementById("pp-theta").textContent = pTheta>0 ? fD(pTheta)+"/day" : "—";
  document.getElementById("pp-largest").textContent = largestPut?.prem > 0 ? `${fD(largestPut.prem)} @ $${largestPut.strike}` : "—";
  document.getElementById("pp-iv").textContent = pIVW>0 ? (pIVW*100).toFixed(1)+"%" : "—";
  const ivLabel = pIVW>.45?"🔴 elevated — heavy hedging":pIVW>.3?"🟡 normal put IV":"🟢 low put IV";
  document.getElementById("pp-iv-sub").textContent = pIVW>0 ? ivLabel : "";

  // ── Populate PUT INTELLIGENCE panel ───────────────────────────────────────
  if(putWall){
    document.getElementById("pi-wall").textContent = "$"+putWall.strike;
    document.getElementById("pi-wall-sub").textContent = `OI: ${fN(putWall.oi)} · key support`;
  }
  document.getElementById("pi-sweeps").textContent = putSweeps.length || "0";
  document.getElementById("pi-sweeps").style.color = putSweeps.length>=3?"var(--red)":putSweeps.length>=1?"var(--amber)":"var(--dim)";
  document.getElementById("pi-wastr").textContent = waPutStrike>0 ? "$"+waPutStrike.toFixed(1) : "—";
  document.getElementById("pi-iv").textContent = pIVW>0 ? (pIVW*100).toFixed(1)+"%" : "—";
  document.getElementById("pi-iv-sub").textContent = pIVW>.45?"elevated · downside hedging":pIVW>.3?"normal":"low put IV";

  // Top put OI bar chart
  const topOIEl = document.getElementById("pi-top-oi"); topOIEl.innerHTML="";
  const maxTopOI = Math.max(...topPutOI.map(c=>c.open_interest??0), 1);
  topPutOI.forEach(c => {
    const oi = c.open_interest??0, pct=(oi/maxTopOI*100).toFixed(1);
    const isWall = putWall && c.details?.strike_price === putWall.strike;
    const dist   = spyPrice ? (spyPrice - (c.details?.strike_price??0)).toFixed(1) : null;
    const notional = oiNotional(c);
    const row = document.createElement("div");
    row.style.cssText="display:flex;align-items:center;gap:8px;margin-bottom:5px";
    row.innerHTML=`
      <span class="mono" style="font-size:9px;width:48px;text-align:right;color:${isWall?"var(--red)":"var(--text)"};font-weight:${isWall?700:400}">$${c.details?.strike_price}</span>
      <div style="flex:1;height:9px;background:var(--dim);border-radius:2px;position:relative;overflow:hidden">
        <div style="position:absolute;left:0;top:0;height:100%;width:${pct}%;background:${isWall?"rgba(248,113,113,.9)":"rgba(248,113,113,.5)"};border-radius:2px;transition:width .5s"></div>
      </div>
      <span class="mono" style="font-size:9px;width:74px;text-align:right;color:${isWall?"var(--red)":"var(--bright)"};font-weight:${isWall?700:600}">${notional>0?fD(notional):"\u2014"}</span>
      <span class="mono" style="font-size:8px;width:80px;color:${isWall?"var(--red)":"var(--dim)"}">
        ${fN(oi)} OI${isWall?" 🧱":""}${dist?" ·"+(dist>0?"▲":"▼")+Math.abs(dist):""}
      </span>`;
    topOIEl.appendChild(row);
  });
  if(!topPutOI.length) topOIEl.innerHTML='<div style="font-family:Courier New,monospace;font-size:10px;color:var(--dim);padding:8px 0">No put OI data yet</div>';

  // Top 3 put aggregate ask in $
  const topPAskEl = document.getElementById("pi-top-ask"); topPAskEl.innerHTML="";
  const maxPAskN = Math.max(...topPutAsk.map(askNotional), 1);
  topPutAsk.forEach(c => {
    const sz = c.last_quote?.ask_size??0;
    const ask = c.last_quote?.ask;
    const notional = askNotional(c);
    const pct = (notional/maxPAskN*100).toFixed(1);
    const row = document.createElement("div");
    row.style.cssText="display:flex;align-items:center;gap:8px;margin-bottom:5px";
    row.innerHTML=`
      <span class="mono" style="font-size:9px;width:48px;text-align:right;color:var(--red);font-weight:700">$${c.details?.strike_price}</span>
      <div style="flex:1;height:9px;background:var(--dim);border-radius:2px;position:relative;overflow:hidden">
        <div style="position:absolute;left:0;top:0;height:100%;width:${pct}%;background:rgba(248,113,113,.55);border-radius:2px;transition:width .5s"></div>
      </div>
      <span class="mono" style="font-size:9px;width:90px;color:var(--red);font-weight:700;text-align:right">${fD(notional)}</span>
      <span class="mono" style="font-size:8px;width:78px;color:var(--dim)">${fN(sz)}\xd7${ask!=null?" @ $"+(+ask).toFixed(2):""}</span>`;
    topPAskEl.appendChild(row);
  });
  if(!topPutAsk.length) topPAskEl.innerHTML='<div style="font-family:Courier New,monospace;font-size:10px;color:var(--dim);padding:8px 0">No quote depth data yet</div>';

  // Put sweep list
  const swpBox = document.getElementById("pi-sweep-box");
  if(putSweeps.length>0){
    swpBox.style.display="block";
    const swpList = document.getElementById("pi-sweep-list"); swpList.innerHTML="";
    putSweeps.slice(0,6).forEach(c => {
      const ratio = ((c.day?.volume??0)/(c.open_interest||1)).toFixed(1);
      const div   = document.createElement("div");
      div.style.cssText="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)";
      div.innerHTML=`
        <span style="color:var(--red);font-size:11px">▼</span>
        <span class="mono" style="font-size:9px;color:var(--red);font-weight:700">$${c.details?.strike_price}</span>
        <span class="mono" style="font-size:8px;color:var(--text);flex:1">Vol ${fN(c.day?.volume??0)} / OI ${fN(c.open_interest??0)}</span>
        <span class="mono" style="font-size:9px;color:var(--amber);font-weight:700">${ratio}× sweep</span>
        ${rowP(c)>=100000?'<span class="mono" style="font-size:8px;color:var(--amber)">'+fD(rowP(c))+'</span>':""}`;
      swpList.appendChild(div);
    });
  } else { swpBox.style.display="none"; }
  document.getElementById("nd-call").textContent=fNS(cDelta);
  document.getElementById("nd-put").textContent=fNS(pDelta);
  document.getElementById("nd-cs").textContent="positive delta from calls";
  document.getElementById("nd-ps").textContent="negative delta from puts";
  document.getElementById("nd-net").textContent=(netD>=0?"+":"")+fNS(netD);
  document.getElementById("nd-net").style.color=netD>0?"var(--green)":netD<0?"var(--red)":"var(--amber)";
  document.getElementById("nd-bias").textContent=netD>0?"Net long (bullish)":netD<0?"Net short (bearish)":"Neutral";
  document.getElementById("nd-bias").style.color=netD>0?"var(--green)":netD<0?"var(--red)":"var(--amber)";
  document.getElementById("nd-gamma").textContent=fNS(cGamma+pGamma);

  updatePremiumWallDisplays(calls, puts);

  // ── NET GEX ──────────────────────────────────────────────────────────────────
  // GEX = gamma × OI × 100 × S²/100  (per contract, $-notional)
  // Calls: dealers typically short calls → long gamma → positive GEX
  // Puts:  dealers typically long puts  → short gamma → negative GEX
  const S2 = spyPrice ? spyPrice * spyPrice / 100 : 1;
  const gexByStrike = {};
  calls.forEach(c => {
    const s = c.details?.strike_price; if(!s) return;
    const g = (c.greeks?.gamma ?? 0) * (c.open_interest ?? 0) * 100 * S2;
    if(!gexByStrike[s]) gexByStrike[s] = {s, cg:0, pg:0};
    gexByStrike[s].cg += g;
  });
  puts.forEach(c => {
    const s = c.details?.strike_price; if(!s) return;
    const g = (c.greeks?.gamma ?? 0) * (c.open_interest ?? 0) * 100 * S2;
    if(!gexByStrike[s]) gexByStrike[s] = {s, cg:0, pg:0};
    gexByStrike[s].pg += g;
  });
  const gexRows = Object.values(gexByStrike).sort((a,b)=>b.s-a.s);
  const totalCallGEX = gexRows.reduce((t,r)=>t+r.cg, 0);
  const totalPutGEX  = gexRows.reduce((t,r)=>t+r.pg, 0);
  const netGEX = totalCallGEX - totalPutGEX;
  updateGexRatioHistogram(totalCallGEX,totalPutGEX,cGamma,Math.abs(pGamma));

  // Format GEX in $M / $B
  const fGEX = v => {
    const abs=Math.abs(v);
    const s=v>=0?"+":"-";
    if(abs>=1e9) return s+"$"+(abs/1e9).toFixed(2)+"B";
    if(abs>=1e6) return s+"$"+(abs/1e6).toFixed(0)+"M";
    return s+"$"+(abs/1e3).toFixed(0)+"K";
  };

  document.getElementById("gex-net").textContent = fGEX(netGEX);
  document.getElementById("gex-net").style.color = netGEX>0?"var(--green)":netGEX<0?"var(--red)":"var(--amber)";
  document.getElementById("gex-call").textContent = fGEX(totalCallGEX);
  document.getElementById("gex-put").textContent  = "-"+fGEX(totalPutGEX).replace(/^[+-]/,"");

  // GEX regime
  let gexRegime, gexSub;
  if(netGEX > 5e8)       { gexRegime="POSITIVE · PINNING";  gexSub="Dealers buying dips / selling rips\nExpect mean-reversion · tight range"; }
  else if(netGEX > 0)    { gexRegime="POSITIVE · MILD";     gexSub="Light dealer hedging dampens moves\nModerate drift possible"; }
  else if(netGEX > -5e8) { gexRegime="NEGATIVE · MILD";     gexSub="Dealers amplifying moves slightly\nWatch for momentum continuation"; }
  else                   { gexRegime="NEGATIVE · EXPLOSIVE"; gexSub="Dealers short gamma — fuel for big moves\nHigh risk of directional acceleration"; }
  document.getElementById("gex-regime").textContent = gexRegime;
  document.getElementById("gex-regime").style.color = netGEX>0?"var(--green)":"var(--red)";
  document.getElementById("gex-regime-sub").textContent = gexSub;
  document.getElementById("gex-net-sub").textContent = netGEX>0?"Dealers hedging stabilizes price":"Dealer hedging amplifies moves";
  document.getElementById("gex-net-sub").style.color = netGEX>0?"var(--green)":"var(--red)";

  // GEX by-strike ladder
  const gexLadder = document.getElementById("gex-ladder"); gexLadder.innerHTML="";
  const nearStrikes = gexRows.filter(r=>!spyPrice||Math.abs(r.s-spyPrice)<=20);
  const maxGEX = Math.max(...nearStrikes.map(r=>Math.max(r.cg,r.pg)),1);
  // find largest walls and flip point
  let bigCallWall=null, bigPutWall=null;
  let flipStrike=null, prevNetSign=null;
  // iterate top→bottom for flip detection
  const sorted4flip=[...gexRows].sort((a,b)=>b.s-a.s);
  for(const r of sorted4flip){
    const n=r.cg-r.pg;
    if(prevNetSign!==null && Math.sign(n)!==prevNetSign && !flipStrike)
      flipStrike=r.s;
    prevNetSign=Math.sign(n);
  }
  nearStrikes.forEach(r=>{
    if(!bigCallWall||r.cg>bigCallWall.cg) bigCallWall=r;
    if(!bigPutWall ||r.pg>bigPutWall.pg)  bigPutWall=r;
    const isATM=spyPrice&&Math.abs(r.s-spyPrice)<1.5;
    const cw=(r.cg/maxGEX*48).toFixed(1), pw=(r.pg/maxGEX*48).toFixed(1);
    const netR=r.cg-r.pg;
    const rowCol=netR>0?"#34d399":netR<0?"#f87171":"#fbbf24";
    const div=document.createElement("div");
    div.className="sk-row"+(isATM?" sk-atm":"");
    div.style.border=isATM?"1px solid rgba(56,189,248,.25)":"1px solid transparent";
    div.innerHTML=`<span class="sk-lbl" style="color:${rowCol}">$${r.s}</span>
      <div class="sk-track">
        <div class="sk-put"  style="width:${pw}%;opacity:.85"></div>
        <div class="sk-call" style="width:${cw}%;opacity:.85"></div>
        <div class="sk-mid"></div>
      </div>
      <span class="sk-vols" style="color:${rowCol};font-size:8px">${fGEX(r.cg-r.pg)}</span>
      ${isATM?'<span class="mono" style="font-size:8px;color:var(--accent);flex-shrink:0">◄ATM</span>':''}`;
    gexLadder.appendChild(div);
  });

  document.getElementById("gex-cwall").textContent = bigCallWall ? `$${bigCallWall.s} · ${fGEX(bigCallWall.cg)}` : "—";
  document.getElementById("gex-pwall").textContent = bigPutWall  ? `$${bigPutWall.s} · ${fGEX(bigPutWall.pg)}`  : "—";
  document.getElementById("gex-flip").textContent  = flipStrike  ? `$${flipStrike}` : "—";
  gammaFlipState={price:flipStrike?Number(flipStrike):null,netAtSpot:netGEX,regime:netGEX>=0?"positive":"negative",updatedAt:Date.now()};
  sdGexContext={rows:gexRows.map(r=>({...r})),callWall:bigCallWall,putWall:bigPutWall,netGex:netGEX,updatedAt:Date.now()};

  // ── NET VEX ──────────────────────────────────────────────────────────────────
  // VEX = vega × OI × 100  (vega is per 1% IV change, 100 shares per contract)
  // Both calls and puts have positive vega; net VEX (call − put) shows skew of
  // vol exposure: positive = upside vol bid, negative = put-skew / downside vol bid.
  const vexByStrike = {};
  calls.forEach(c => {
    const s = c.details?.strike_price; if(!s) return;
    const v = (c.greeks?.vega ?? 0) * (c.open_interest ?? 0) * 100;
    if(!vexByStrike[s]) vexByStrike[s] = {s, cv:0, pv:0};
    vexByStrike[s].cv += v;
  });
  puts.forEach(c => {
    const s = c.details?.strike_price; if(!s) return;
    const v = (c.greeks?.vega ?? 0) * (c.open_interest ?? 0) * 100;
    if(!vexByStrike[s]) vexByStrike[s] = {s, cv:0, pv:0};
    vexByStrike[s].pv += v;
  });
  const vexRows = Object.values(vexByStrike).sort((a,b)=>b.s-a.s);
  const totalCallVEX = vexRows.reduce((t,r)=>t+r.cv, 0);
  const totalPutVEX  = vexRows.reduce((t,r)=>t+r.pv, 0);
  const netVEX = totalCallVEX - totalPutVEX;
  const totalVEX = totalCallVEX + totalPutVEX;

  // Reuse fGEX formatter (same $ scaling)
  const fVEX = fGEX;

  document.getElementById("vex-net").textContent = fVEX(netVEX);
  document.getElementById("vex-net").style.color = netVEX>0?"var(--green)":netVEX<0?"var(--red)":"var(--amber)";
  document.getElementById("vex-call").textContent = "+"+fVEX(totalCallVEX).replace(/^[+-]/,"");
  document.getElementById("vex-put").textContent  = "+"+fVEX(totalPutVEX).replace(/^[+-]/,"");

  // VEX regime — based on net asymmetry between call vega and put vega
  // Thresholds scale with total VEX so they adapt across DTE / chain breadth
  const vexAbs = Math.abs(netVEX);
  const vexRatio = totalVEX>0 ? vexAbs/totalVEX : 0;
  let vexRegime, vexSub;
  if(netVEX > 0 && vexRatio > 0.20)      { vexRegime="CALL-SKEW · UPSIDE VOL BID"; vexSub="Call vega dominates — IV sensitive to upside\nMomentum / squeeze risk if rally accelerates"; }
  else if(netVEX > 0)                    { vexRegime="MILD CALL-SKEW";              vexSub="Slight upside vol bias\nVol roughly balanced across the chain"; }
  else if(netVEX < 0 && vexRatio > 0.20) { vexRegime="PUT-SKEW · DOWNSIDE VOL BID"; vexSub="Put vega dominates — classic hedging skew\nIV likely to expand on a sell-off"; }
  else                                   { vexRegime="MILD PUT-SKEW";               vexSub="Slight downside vol bias\nVol roughly balanced across the chain"; }
  document.getElementById("vex-regime").textContent = vexRegime;
  document.getElementById("vex-regime").style.color = netVEX>0?"var(--green)":"var(--red)";
  document.getElementById("vex-regime-sub").textContent = vexSub;
  document.getElementById("vex-net-sub").textContent = netVEX>0?"Calls hold more vol exposure":"Puts hold more vol exposure";
  document.getElementById("vex-net-sub").style.color = netVEX>0?"var(--green)":"var(--red)";

  // VEX by-strike ladder
  const vexLadder = document.getElementById("vex-ladder"); vexLadder.innerHTML="";
  const nearVexStrikes = vexRows.filter(r=>!spyPrice||Math.abs(r.s-spyPrice)<=20);
  const maxVEX = Math.max(...nearVexStrikes.map(r=>Math.max(r.cv,r.pv)),1);
  let bigCallVWall=null, bigPutVWall=null;
  nearVexStrikes.forEach(r=>{
    if(!bigCallVWall||r.cv>bigCallVWall.cv) bigCallVWall=r;
    if(!bigPutVWall ||r.pv>bigPutVWall.pv)  bigPutVWall=r;
    const isATM=spyPrice&&Math.abs(r.s-spyPrice)<1.5;
    const cw=(r.cv/maxVEX*48).toFixed(1), pw=(r.pv/maxVEX*48).toFixed(1);
    const netR=r.cv-r.pv;
    const rowCol=netR>0?"#34d399":netR<0?"#f87171":"#fbbf24";
    const div=document.createElement("div");
    div.className="sk-row"+(isATM?" sk-atm":"");
    div.style.border=isATM?"1px solid rgba(56,189,248,.25)":"1px solid transparent";
    div.innerHTML=`<span class="sk-lbl" style="color:${rowCol}">$${r.s}</span>
      <div class="sk-track">
        <div class="sk-put"  style="width:${pw}%;opacity:.85"></div>
        <div class="sk-call" style="width:${cw}%;opacity:.85"></div>
        <div class="sk-mid"></div>
      </div>
      <span class="sk-vols" style="color:${rowCol};font-size:8px">${fVEX(r.cv-r.pv)}</span>
      ${isATM?'<span class="mono" style="font-size:8px;color:var(--accent);flex-shrink:0">◄ATM</span>':''}`;
    vexLadder.appendChild(div);
  });

  document.getElementById("vex-cwall").textContent = bigCallVWall ? `$${bigCallVWall.s} · ${fVEX(bigCallVWall.cv).replace(/^\+/,"")}` : "—";
  document.getElementById("vex-pwall").textContent = bigPutVWall  ? `$${bigPutVWall.s} · ${fVEX(bigPutVWall.pv).replace(/^\+/,"")}`  : "—";
  document.getElementById("vex-total").textContent = fVEX(totalVEX).replace(/^\+/,"");

  // charts
  renderCharts(calls,puts);
}

function setBar(fillId,valId,imb,txt){
  const fill=document.getElementById(fillId);
  const pct=Math.abs(imb)*50;
  const col=imb>.05?"#34d399":imb<-.05?"#f87171":"#fbbf24";
  fill.style.width=pct+"%";
  fill.style.background=col;
  fill.style.left=imb>0?"50%":"";
  fill.style.right=imb<0?"50%":"";
  if(imb<0){fill.style.right="50%";fill.style.left="";}else{fill.style.left="50%";fill.style.right="";}
  document.getElementById(valId).textContent=txt;
  document.getElementById(valId).style.color=col;
}

function setMeter(putId,callId,imb){
  document.getElementById(callId).style.width=Math.max(0,imb)*50+"%";
  document.getElementById(putId).style.width=Math.max(0,-imb)*50+"%";
}

function mkRow(c,idx){
  const det=c.details||{},isC=det.contract_type==="call",col=isC?"#34d399":"#f87171";
  const vol=c.day?.volume,lp=c.last_trade?.price??c.last_quote?.midpoint,prem=rowP(c);
  const delta=c.greeks?.delta,iv=c.implied_volatility,oi=c.open_interest;
  const voI=vol&&oi?(vol/oi).toFixed(2):null,isW=prem>=500000;
  const ivCol=iv?iv>.5?"#f87171":iv>.3?"#fbbf24":"#afc2d3":"#7f96ab";
  const topCls=idx===0?" top1":idx===1?" top2":idx===2?" top3":"";
  const rankBadge=idx===0?`<span class="rank-badge rank-1">#1</span>`:idx===1?`<span class="rank-badge rank-2">#2</span>`:idx===2?`<span class="rank-badge rank-3">#3</span>`:"";
  const d=document.createElement("div");
  d.className="frow"+(isW?" wh":"")+topCls;
  d.style.background=isW?"rgba(251,191,36,.06)":idx<3?"":idx%2===1?"rgba(26,40,64,.2)":"transparent";
  d.style.borderLeft=isW?"2px solid var(--amber)":"";
  d.innerHTML=`<span style="color:${col};font-size:12px">${isC?"▲":"▼"}${rankBadge}</span>
    <span style="color:${col};font-size:8px;font-weight:700;padding:1px 4px;background:${col}18;border-radius:3px">${isC?"CALL":"PUT"}</span>
    <span style="color:#d8e6f5;font-weight:600">${det.strike_price?"$"+det.strike_price:"—"}</span>
    <span style="color:${lp?"#d8e6f5":"#7f96ab"}">${lp?"$"+lp.toFixed(2):"—"}</span>
    <span style="color:${isW?"#fbbf24":"#7a8ba8"};font-weight:${isW?700:400}">${fD(prem)}</span>
    <span style="color:#7a8ba8">${fN(vol)}</span>
    <span style="color:#9fb4c8;font-size:9px">${fN(oi)}</span>
    <span style="color:${ivCol};font-size:9px">${iv?fP(iv):"—"}</span>
    <span style="color:${voI>1.5?"#fbbf24":voI>1?"#fb923c":"#9fb4c8"};font-size:9px;font-weight:${voI>1.5?700:400}">${voI??"—"}</span>
    <span style="color:${delta==null?"#7f96ab":Math.abs(delta)>.5?"#d8e6f5":"#afc2d3"};font-size:9px">${delta!=null?delta.toFixed(2):"—"}</span>`;
  return d;
}

function renderRows(id,rows,emptyMsg){
  const el=document.getElementById(id); el.innerHTML="";
  if(!rows.length){el.innerHTML=`<div class="fempty">${emptyMsg}</div>`;return;}
  const f=document.createDocumentFragment(); rows.forEach((c,i)=>f.appendChild(mkRow(c,i))); el.appendChild(f);
}

function pressureLiveMark(p){
  const history = p.sym ? (optionQuoteMap.get(p.sym) || []) : [];
  const q = history.length ? history[history.length-1] : null;
  if(!q) return {mark:null,exitPrice:null,bid:null,ask:null,ageMs:null,stale:true};
  const bid=Number(q.bid||0), ask=Number(q.ask||0);
  const mark = bid>0 && ask>0 ? (bid+ask)/2 : (bid||ask||null);
  // Use the executable side for estimated liquidation P&L, not the midpoint:
  // an ask-side buyer can currently sell at bid; a bid-side seller can buy back at ask.
  let exitPrice=null;
  if(p.execution==="ASK BUY") exitPrice=bid>0?bid:null;
  else if(p.execution==="BID SELL") exitPrice=ask>0?ask:null;
  const ageMs = Math.max(0,(Date.now()-fTS(q.ts)));
  return {mark:Number.isFinite(mark)?mark:null,exitPrice:Number.isFinite(exitPrice)?exitPrice:null,bid,ask,ageMs,stale:ageMs>30000};
}

function pressurePnL(p){
  const live=pressureLiveMark(p);
  if(live.exitPrice==null) return {...live,pnl:null,pct:null};
  let pnl=null;
  if(p.execution==="ASK BUY") pnl=(live.exitPrice-p.price)*p.size*100;
  else if(p.execution==="BID SELL") pnl=(p.price-live.exitPrice)*p.size*100;
  if(pnl==null) return {...live,pnl:null,pct:null};
  const basis=Math.max(0.01,p.price*p.size*100);
  return {...live,pnl,pct:pnl/basis};
}

function mkPressureRow(p,allPressureRows=[]){
  const dir = p.direction || "UNCLEAR";
  const dirClass = dir.toLowerCase();
  const dirColor = dir==="BULLISH"?"#34d399":dir==="BEARISH"?"#f87171":"#fbbf24";
  const typeColor = p.side==="call"?"#34d399":"#f87171";
  const execColor = p.execution==="ASK BUY"?"#34d399":p.execution==="BID SELL"?"#f87171":"#fbbf24";
  const qualityColor = p.quality==="LIVE NBBO"?"#7a8ba8":p.quality==="ISO"?"#a78bfa":"#fbbf24";
  const live=pressurePnL(p);
  const pnlColor=live.pnl==null?"#7a8ba8":live.pnl>0?"#34d399":live.pnl<0?"#f87171":"#fbbf24";
  const pnlText=live.pnl==null?"—":`${live.pnl>=0?"+":""}${fD(live.pnl)} · ${live.pct>=0?"+":""}${(live.pct*100).toFixed(1)}%`;
  const markText=live.mark==null?"—":`$${live.mark.toFixed(2)}${live.stale?"*":""}`;
  const qualityText=live.stale && live.mark!=null ? `${p.quality} · MARK STALE` : p.quality;
  const inst=institutionalScore(p,allPressureRows,live);
  const d = document.createElement("div");
  d.className = `pressure-row ${dirClass}`;
  d.innerHTML = `
    <span style="color:#7a8ba8">${fTET(p.ts)}</span>
    <span style="color:${dirColor};font-weight:800">${dir}</span>
    <span style="color:${typeColor};font-weight:700">${p.side==="call"?"CALL":"PUT"}</span>
    <span style="color:#d8e6f5;font-weight:700">$${p.strike}</span>
    <span style="color:#d8e6f5">$${p.price.toFixed(2)}</span>
    <span style="color:#fbbf24;font-weight:800">${fD(p.prem)}</span>
    <span style="color:#d8e6f5">${fN(p.size)}</span>
    <span style="color:#7a8ba8">${p.bid!=null?"$"+p.bid.toFixed(2):"—"}</span>
    <span style="color:#7a8ba8">${p.ask!=null?"$"+p.ask.toFixed(2):"—"}</span>
    <span style="color:${live.stale?"#fbbf24":"#d8e6f5"};font-weight:700">${markText}</span>
    <span style="color:${execColor};font-size:9px;font-weight:700">${p.execution}</span>
    <span style="color:${pnlColor};font-size:9px;font-weight:800">${pnlText}</span>
    ${institutionalScoreHtml(inst)}
    <span style="color:${qualityColor};font-size:8px">${qualityText}</span>`;
  return d;
}

function renderPressureTape(force=false){
  const body = document.getElementById("pressure-body");
  const summary = document.getElementById("pressure-summary");
  if(!body || !summary) return;
  if(document.hidden && !force) return; // keep buffering data; redraw immediately on resume

  const cutoff = Date.now() - PRESSURE_WINDOW_MS;
  const rows = pressurePrints
    .filter(p => fTS(p.ts) >= cutoff && (pressureMinPremium===0 || p.prem>=pressureMinPremium))
    .sort((a,b) => b.ts-a.ts);
  const classified = rows.filter(p => p.direction==="BULLISH" || p.direction==="BEARISH");
  const bullPremium = classified.filter(p=>p.direction==="BULLISH").reduce((s,p)=>s+p.prem,0);
  const bearPremium = classified.filter(p=>p.direction==="BEARISH").reduce((s,p)=>s+p.prem,0);
  const total = bullPremium + bearPremium;
  const net = total ? (bullPremium-bearPremium)/total : 0;
  const bias = !total?"WAITING":net>.12?"BULLISH":net<-.12?"BEARISH":"BALANCED";
  const biasColor = bias==="BULLISH"?"#34d399":bias==="BEARISH"?"#f87171":bias==="BALANCED"?"#fbbf24":"#7a8ba8";
  const feed = massiveAlive && optionQuoteMap.size>0
    ? `<span style="color:#34d399">● LIVE NBBO</span>`
    : `<span style="color:#fbbf24">● QUOTES REQUIRED FOR DIRECTION</span>`;

  summary.innerHTML = `
    <span style="color:#7a8ba8">30M · ${pressureFilterLabel()} · ${rows.length} PRINT${rows.length===1?"":"S"}</span>
    <span style="color:#34d399;font-weight:700">BULL ${fD(bullPremium)}</span>
    <span style="color:#f87171;font-weight:700">BEAR ${fD(bearPremium)}</span>
    <span style="color:${biasColor};font-weight:800">${bias}${total?` · ${Math.abs(net*100).toFixed(0)}% NET`:""}</span>
    <span style="margin-left:auto">${feed}</span>`;

  body.innerHTML = "";
  if(!rows.length){
    body.innerHTML = `<div class="fempty">Waiting for individual ${pressureFilterLabel()} option trades in the subscribed strike range…<br><span style="font-size:9px">Direction requires Massive Options Advanced live quotes.</span></div>`;
    return;
  }
  const f = document.createDocumentFragment();
  rows.slice(0,PRESSURE_RENDER_MAX).forEach(p=>f.appendChild(mkPressureRow(p,rows)));
  body.appendChild(f);
  if(rows.length>PRESSURE_RENDER_MAX){
    const more=document.createElement("div");
    more.className="fempty";
    more.style.padding="12px";
    more.textContent=`Showing newest ${PRESSURE_RENDER_MAX} of ${rows.length} matching prints. All matching prints remain included in the 30-minute pressure totals.`;
    body.appendChild(more);
  }
}

function getGroupedTapeOrders(){
  // Streaming renders are already debounced. Rebuild as soon as a new print
  // arrives so a qualifying order does not wait on the older 750 ms cache.
  if(tapeGroupedDirty){
    tapeGroupedCache=reconstructTape(tapePrints);
    tapeGroupedCacheAt=Date.now();
    tapeGroupedDirty=false;
  }
  return tapeGroupedCache;
}
function tapeGroupedOrderKey(order,expiration=getSelectedExpiry()){
  const normalized=normalizeChartFlowOrder(order);
  if(normalized?.chartFlowId)return normalized.chartFlowId;
  const symbol=String(order?.sym||`${expiration}:${order?.side}:${Number(order?.strike)}`);
  const firstMs=Math.round(Number(order?.firstMs)||tapeTsMs(order?.ts));
  return `${expiration}|${symbol}|${String(order?.execution||"MID / UNCLEAR").toUpperCase()}|${firstMs}`;
}
function getRollingGroupedTapeOrders(){
  const cutoff=Date.now()-TAPE_RETENTION_MS,expiration=getSelectedExpiry(),orders=new Map();
  const current=getGroupedTapeOrders()
    .filter(order=>tapeTsMs(order?.ts)>=cutoff)
    .sort((a,b)=>tapeTsMs(b.ts)-tapeTsMs(a.ts));
  for(const order of current)orders.set(tapeGroupedOrderKey(order,expiration),order);

  // The raw WebSocket buffer is intentionally capped for performance. Merge
  // qualifying orders already captured by the chart archive back into the
  // Large Orders tape so the raw cap can never shorten the rolling 30 minutes.
  let recovered=0;
  for(const raw of chartFlowOrders){
    const order=normalizeChartFlowOrder(raw);
    if(!order||order.expiration!==expiration||Number(order.ts)<cutoff)continue;
    const key=tapeGroupedOrderKey(order,expiration);
    if(orders.has(key))continue;
    orders.set(key,order);recovered++;
  }
  tapeRecoveredArchiveCount=recovered;
  return[...orders.values()].sort((a,b)=>tapeTsMs(b.ts)-tapeTsMs(a.ts));
}
function getTapeSource(){
  if(tapeViewMode==="raw"){tapeRecoveredArchiveCount=0;return tapePrints;}
  return getRollingGroupedTapeOrders();
}

function buildExitIndex(orders){
  const byContract=new Map();
  for(const o of orders){
    const key=`${o.side}:${Number(o.strike)}`;
    if(!byContract.has(key)) byContract.set(key,[]);
    byContract.get(key).push(o);
  }
  for(const list of byContract.values()) list.sort((a,b)=>tapeTsMs(a.ts)-tapeTsMs(b.ts));
  return byContract;
}

function classifyTapeStatusFast(order, exitIndex){
  const live=tapeEstimatedPnL(order);
  const list=exitIndex.get(`${order.side}:${Number(order.strike)}`)||[];
  const tt=tapeTsMs(order.ts);
  let laterOpposite=false;
  for(let i=list.length-1;i>=0;i--){
    const other=list[i], ot=tapeTsMs(other.ts);
    if(ot<=tt) break;
    if(ot-tt>2*60*60*1000) continue;
    if(!order.execution||!other.execution||order.execution===other.execution) continue;
    const ratio=Number(other.size||0)/Math.max(1,Number(order.size||0));
    if(ratio>=0.5&&ratio<=1.5){laterOpposite=true;break;}
  }
  if(laterOpposite) return {key:"possible_exit",label:"POSSIBLE EXIT",color:"#fbbf24"};
  if(live.mark!=null&&live.stale) return {key:"stale",label:"STALE QUOTE",color:"#fbbf24"};
  if(live.pnl>0) return {key:"winner",label:"WINNER",color:"#34d399"};
  if(live.pnl<0) return {key:"loser",label:"LOSER",color:"#f87171"};
  return {key:"active",label:"ACTIVE",color:"#60a5fa"};
}

function renderFlowTape(){
  const removed=pruneTapePrints();
  if(removed) scheduleTapePersist();
  const source=getTapeSource();
  let arr=source;
  // Cheapest filters first. Premium filtering now happens before status/P&L work.
  if(tapePremiumMin>0) arr=arr.filter(p=>Number(p.prem||0)>=tapePremiumMin);
  if(ctFilter!=="all") arr=arr.filter(p=>p.side===ctFilter);
  if(sortField==="whale") arr=arr.filter(p=>Number(p.prem||0)>=500000);

  const exitIndex=buildExitIndex(source);
  if(tapeStatusFilter!=="all"){
    arr=arr.filter(p=>{
      p._status=classifyTapeStatusFast(p,exitIndex);
      return p._status.key===tapeStatusFilter;
    });
  }
  arr=[...arr];
  arr.sort((a,b)=>{
    if(sortField==="time"||sortField==="whale") return tapeTsMs(b.ts)-tapeTsMs(a.ts);
    if(sortField==="premium") return Number(b.prem||0)-Number(a.prem||0);
    if(sortField==="size") return Number(b.size||0)-Number(a.size||0);
    return tapeTsMs(b.ts)-tapeTsMs(a.ts);
  });

  const totalPages=Math.max(1,Math.ceil(arr.length/TAPE_RENDER_MAX));
  if(tapePage>=totalPages) tapePage=totalPages-1;
  if(tapePage<0) tapePage=0;
  const pageStart=tapePage*TAPE_RENDER_MAX;
  const pageEnd=Math.min(pageStart+TAPE_RENDER_MAX,arr.length);
  const visible=arr.slice(pageStart,pageEnd);
  for(const p of visible) if(!p._status) p._status=classifyTapeStatusFast(p,exitIndex);
  const el=document.getElementById("fbody");
  if(!el) return;
  el.replaceChildren();
  if(!arr.length){
    const msg=tapePrints.length===0
      ?"Waiting for first refresh…<br><span style='font-size:9px;color:var(--dim)'>Every raw print is captured before large-order reconstruction</span>"
      :"No orders match the current premium and status filters";
    el.innerHTML=`<div class="fempty">${msg}</div>`;
  }else{
    const f=document.createDocumentFragment();
    visible.forEach(p=>f.appendChild(mkTapeRow(p,[])));
    el.appendChild(f);
  }

  const pager=document.getElementById("tape-pager");
  const pageInfo=document.getElementById("tape-page-info");
  const newerBtn=document.getElementById("tape-newer-btn");
  const olderBtn=document.getElementById("tape-older-btn");
  const latestBtn=document.getElementById("tape-latest-btn");
  if(pager){
    pager.style.display=arr.length>TAPE_RENDER_MAX?"flex":"none";
    if(pageInfo) pageInfo.textContent=arr.length?`PAGE ${tapePage+1} OF ${totalPages} · ${pageStart+1}-${pageEnd} OF ${arr.length}`:"PAGE 1";
    if(newerBtn) newerBtn.disabled=tapePage===0;
    if(olderBtn) olderBtn.disabled=tapePage>=totalPages-1;
    if(latestBtn) latestBtn.style.display=tapePage===0?"none":"inline-block";
  }

  const rct=document.getElementById("rct");
  if(rct){
    let filteredContracts=0, filteredPremium=0, filteredNetDelta=0;
    for(const p of arr){
      const size=Math.max(0,Number(p.size||0));
      const prem=Math.max(0,Number(p.prem||0));
      filteredContracts+=size;
      filteredPremium+=prem;
      if(p.delta!=null && Number.isFinite(Number(p.delta))){
        const direction=p.execution==="ASK BUY"?1:p.execution==="BID SELL"?-1:0;
        filteredNetDelta+=Number(p.delta)*size*100*direction;
      }
    }
    const deltaText=`${filteredNetDelta>=0?"+":""}${fN(Math.round(filteredNetDelta))} Δ`;
    rct.textContent=`FILTERED · ${fN(arr.length)} orders · ${fN(filteredContracts)} contracts · ${fD(filteredPremium)} · ${deltaText}`;
    rct.title="Totals include only orders matching the active view, premium, contract-type, whale, and status filters. Pagination does not change these filtered totals.";
  }
  let whales=0,calls=0,puts=0;
  for(const p of source){
    if(Number(p.prem||0)>=500000) whales++;
    if(p.side==="call") calls++; else if(p.side==="put") puts++;
  }
  const wEl=document.getElementById("tape-whale-ct");
  if(wEl) wEl.textContent=whales?`🐋 ${whales} whale order${whales>1?"s":""}`:"";
  const rangeStr=wsRangeDollars===0?"ALL":`±$${wsRangeDollars}`;
  const premiumTag=tapePremiumMin>0?` · ≥ ${fD(tapePremiumMin)}`:" · all premiums";
  const recoveredTag=tapeRecoveredArchiveCount?` · ${tapeRecoveredArchiveCount} restored from 30m archive`:"";
  const wsTag=massiveAlive?` · ⚡ ${massiveTradeCount} ticks · ${massiveSubs.size} subs ${rangeStr}`:"";
  const modeTag=tapeViewMode==="grouped"?`${source.length} cached orders / ${tapePrints.length} raw`:`${tapePrints.length} raw prints`;
  const info=document.getElementById("tape-info");
  if(info) info.textContent=`rolling 30 min · ${modeTag}${recoveredTag} · ${arr.length} matching · ${calls}C ${puts}P${premiumTag}${wsTag} · EXIT PX/P&L use bid for ASK BUY and ask for BID SELL`;
}


function changeTapePage(delta){
  tapePage=Math.max(0,tapePage+Number(delta||0));
  renderFlowTape();
  document.getElementById("fbody")?.scrollTo({top:0,behavior:"smooth"});
}
function goToLatestTapePage(){
  tapePage=0;
  renderFlowTape();
  document.getElementById("fbody")?.scrollTo({top:0,behavior:"smooth"});
}
function resetTapePage(){ tapePage=0; }



// Optional VIX context is unavailable in this server's SPY-only data API.
function getVixAiContext(){return {available:false,pts:0};}
let vixLast=null;
const vixFeedError="not configured in the server SPY feed";
function lookupChainContract(sym,type,strike){
  return chain.find(c=>(sym&&c.details?.ticker===sym)||(!sym&&c.details?.contract_type===type&&Number(c.details?.strike_price)===Number(strike)))||null;
}
function getGammaFlipAiContext(type,current){
  const flip=Number(gammaFlipState.price),price=Number(current),isCall=type==="call";
  if(!Number.isFinite(flip)||flip<=0||!Number.isFinite(price))return{available:false,pts:0,flip:null,aligned:false,label:"Gamma Flip unavailable"};
  const above=price>=flip,aligned=isCall?above:!above,distance=price-flip;
  return{available:true,pts:aligned?10:0,flip,above,aligned,distance,label:`SPY ${above?"above":"below"} Gamma Flip ${flip.toFixed(2)} by ${Math.abs(distance).toFixed(2)}`};
}
function renderGammaFlipState(){
  const flip=Number(gammaFlipState.price),spot=Number(spyPrice),has=Number.isFinite(flip)&&flip>0;
  const set=(id,value,color)=>{const el=document.getElementById(id);if(el){el.textContent=value;if(color)el.style.color=color;}};
  set("gex-flip",has?`$${flip.toFixed(2)}`:"—");
  set("gex-flip-live",has?`$${flip.toFixed(2)}`:"NO CROSS");
  if(has&&Number.isFinite(spot)){
    const above=spot>=flip,distance=spot-flip,color=above?"#34d399":"#f87171";
    set("gex-flip-distance",`${above?"ABOVE":"BELOW"} ${Math.abs(distance).toFixed(2)} · ${String(gammaFlipState.regime).toUpperCase()} GEX`,color);
  }else set("gex-flip-distance","NO ZERO-GAMMA CROSS IN ±30", "#fbbf24");
  refreshChartLevels();
}

class OptionsSwiftSeries{
  constructor(chart,type,options={}){this.chart=chart;this.type=type;this.options={...options};this.data=[];this.priceLines=[];}
  setData(rows){const old=this.data.length;this.data=(Array.isArray(rows)?rows:[]).filter(Boolean).map(row=>({...row})).sort((a,b)=>Number(a.time)-Number(b.time));this.chart._seriesChanged(this,old);}
  update(row){if(!row)return;const old=this.data.length,last=this.data[this.data.length-1];if(last&&Number(last.time)===Number(row.time))this.data[this.data.length-1]={...row};else if(!last||Number(row.time)>Number(last.time))this.data.push({...row});else{const i=this.data.findIndex(item=>Number(item.time)===Number(row.time));if(i>=0)this.data[i]={...row};else{this.data.push({...row});this.data.sort((a,b)=>Number(a.time)-Number(b.time));}}this.chart._seriesChanged(this,old);}
  applyOptions(options={}){Object.assign(this.options,options);this.chart.render();}
  priceToCoordinate(price){return this.chart.priceToCoordinate(Number(price));}
  createPriceLine(options={}){const line={...options};this.priceLines.push(line);this.chart._invalidateBounds();this.chart.render();return line;}
  removePriceLine(line){this.priceLines=this.priceLines.filter(item=>item!==line);this.chart._invalidateBounds();this.chart.render();}
}

// Multi-candle scanner. Pattern names are morphology/context classifications, not trade predictions.
function osCandlePatterns(rows,i){
 const out=[], at=k=>{const b=rows[k];if(!b)return null;const o=+b.open,c=+b.close,h=+b.high,l=+b.low;if(![o,c,h,l].every(Number.isFinite)||h<=l||h<Math.max(o,c)||l>Math.min(o,c))return null;const r=h-l,body=Math.abs(c-o),up=h-Math.max(o,c),dn=Math.min(o,c)-l;return {o,c,h,l,r,body,up,dn,green:c>o,red:c<o,mid:(o+c)/2,small:body<=r*.3,long:body>=r*.65,doji:body<=r*.08};};
 const a=at(i),b=at(i-1),c=at(i-2),d=at(i-3),e=at(i-4);if(!a)return out;
 const tick=Math.max(.015,a.c*.00004),near=(x,y,m=1)=>Math.abs(x-y)<=Math.max(tick*m,Math.max(a.r,b?.r||0)*.08*m);
 const prior=rows.slice(Math.max(0,i-7),i).map(x=>+x.close).filter(Number.isFinite),trend=prior.length>=4?(prior.at(-1)-prior[0])/(Math.max(tick,Math.max(...prior)-Math.min(...prior),a.r)):0;
 const rise=trend>.25,fall=trend<-.25;
 const add=(name,bias,priority=1)=>out.push({name,bias,priority});
 // Single-candle anatomy; mutually exclusive families where appropriate.
 if(a.long&&a.up<=a.r*.08&&a.dn<=a.r*.08)add(a.green?'Bullish Marubozu':'Bearish Marubozu',a.green?1:-1,3);
 if(a.doji){
  if(a.dn>=a.r*.65&&a.up<=a.r*.12)add('Dragonfly Doji',fall?1:0,3);
  else if(a.up>=a.r*.65&&a.dn<=a.r*.12)add('Gravestone Doji',rise?-1:0,3);
  else add('Doji',0,1);
 }else{
  if(a.body<=a.r*.3&&a.up>=a.r*.25&&a.dn>=a.r*.25){add(a.green?'Bullish Spinning Top':'Bearish Spinning Top',0,2);}
  if(a.dn>=a.body*2&&a.dn>=a.r*.55&&a.up<=a.r*.18){add(rise?'Hanging Man':'Hammer',rise?-1:fall?1:0,3);}
  if(a.up>=a.body*2&&a.up>=a.r*.55&&a.dn<=a.r*.18)add('Inverted Hammer',fall?1:0,3);
 }
 if(b){
  // Full-range gaps between consecutive candles (windows).
  if(a.l>b.h+tick)add('Rising Window',1,4);
  if(a.h<b.l-tick)add('Falling Window',-1,4);
  if(a.green&&b.red&&a.o<=b.c&&a.c>=b.o&&a.body>b.body*1.05)add('Bullish Engulfing',1,4);
  if(a.red&&b.green&&a.o>=b.c&&a.c<=b.o&&a.body>b.body*1.05)add('Bearish Engulfing',-1,4);
  if(a.green&&b.red&&a.o<b.l+tick&&a.c>b.mid&&a.c<b.o)add('Piercing Line',1,3);
  if(a.red&&b.green&&a.o>b.h-tick&&a.c<b.mid&&a.c>b.o)add('Dark Cloud Cover',-1,3);
  if(b.long&&a.body<b.body*.65&&Math.max(a.o,a.c)<Math.max(b.o,b.c)&&Math.min(a.o,a.c)>Math.min(b.o,b.c))add(b.red?'Bullish Harami':'Bearish Harami',b.red?1:-1,3);
  if(near(a.l,b.l)&&a.green&&b.red)add('Tweezer Bottom',1,3);
  if(near(a.h,b.h)&&a.red&&b.green)add('Tweezer Top',-1,3);
  if(b.red&&a.green&&a.o>b.h+tick&&a.long)add('Bullish Kicker',1,5);
  if(b.green&&a.red&&a.o<b.l-tick&&a.long)add('Bearish Kicker',-1,5);
 }
 if(c&&b){
  if(c.red&&c.long&&b.small&&a.green&&a.long&&a.c>c.mid)add('Morning Star',1,5);
  if(c.red&&b.red&&a.red&&c.c>b.c&&b.c>a.c&&[a,b,c].every(x=>x.long))add('Three Black Crows',-1,5);
  if(c.green&&b.green&&a.green&&c.c<b.c&&b.c<a.c&&[a,b,c].every(x=>x.long))add('Three White Soldiers',1,5);
  if(c.red&&b.small&&a.green&&a.c>c.o&&a.o>c.c)add('Three Inside Up',1,4);
  if(c.green&&b.small&&a.red&&a.c<c.o&&a.o<c.c)add('Three Inside Down',-1,4);
  if(c.red&&b.green&&b.o<=c.c&&b.c>=c.o&&a.green&&a.c>b.c)add('Three Outside Up',1,4);
  if(c.green&&b.red&&b.o>=c.c&&b.c<=c.o&&a.red&&a.c<b.c)add('Three Outside Down',-1,4);
  if(c.red&&b.doji&&a.green&&b.h<c.l&&a.l>b.h)add('Bullish Abandoned Baby',1,5);
 }
 if(d&&c&&b){
 }
 if(e&&d&&c&&b){
 }
 // Avoid displaying competing synonyms: show the most specific match only.
 return out.sort((x,y)=>y.priority-x.priority);
}
function osHammerPattern(bar,previous=[]){const p=osCandlePatterns([...previous,bar],previous.length);return p.length?p[0].name:null;}
function toggleHammerPatterns(btn){
  window.osShowHammerPatterns=!window.osShowHammerPatterns;
  btn?.classList.toggle('on',window.osShowHammerPatterns);
  if(typeof tvChart!=='undefined'&&tvChart?.render)tvChart.render();
}
window.osShowHammerPatterns=true;
class OptionsSwiftCanvasChart{
  constructor(container,options={}){
    this.container=container;this.options={...options};this.series=[];this.range=null;this.priceOffset=0;this.priceScaleFactor=1;this.boundsCache=null;this.rangeListeners=new Set();this.pointer=null;this.drag=null;this.editDrag=null;this.frame=null;this.drawings=[];this.drawingPoints=[];this.drawingTool="trend";this.magnetMode=true;this.extendTrend=true;this.drawingMode=false;this.selectedDrawing=null;this.hoverDrawing=null;this.supplyDemandZones=[];this.supplyDemandNoTradeArea=null;this.supplyDemandSignals=[];this.showSupplyDemand=true;this.showVolumeProfile=true;
    this.canvas=document.createElement("canvas");this.canvas.className="os-chart-canvas";this.canvas.setAttribute("aria-label","Options Swift live SPY chart");container.replaceChildren(this.canvas);this.ctx=this.canvas.getContext("2d",{alpha:false});
    this.timeApi={fitContent:()=>this.fitContent(),getVisibleLogicalRange:()=>this.getVisibleLogicalRange(),setVisibleLogicalRange:r=>this.setVisibleLogicalRange(r),timeToCoordinate:t=>this.timeToCoordinate(t),subscribeVisibleLogicalRangeChange:fn=>this.rangeListeners.add(fn)};
    this.priceApi={applyOptions:()=>{}};
    this._bindInteractions();this.applyOptions({width:options.width||container.clientWidth,height:options.height||container.clientHeight});if(options.handleScroll!==false)window.addEventListener("keydown",e=>{const tag=String(document.activeElement?.tagName||"").toUpperCase();if(["INPUT","SELECT","TEXTAREA"].includes(tag))return;if((e.key==="Delete"||e.key==="Backspace")&&this.selectedDrawing){e.preventDefault();this.deleteDrawing(this.selectedDrawing);}else if(e.key==="Escape"){this.drawingPoints=[];this.selectedDrawing=null;globalThis.updateCustomDrawingControls?.();this.render();}});
  }
  addCandlestickSeries(options={}){const s=new OptionsSwiftSeries(this,"candles",options);this.series.push(s);return s;}
  addLineSeries(options={}){const s=new OptionsSwiftSeries(this,"line",options);this.series.push(s);return s;}
  addHistogramSeries(options={}){const s=new OptionsSwiftSeries(this,"histogram",options);this.series.push(s);return s;}
  timeScale(){return this.timeApi;}
  priceScale(){return this.priceApi;}
  applyOptions(options={}){this.options={...this.options,...options};const width=Math.max(1,Math.round(Number(options.width)||this.container.clientWidth||this.width||1)),height=Math.max(1,Math.round(Number(options.height)||this.container.clientHeight||this.height||1));this.resize(width,height);}
  resize(width,height){if(width===this.width&&height===this.height)return;this.width=width;this.height=height;const dpr=Math.max(1,Math.min(3,window.devicePixelRatio||1));this.dpr=dpr;this.canvas.style.width=`${width}px`;this.canvas.style.height=`${height}px`;this.canvas.width=Math.round(width*dpr);this.canvas.height=Math.round(height*dpr);this.render();}
  _timelineSeries(){return this.series.find(s=>s.type==="candles")||this.series.find(s=>s.data.length)||null;}
  _timeline(){return this._timelineSeries()?.data||[];}
  _invalidateBounds(){this.boundsCache=null;}
  _seriesChanged(series,oldLength){this._invalidateBounds();const timeline=this._timeline(),n=timeline.length;if(!this.range&&n)this.range={from:0,to:n-1};else if(series===this._timelineSeries()&&n>oldLength&&this.range&&this.range.to>=oldLength-1.5&&globalThis.optionsSwiftLiveFollowEnabled?.()){const width=Math.max(1,this.range.to-this.range.from);this.range={from:Math.max(0,n-1-width),to:n-1};this._emitRange();}this.render();}
  _layout(){const timeVisible=this.options.timeScale?.visible!==false,rightVisible=this.options.rightPriceScale?.visible!==false;const left=8,right=Number.isFinite(this.options.plotRightInset)?this.options.plotRightInset:(rightVisible?68:8),top=14,bottom=timeVisible?28:7;return{left,right:this.width-right,top,bottom:this.height-bottom,width:Math.max(1,this.width-left-right),height:Math.max(1,this.height-top-bottom),timeVisible,rightVisible};}
  _clampRange(input){const n=this._timeline().length;if(!n)return{from:0,to:0};let from=Number(input?.from),to=Number(input?.to);if(!Number.isFinite(from)||!Number.isFinite(to)||to<from){from=0;to=n-1;}const minCount=Math.min(8,n),count=Math.min(n,Math.max(minCount,to-from+1)),edgeSpace=Math.max(3,Math.min(80,count*.3));from=Math.max(-edgeSpace,Math.min(n-count+edgeSpace,from));return{from,to:from+count-1};}
  getVisibleLogicalRange(){if(!this.range)this.range=this._clampRange({from:0,to:this._timeline().length-1});return{...this.range};}
  setVisibleLogicalRange(range,notify=false){this.range=this._clampRange(range);this._invalidateBounds();this.render();if(notify)this._emitRange();}
  fitContent(){this.range=this._clampRange({from:0,to:this._timeline().length-1});this.priceOffset=0;this.priceScaleFactor=1;this._invalidateBounds();this.render();this._emitRange();}
  _emitRange(){const range=this.getVisibleLogicalRange();for(const listener of this.rangeListeners){try{listener({...range});}catch(_){}}}
  _indexForTime(time){const data=this._timeline(),target=Number(time);let lo=0,hi=data.length-1;while(lo<=hi){const mid=(lo+hi)>>1,value=Number(data[mid].time);if(value===target)return mid;if(value<target)lo=mid+1;else hi=mid-1;}return Math.max(0,Math.min(data.length-1,lo));}
  _xForIndex(index){const l=this._layout(),r=this.getVisibleLogicalRange(),slots=Math.max(1,r.to-r.from+1);return l.left+(index-r.from+.5)*(l.width/slots);}
  timeToCoordinate(time){if(!this._timeline().length)return null;return this._xForIndex(this._indexForTime(time));}
  _visibleIndexes(){const r=this.getVisibleLogicalRange(),n=this._timeline().length;return{first:Math.max(0,Math.floor(r.from)),last:Math.min(n-1,Math.ceil(r.to))};}
  _priceBounds(){if(this.boundsCache)return this.boundsCache;const candle=this.series.find(s=>s.type==="candles"),{first,last}=this._visibleIndexes();let min=Infinity,max=-Infinity;if(candle){for(let i=first;i<=last;i++){const b=candle.data[i];if(!b)continue;min=Math.min(min,Number(b.low));max=Math.max(max,Number(b.high));}}
    for(const s of this.series.filter(item=>item.type==="line")){for(const p of s.data){const i=this._indexForTime(p.time);if(i<first||i>last)continue;const v=Number(p.value);if(Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);}}}
    // NOTE: price lines (CALL/PUT GEX, walls, premium levels) are intentionally
    // excluded from the auto-scale below. They used to be folded into min/max
    // here, which meant the vertical axis always stretched out far enough to
    // include every level line regardless of how far away it was from the
    // currently zoomed-in time window — so zooming in on the price chart barely
    // changed the vertical scale and candles looked squashed/invisible. Dropping
    // this keeps the price axis fit to what's actually visible, TradingView-style;
    // _drawPriceLines() already skips drawing any line that falls outside the
    // current bounds, so far-off levels just don't render instead of stretching
    // the scale.
    if(!Number.isFinite(min)||!Number.isFinite(max)){min=0;max=1;}const pad=Math.max(.02,(max-min||Math.max(1,Math.abs(max)*.002))*.09),offset=Number(this.priceOffset)||0,factor=Math.max(.15,Math.min(8,Number(this.priceScaleFactor)||1)),flowRoom=typeof tvChart!=="undefined"&&this===tvChart&&!!(typeof tvStudies!=="undefined"&&tvStudies.flow);let lo=min-pad,hi=max+pad;
    // Flow Marks on: keep pixel room above the highs for PUT labels and below the lows for CALL labels,
    // so a candle making a new high/low never pushes its put/call premium to the wrong side.
    if(flowRoom){const H=this._layout().height,T=Math.min(H*.3,84),B=Math.min(H*.22,64),ppx=(hi-lo)/Math.max(40,H-T-B);hi+=T*ppx;lo-=B*ppx;}
    const center=(lo+hi)/2+offset,span=(hi-lo)*factor;this.boundsCache={min:center-span/2,max:center+span/2};return this.boundsCache;}
  priceToCoordinate(price){const l=this._layout(),b=this._priceBounds(),value=Number(price);if(!Number.isFinite(value))return null;return l.top+(b.max-value)/(b.max-b.min)*l.height;}
  coordinateToPrice(y){const l=this._layout(),b=this._priceBounds();return b.max-((y-l.top)/l.height)*(b.max-b.min);}
  _pointFromCoordinates(x,y){const data=this._timeline(),r=this.getVisibleLogicalRange(),l=this._layout();if(!data.length||x<l.left||x>l.right||y<l.top||y>l.bottom)return null;const index=Math.max(0,Math.min(data.length-1,Math.round(r.from+((x-l.left)/l.width)*(r.to-r.from)))),bar=data[index],rawPrice=this.coordinateToPrice(y);let price=rawPrice,snappedTo=null;if(this.magnetMode&&bar){const choices=[["O",bar.open],["H",bar.high],["L",bar.low],["C",bar.close]].filter(([,value])=>Number.isFinite(Number(value)));choices.sort((a,b)=>Math.abs(Number(a[1])-rawPrice)-Math.abs(Number(b[1])-rawPrice));if(choices.length){snappedTo=choices[0][0];price=Number(choices[0][1]);}}return{time:Number(bar.time),price,index,snappedTo};}
  setDrawingMode(active){this.drawingMode=!!active;if(!active)this.drawingPoints=[];this.hoverDrawing=null;this.canvas.style.cursor=active?"cell":"crosshair";this.render();}
  setDrawingTool(tool){if(!["trend","ray","horizontal","channel","vertical"].includes(tool))return;this.drawingTool=tool;this.drawingPoints=[];this.render();}
  setMagnetMode(active){this.magnetMode=!!active;this.render();}
  setTrendExtension(active){this.extendTrend=!!active;for(const drawing of this.drawings)if(drawing.type==="trend")drawing.extend=this.extendTrend;this.render();}
  _drawingPointCount(){return ["horizontal","vertical"].includes(this.drawingTool)?1:this.drawingTool==="channel"?3:2;}
  addDrawingPoint(point){if(!point)return;if(this.drawingTool==="vertical"&&!Number.isFinite(point.diCrossLogicalIndex))point=swiftSnapVerticalToDICross(point);this.drawingPoints.push(point);if(this.drawingPoints.length>=this._drawingPointCount()){const drawing={type:this.drawingTool,points:this.drawingPoints.slice(0,this._drawingPointCount()),extend:this.drawingTool==="trend"&&this.extendTrend};this.drawings.push(drawing);this.selectedDrawing=drawing;this.drawingPoints=[];globalThis.updateCustomDrawingControls?.();}this.render();}
  deleteDrawing(drawing){const index=this.drawings.indexOf(drawing);if(index>=0)this.drawings.splice(index,1);if(this.selectedDrawing===drawing)this.selectedDrawing=null;if(this.hoverDrawing===drawing)this.hoverDrawing=null;globalThis.updateCustomDrawingControls?.();this.render();}
  clearDrawings(){this.drawings=[];this.drawingPoints=[];this.selectedDrawing=null;this.hoverDrawing=null;globalThis.updateCustomDrawingControls?.();this.render();}
  _drawingScreenPoint(point){return{x:Number.isFinite(point.diCrossLogicalIndex)?this._xForIndex(point.diCrossLogicalIndex):this.timeToCoordinate(point.time),y:this.priceToCoordinate(point.price),source:point};}
  _drawingGeometry(drawing){const l=this._layout(),points=(drawing?.points||[]).map(point=>this._drawingScreenPoint(point)).filter(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)),segments=[];if(!points.length)return{points,segments};const lineAt=(a,b,x)=>Math.abs(b.x-a.x)<.001?a.y:a.y+(b.y-a.y)*(x-a.x)/(b.x-a.x);if(drawing.type==="vertical")segments.push([{x:points[0].x,y:l.top},{x:points[0].x,y:l.bottom}]);else if(drawing.type==="horizontal")segments.push([{x:l.left,y:points[0].y},{x:l.right,y:points[0].y}]);else if(points.length>=2&&drawing.type==="ray"){const [a,b]=points;if(Math.abs(b.x-a.x)<.001)segments.push([a,{x:a.x,y:b.y>=a.y?l.bottom:l.top}]);else{const edge=b.x>=a.x?l.right:l.left;segments.push([a,{x:edge,y:lineAt(a,b,edge)}]);}}else if(points.length>=2&&drawing.type==="trend"){const [a,b]=points;if(drawing.extend){if(Math.abs(b.x-a.x)<.001)segments.push([{x:a.x,y:l.top},{x:a.x,y:l.bottom}]);else segments.push([{x:l.left,y:lineAt(a,b,l.left)},{x:l.right,y:lineAt(a,b,l.right)}]);}else segments.push([a,b]);}else if(points.length>=3&&drawing.type==="channel"){const [a,b,c]=points;if(Math.abs(b.x-a.x)<.001){segments.push([{x:a.x,y:l.top},{x:a.x,y:l.bottom}],[{x:c.x,y:l.top},{x:c.x,y:l.bottom}],[{x:(a.x+c.x)/2,y:l.top},{x:(a.x+c.x)/2,y:l.bottom}]);}else{const baseLeft=lineAt(a,b,l.left),baseRight=lineAt(a,b,l.right),offset=c.y-lineAt(a,b,c.x);segments.push([{x:l.left,y:baseLeft},{x:l.right,y:baseRight}],[{x:l.left,y:baseLeft+offset},{x:l.right,y:baseRight+offset}],[{x:l.left,y:baseLeft+offset/2},{x:l.right,y:baseRight+offset/2}]);}}else if(points.length>=2)segments.push([points[0],points[1]]);return{points,segments};}
  _distanceToSegment(x,y,a,b){const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;if(!length)return Math.hypot(x-a.x,y-a.y);const t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/length)),px=a.x+t*dx,py=a.y+t*dy;return Math.hypot(x-px,y-py);}
  _findDrawingAt(x,y,tolerance=9){for(let i=this.drawings.length-1;i>=0;i--){const drawing=this.drawings[i],geometry=this._drawingGeometry(drawing);if(geometry.points.some(point=>Math.hypot(x-point.x,y-point.y)<=tolerance+3)||geometry.segments.some(([a,b])=>this._distanceToSegment(x,y,a,b)<=tolerance))return drawing;}return null;}
  _findAnchorAt(drawing,x,y,tolerance=10){const points=this._drawingGeometry(drawing).points;for(let i=0;i<points.length;i++)if(Math.hypot(x-points[i].x,y-points[i].y)<=tolerance)return i;return-1;}
  _bindInteractions(){
    const xy=e=>{const r=this.canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
    this.canvas.addEventListener("wheel",e=>{if(this.options.handleScale===false)return;globalThis.disableTradingChartLiveFollow?.();e.preventDefault();const data=this._timeline();if(data.length<2)return;const p=xy(e),l=this._layout(),range=this.getVisibleLogicalRange(),oldCount=range.to-range.from+1,wheelUnit=e.deltaMode===1?33:e.deltaMode===2?this.height:1,wheelDelta=Math.max(-240,Math.min(240,Number(e.deltaY||0)*wheelUnit));if(!wheelDelta)return;const newCount=Math.max(Math.min(8,data.length),Math.min(data.length,oldCount*Math.exp(wheelDelta*.0016))),anchor=Math.max(0,Math.min(1,(p.x-l.left)/l.width)),index=range.from+anchor*(oldCount-1);this.range=this._clampRange({from:index-anchor*(newCount-1),to:index+(1-anchor)*(newCount-1)});this._invalidateBounds();this.pointer=p;this.render();this._emitRange();},{passive:false});
    this.canvas.addEventListener("pointerdown",e=>{
      if(e.button!==0)return;const p=xy(e),l=this._layout();this.pointer=p;
      if(this.drawingMode){this.addDrawingPoint(this._pointFromCoordinates(p.x,p.y));return;}
      if(this.options.handleScroll===false)return;
      if(p.x>=l.left&&p.x<=l.right&&p.y>=l.top&&p.y<=l.bottom){const hit=this._findDrawingAt(p.x,p.y);if(hit){this.selectedDrawing=hit;globalThis.updateCustomDrawingControls?.();const anchorIndex=this._findAnchorAt(hit,p.x,p.y),bounds=this._priceBounds();this.editDrag={drawing:hit,action:anchorIndex>=0?"anchor":"move",anchorIndex,x:p.x,y:p.y,originalPoints:hit.points.map(point=>({...point})),priceSpan:bounds.max-bounds.min};this.canvas.style.cursor=anchorIndex>=0?"crosshair":"move";this.canvas.setPointerCapture?.(e.pointerId);this.render();return;}this.selectedDrawing=null;globalThis.updateCustomDrawingControls?.();}
      const bounds=this._priceBounds(),action=p.x>l.right?"price-scale":p.y>l.bottom?"time-scale":"pan";if(action==="pan"||action==="time-scale")globalThis.disableTradingChartLiveFollow?.();this.drag={x:p.x,y:p.y,action,range:this.getVisibleLogicalRange(),priceOffset:this.priceOffset,priceScaleFactor:this.priceScaleFactor,priceSpan:bounds.max-bounds.min,moved:false};this.canvas.style.cursor=action==="price-scale"?"ns-resize":action==="time-scale"?"ew-resize":"grabbing";this.canvas.setPointerCapture?.(e.pointerId);
    });
    this.canvas.addEventListener("pointermove",e=>{
      const p=xy(e);this.pointer=p;const l=this._layout();
      if(this.editDrag){const edit=this.editDrag;if(edit.action==="anchor"){const point=this._pointFromCoordinates(p.x,p.y);if(point)edit.drawing.points[edit.anchorIndex]=edit.drawing.type==="vertical"?swiftSnapVerticalToDICross(point):point;}else{const count=this.getVisibleLogicalRange().to-this.getVisibleLogicalRange().from+1,deltaBars=(p.x-edit.x)/(l.width/Math.max(1,count)),deltaPrice=-(p.y-edit.y)/l.height*edit.priceSpan,data=this._timeline();edit.drawing.points=edit.originalPoints.map(point=>{const index=Math.max(0,Math.min(data.length-1,Math.round(this._indexForTime(point.time)+deltaBars))),bar=data[index];const moved={...point,time:Number(bar?.time??point.time),price:Number(point.price)+deltaPrice,index,snappedTo:null};return edit.drawing.type==="vertical"?swiftSnapVerticalToDICross(moved):moved;});}this.hoverDrawing=edit.drawing;this.canvas.style.cursor=edit.action==="anchor"?"crosshair":"move";this.render();return;}
      if(this.drag){const dx=p.x-this.drag.x,dy=p.y-this.drag.y,startCount=this.drag.range.to-this.drag.range.from+1;if(Math.abs(dx)>2||Math.abs(dy)>2)this.drag.moved=true;if(this.drag.moved&&this.drag.action==="pan"){const timeDelta=dx/(l.width/Math.max(1,startCount));this.range=this._clampRange({from:this.drag.range.from-timeDelta,to:this.drag.range.to-timeDelta});this.priceOffset=this.drag.priceOffset+(dy/l.height)*this.drag.priceSpan;}else if(this.drag.moved&&this.drag.action==="price-scale"){this.priceScaleFactor=Math.max(.15,Math.min(8,this.drag.priceScaleFactor*Math.exp(dy*.008)));}else if(this.drag.moved&&this.drag.action==="time-scale"){const anchor=Math.max(0,Math.min(1,(this.drag.x-l.left)/l.width)),anchorIndex=this.drag.range.from+anchor*(startCount-1),newCount=Math.max(Math.min(8,this._timeline().length),Math.min(this._timeline().length,startCount*Math.exp(-dx*.006)));this.range=this._clampRange({from:anchorIndex-anchor*(newCount-1),to:anchorIndex+(1-anchor)*(newCount-1)});}if(this.drag.moved){this._invalidateBounds();this._emitRange();}}
      else if(!this.drawingMode){const hit=p.x>=l.left&&p.x<=l.right&&p.y>=l.top&&p.y<=l.bottom?this._findDrawingAt(p.x,p.y):null;this.hoverDrawing=hit;if(hit)this.canvas.style.cursor=this._findAnchorAt(hit,p.x,p.y)>=0?"crosshair":"move";else this.canvas.style.cursor=p.x>l.right?"ns-resize":p.y>l.bottom?"ew-resize":"crosshair";}this.render();
    });
    const end=()=>{this.drag=null;this.editDrag=null;const p=this.pointer,l=this._layout();this.canvas.style.cursor=this.drawingMode?"cell":p?.x>l.right?"ns-resize":p?.y>l.bottom?"ew-resize":this.hoverDrawing?"move":"crosshair";};this.canvas.addEventListener("pointerup",end);this.canvas.addEventListener("pointercancel",end);this.canvas.addEventListener("pointerleave",()=>{if(!this.drag&&!this.editDrag){this.pointer=null;this.hoverDrawing=null;this.canvas.style.cursor=this.drawingMode?"cell":"crosshair";}this.render();});this.canvas.addEventListener("dblclick",()=>this.fitContent());
  }
  _lineDash(style){return style===2?[6,4]:style===3?[2,4]:style===1?[10,5]:[];}
  _drawGrid(ctx,l){ctx.save();ctx.strokeStyle=this.options.grid?.horzLines?.color||"#111b29";ctx.lineWidth=1;for(let i=0;i<=6;i++){const y=l.top+l.height*i/6;ctx.beginPath();ctx.moveTo(l.left,y+.5);ctx.lineTo(l.right,y+.5);ctx.stroke();}ctx.strokeStyle=this.options.grid?.vertLines?.color||"#111b29";for(let i=0;i<=8;i++){const x=l.left+l.width*i/8;ctx.beginPath();ctx.moveTo(x+.5,l.top);ctx.lineTo(x+.5,l.bottom);ctx.stroke();}ctx.restore();}
  _drawHistogram(ctx,series,l,overlay=false){const {first,last}=this._visibleIndexes();let max=0;for(const p of series.data){const i=this._indexForTime(p.time);if(i>=first&&i<=last)max=Math.max(max,Number(p.value)||0);}if(!max)return;const range=this.getVisibleLogicalRange(),step=l.width/Math.max(1,range.to-range.from+1),base=l.bottom,height=overlay?l.height*(this._flowForceActive()?0.07:0.22):l.height;for(const p of series.data){const i=this._indexForTime(p.time);if(i<first||i>last)continue;const value=Math.max(0,Number(p.value)||0),h=Math.max(1,value/max*height),x=this._xForIndex(i),w=Math.max(1,Math.min(18,step*.72));ctx.fillStyle=p.color||series.options.color||"rgba(56,189,248,.45)";ctx.fillRect(x-w/2,base-h,w,h);}}
  _flowForceActive(){return !!(this.showFlowForce&&this.flowForce&&this.flowForce.hasData);}
  _flowForceZone(l){const top=l.bottom-l.height*.35,bottom=l.bottom-l.height*.08;return{top,bottom,height:Math.max(24,bottom-top)};}
  _drawFlowForce(ctx,l){
    if(!this._flowForceActive())return;
    const ff=this.flowForce,data=this._timeline();if(!data.length)return;
    const {first,last}=this._visibleIndexes(),runs=[];let run=null;
    for(let i=Math.max(0,first-1);i<=Math.min(data.length-1,last+1);i++){
      const row=ff.map.get(Number(data[i].time));
      if(row&&Number.isFinite(row.share)){if(!run){run=[];runs.push(run);}run.push({x:this._xForIndex(i),share:row.share});}
      else run=null;
    }
    if(!runs.length)return;
    let dev=0;for(const r of runs)for(const p of r)dev=Math.max(dev,Math.abs(p.share-50));
    const half=Math.max(5,Math.min(50,Math.ceil(dev*1.1)+1)),z=this._flowForceZone(l),centre=z.top+z.height/2;
    const yFor=share=>z.top+(50+half-share)/(2*half)*z.height;
    const bullCol="#3dd0e6",bearCol="#f0868c";
    ctx.save();ctx.beginPath();ctx.rect(l.left,l.top,l.width,l.height);ctx.clip();
    // scale: faint grid + % labels, dotted 50% line
    const step=half<=8?2:half<=15?5:half<=30?10:20;
    ctx.font="700 9px 'Courier New',monospace";ctx.textBaseline="alphabetic";
    for(let v=Math.ceil((50-half)/step)*step;v<=50+half;v+=step){
      const y=Math.round(yFor(v))+.5;
      ctx.strokeStyle=v===50?"rgba(148,163,184,.26)":"rgba(148,163,184,.07)";ctx.lineWidth=1;ctx.setLineDash(v===50?[2,4]:[]);
      ctx.beginPath();ctx.moveTo(l.left,y);ctx.lineTo(l.right,y);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle="rgba(159,180,200,.38)";ctx.fillText(`${v}%`,l.left+4,y-2);
    }
    // smooth Catmull-Rom → bezier through a run of points
    const smooth=pts=>{for(let k=0;k<pts.length-1;k++){const p0=pts[k-1]||pts[k],p1=pts[k],p2=pts[k+1],p3=pts[k+2]||p2;ctx.bezierCurveTo(p1.x+(p2.x-p0.x)/6,p1.y+(p2.y-p0.y)/6,p2.x-(p3.x-p1.x)/6,p2.y-(p3.y-p1.y)/6,p2.x,p2.y);}};
    for(const r of runs){
      const bull=r.map(p=>({x:p.x,y:yFor(p.share)})),bear=bull.map(p=>({x:p.x,y:2*centre-p.y}));
      if(bull.length>1){
        ctx.beginPath();ctx.moveTo(bull[0].x,bull[0].y);smooth(bull);
        const rb=bear.slice().reverse();ctx.lineTo(rb[0].x,rb[0].y);smooth(rb);ctx.closePath();
        ctx.fillStyle="rgba(248,113,113,.12)";ctx.fill();
      }
      ctx.lineWidth=1.7;ctx.lineJoin="round";ctx.lineCap="round";
      for(const [pts,color] of [[bear,bearCol],[bull,bullCol]]){
        ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
        if(pts.length>1)smooth(pts);else ctx.lineTo(pts[0].x+.01,pts[0].y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  _drawFlowForceLegend(ctx,l){
    if(this.showFlowForce&&this.flowForce&&this.flowForce.map.size&&!this.flowForce.hasData){
      const text=`FLOW FORCE ${this.flowForce.len===1?"BAR":this.flowForce.len} · waiting for option trades · LIVE WS preferred · REST snapshot fallback enabled`,z=this._flowForceZone(l);
      ctx.save();ctx.font="800 10px 'Courier New',monospace";ctx.textBaseline="alphabetic";
      const w=Math.min(l.width-12,ctx.measureText(text).width+10);
      ctx.fillStyle="rgba(7,11,18,.72)";ctx.fillRect(l.left+6,z.top-17,w,15);ctx.fillStyle="#7f93a8";ctx.fillText(text,l.left+11,z.top-6,Math.max(10,w-10));ctx.restore();
      return;
    }
    if(!this._flowForceActive())return;
    const ff=this.flowForce,data=this._timeline();if(!data.length)return;
    let index=data.length-1;
    if(this.pointer&&!this.drag&&!this.editDrag&&this.pointer.x>=l.left&&this.pointer.x<=l.right&&this.pointer.y>=l.top&&this.pointer.y<=l.bottom){
      const r=this.getVisibleLogicalRange();
      index=Math.max(0,Math.min(data.length-1,Math.round(r.from+((this.pointer.x-l.left)/l.width)*(r.to-r.from))));
    }
    let row=ff.map.get(Number(data[index]?.time));
    if(!row)for(let i=data.length-1;i>=0;i--){const r=ff.map.get(Number(data[i].time));if(r){row=r;break;}}
    if(!row)return;
    const fmt=v=>{const n=Math.abs(Number(v)||0);return n>=1e6?`$${(n/1e6).toFixed(2)}M`:n>=1e3?`$${(n/1e3).toFixed(0)}K`:`$${Math.round(n)}`;};
    const net=row.wBull-row.wBear,total=row.wBull+row.wBear,score=total>0?100*net/total:0;
    const barNet=row.bull-row.bear,barTotal=row.bull+row.bear,barScore=barTotal>0?100*barNet/barTotal:0,pos="#3dd0e6",neg="#f0868c",dim="#7f93a8";
    const scoreFmt=v=>`${v>0?"+":""}${v.toFixed(1)}`;
    const perBar=ff.len===1,src=row.wLive>0?"LIVE":row.wEstimated>0?"ESTIMATED":"WAIT",title=(perBar?"FLOW FORCE BAR":"FLOW FORCE "+ff.len)+` · ${src}`;
    const parts=[[title,null,pos],["BULL ",fmt(row.wBull),pos],["BEAR ",fmt(row.wBear),neg],["SCORE ",scoreFmt(score),score<0?neg:pos]];
    if(!perBar)parts.push(["BAR ",`${fmt(row.bull)} / ${fmt(row.bear)}`,"#d8e6f5"],["BAR SCORE ",scoreFmt(barScore),barScore<0?neg:pos]);
    ctx.save();ctx.font="800 10px 'Courier New',monospace";ctx.textBaseline="alphabetic";ctx.textAlign="left";
    const gap=14,widths=parts.map(([a,b])=>ctx.measureText(a).width+(b?ctx.measureText(b).width:0));
    const avail=l.width-16;let lines=[[]],lineW=0;
    parts.forEach((p,i)=>{const w=widths[i]+(lines[lines.length-1].length?gap:0);if(lineW+w>avail&&lines[lines.length-1].length){lines.push([]);lineW=0;}lines[lines.length-1].push(i);lineW+=widths[i]+(lines[lines.length-1].length>1?gap:0);});
    const z=this._flowForceZone(l),lh=13,boxH=lines.length*lh+4,boxTop=Math.max(l.top+2,z.top-boxH-2);
    const boxW=Math.min(avail,Math.max(...lines.map(ln=>ln.reduce((s,i,k)=>s+widths[i]+(k?gap:0),0))))+10;
    ctx.fillStyle="rgba(7,11,18,.72)";ctx.fillRect(l.left+6,boxTop,boxW,boxH);
    lines.forEach((ln,row_i)=>{
      let x=l.left+11;const y=boxTop+lh*(row_i+1)-1;
      ln.forEach((i,k)=>{
        if(k)x+=gap;const [label,value,color]=parts[i];
        if(value==null){ctx.fillStyle=color;ctx.fillText(label,x,y);x+=widths[i];}
        else{ctx.fillStyle=dim;ctx.fillText(label,x,y);x+=ctx.measureText(label).width;ctx.fillStyle=color;ctx.fillText(value,x,y);x+=ctx.measureText(value).width;}
      });
    });
    ctx.restore();
  }
  _drawVolumeProfile(ctx,series,l){
    if(!this.showVolumeProfile||!series?.data?.length)return;
    const {first,last}=this._visibleIndexes(),visible=series.data.slice(first,last+1).filter(bar=>Number(bar.volume)>0&&Number.isFinite(Number(bar.low))&&Number.isFinite(Number(bar.high)));
    if(!visible.length)return;
    let low=Math.min(...visible.map(bar=>Number(bar.low))),high=Math.max(...visible.map(bar=>Number(bar.high)));
    if(!Number.isFinite(low)||!Number.isFinite(high)||high<=low)return;
    const binCount=Math.max(20,Math.min(48,Math.round(l.height/12))),step=(high-low)/binCount,bins=Array.from({length:binCount},(_,i)=>({low:low+i*step,high:low+(i+1)*step,up:0,down:0,total:0,valueArea:false}));
    for(const bar of visible){
      const barLow=Math.max(low,Number(bar.low)),barHigh=Math.min(high,Number(bar.high)),volume=Math.max(0,Number(bar.volume)||0),isUp=Number(bar.close)>=Number(bar.open);
      if(!volume)continue;
      if(barHigh<=barLow){const index=Math.max(0,Math.min(binCount-1,Math.floor((Number(bar.close)-low)/step)));bins[index][isUp?"up":"down"]+=volume;continue;}
      const firstBin=Math.max(0,Math.floor((barLow-low)/step)),lastBin=Math.min(binCount-1,Math.floor((barHigh-low)/step));
      let weightSum=0,weights=[];
      for(let i=firstBin;i<=lastBin;i++){const overlap=Math.max(0,Math.min(barHigh,bins[i].high)-Math.max(barLow,bins[i].low));weights.push([i,overlap]);weightSum+=overlap;}
      for(const [i,weight] of weights)bins[i][isUp?"up":"down"]+=volume*(weightSum?weight/weightSum:1/weights.length);
    }
    for(const bin of bins)bin.total=bin.up+bin.down;
    const total=bins.reduce((sum,bin)=>sum+bin.total,0),maxVolume=Math.max(...bins.map(bin=>bin.total));if(!total||!maxVolume)return;
    const pocIndex=bins.reduce((best,bin,index)=>bin.total>bins[best].total?index:best,0);let areaVolume=bins[pocIndex].total,areaLow=pocIndex,areaHigh=pocIndex;bins[pocIndex].valueArea=true;
    while(areaVolume<total*.70&&(areaLow>0||areaHigh<binCount-1)){
      const below=areaLow>0?bins[areaLow-1].total:-1,above=areaHigh<binCount-1?bins[areaHigh+1].total:-1;
      if(above>=below){areaHigh++;areaVolume+=bins[areaHigh].total;bins[areaHigh].valueArea=true;}else{areaLow--;areaVolume+=bins[areaLow].total;bins[areaLow].valueArea=true;}
    }
    const poc=(bins[pocIndex].low+bins[pocIndex].high)/2,vah=bins[areaHigh].high,val=bins[areaLow].low,maxWidth=Math.max(70,Math.min(190,l.width*.30)),xRight=l.right-2;
    ctx.save();ctx.beginPath();ctx.rect(l.left,l.top,l.width,l.height);ctx.clip();
    const level=(price,color,dash,label)=>{const y=this.priceToCoordinate(price);if(!Number.isFinite(y)||y<l.top||y>l.bottom)return;ctx.strokeStyle=color;ctx.lineWidth=label==="POC"?1.5:1;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(l.left,y);ctx.lineTo(l.right,y);ctx.stroke();ctx.setLineDash([]);ctx.font="800 9px 'Courier New',monospace";const text=`${label} ${price.toFixed(2)}`,tw=ctx.measureText(text).width+8;ctx.fillStyle="rgba(7,11,18,.90)";ctx.fillRect(Math.max(l.left+2,xRight-tw),y-8,tw,14);ctx.fillStyle=color;ctx.fillText(text,Math.max(l.left+6,xRight-tw+4),y+2);};
    level(vah,"rgba(34,211,238,.82)",[4,4],"VAH");level(val,"rgba(34,211,238,.82)",[4,4],"VAL");level(poc,"rgba(251,191,36,.95)",[7,3],"POC");
    for(let i=0;i<bins.length;i++){
      const bin=bins[i];if(!bin.total)continue;const top=this.priceToCoordinate(bin.high),bottom=this.priceToCoordinate(bin.low);if(!Number.isFinite(top)||!Number.isFinite(bottom))continue;
      const y=Math.max(l.top,top)+.5,h=Math.max(1,Math.min(l.bottom,bottom)-y-1),width=Math.max(1,bin.total/maxVolume*maxWidth),start=xRight-width,downWidth=width*(bin.down/bin.total),alpha=bin.valueArea ? .46 : .22,barAlpha=i===pocIndex ? .72 : alpha;
      ctx.fillStyle=`rgba(248,113,113,${barAlpha})`;ctx.fillRect(start,y,downWidth,h);
      ctx.fillStyle=`rgba(52,211,153,${barAlpha})`;ctx.fillRect(start+downWidth,y,width-downWidth,h);
    }
    ctx.font="900 9px 'Courier New',monospace";const title="VISIBLE RANGE VOL PROFILE";const titleWidth=ctx.measureText(title).width+9;ctx.fillStyle="rgba(7,11,18,.86)";ctx.fillRect(xRight-titleWidth,l.bottom-17,titleWidth,15);ctx.fillStyle="#b9c9d8";ctx.fillText(title,xRight-titleWidth+5,l.bottom-6);ctx.restore();
  }
  _drawHarmonics(ctx,l){
    if(!this.showButterflies||!Array.isArray(this.butterflies)||!this.butterflies.length||!this._timeline().length)return;
    const lastIdx=this._timeline().length-1,{first,last}=this._visibleIndexes(),r=this.getVisibleLogicalRange(),step=l.width/Math.max(1,r.to-r.from+1);
    ctx.save();ctx.beginPath();ctx.rect(l.left,l.top,l.width,l.height);ctx.clip();
    const recent=this.butterflies.filter(p=>p.status==="FORMING"||p.status==="IN PRZ"||p.status==="ACTIVE");
    for(const p of this.butterflies){
      const idx=p.times.map(t=>t==null?null:this._indexForTime(t));if(idx.some(v=>v==null))continue;
      const endIdx=p.complete?idx[4]:lastIdx;if(endIdx<first-2||idx[0]>last+2)continue;
      const live=recent.includes(p),alpha=live?1:.5,col=p.bull?"52,211,153":"251,113,133";
      const pts=p.pts.map((pt,k)=>({x:this._xForIndex(idx[k]),y:this.priceToCoordinate(pt.p)}));
      if(pts.some(q=>!Number.isFinite(q.x)||!Number.isFinite(q.y)))continue;
      // wings
      ctx.fillStyle=`rgba(${col},${.07*alpha})`;
      ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);ctx.lineTo(pts[1].x,pts[1].y);ctx.lineTo(pts[2].x,pts[2].y);ctx.closePath();ctx.fill();
      if(pts[4]){ctx.beginPath();ctx.moveTo(pts[2].x,pts[2].y);ctx.lineTo(pts[3].x,pts[3].y);ctx.lineTo(pts[4].x,pts[4].y);ctx.closePath();ctx.fill();}
      // legs
      ctx.strokeStyle=`rgba(${col},${.9*alpha})`;ctx.lineWidth=live?1.8:1.2;ctx.setLineDash([]);
      ctx.beginPath();pts.forEach((q,k)=>k?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y));ctx.stroke();
      // ratio diagonals
      ctx.setLineDash([3,4]);ctx.lineWidth=1;ctx.strokeStyle=`rgba(${col},${.5*alpha})`;
      const ratioTag=(a,b,txt)=>{ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;ctx.save();ctx.setLineDash([]);ctx.font="800 9px 'Courier New',monospace";const w=ctx.measureText(txt).width+6;ctx.fillStyle="rgba(7,11,18,.85)";ctx.fillRect(mx-w/2,my-7,w,12);ctx.fillStyle=`rgba(${col},${alpha})`;ctx.fillText(txt,mx-w/2+3,my+2);ctx.restore();};
      ratioTag(pts[0],pts[2],p.ratios.rB.toFixed(3));
      ratioTag(pts[1],pts[3],p.ratios.rC.toFixed(3));
      if(pts[4]){ratioTag(pts[2],pts[4],p.ratios.rD.toFixed(2)+" XA");}
      ctx.setLineDash([]);
      // point letters, placed outside the swing so wick ends stay visible
      ctx.font="900 10px 'Courier New',monospace";
      ["X","A","B","C","D"].slice(0,pts.length).forEach((ch,k)=>{const isHigh=p.pts[k].t==="H",y=pts[k].y+(isHigh?-9:17);ctx.fillStyle=`rgba(${col},${alpha})`;ctx.fillText(ch,pts[k].x-3,y);});
      // PRZ box
      const yHi=this.priceToCoordinate(p.prz.hi),yLo=this.priceToCoordinate(p.prz.lo);
      if(Number.isFinite(yHi)&&Number.isFinite(yLo)){
        const x0=p.complete?pts[4].x-step*2:pts[3].x+step,x1=Math.min(l.right,(p.complete?pts[4].x:this._xForIndex(lastIdx))+step*12);
        const top=Math.min(yHi,yLo),h=Math.max(3,Math.abs(yLo-yHi));
        ctx.fillStyle=`rgba(${col},${(live?.12:.05)})`;ctx.fillRect(x0,top,x1-x0,h);
        ctx.strokeStyle=`rgba(${col},${.7*alpha})`;ctx.setLineDash([5,3]);ctx.strokeRect(x0+.5,top+.5,x1-x0-1,h-1);ctx.setLineDash([]);
      }
      // targets / stop after D
      if(p.complete&&live){
        const xs=pts[4].x,xe=Math.min(l.right,xs+step*14);ctx.font="800 9px 'Courier New',monospace";
        for(const [v,txt,c,dash] of [[p.t1,"T1 .382",`rgba(${col},.9)`,[2,3]],[p.t2,"T2 .618",`rgba(${col},.9)`,[2,3]],[p.stop,"STOP","rgba(248,113,113,.95)",[6,3]]]){
          const y=this.priceToCoordinate(v);if(!Number.isFinite(y))continue;ctx.strokeStyle=c;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(xs,y);ctx.lineTo(xe,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=c;ctx.fillText(`${txt} ${v.toFixed(2)}`,xe+3,y+3);
        }
      }
      // headline tag beyond the D side of the PRZ
      const anchor=pts[4]||pts[3],beyond=p.bull?Math.max(yHi,yLo)+16:Math.min(yHi,yLo)-8;
      const flowTxt=p.flow?` · FLOW ${p.flow.with_>=p.flow.against?"✓":"✕"}`:"";
      const head=`${p.bull?"▲ BULL":"▼ BEAR"} BUTTERFLY ${p.score} · ${p.status}${flowTxt}`;
      ctx.font="900 10px 'Courier New',monospace";const tw=ctx.measureText(head).width+10;
      const hx=Math.max(l.left+2,Math.min(l.right-tw-2,anchor.x-tw/2)),hy=Math.max(l.top+14,Math.min(l.bottom-4,beyond));
      ctx.fillStyle=p.bull?`rgba(4,45,36,${.92*alpha})`:`rgba(58,18,27,${.92*alpha})`;ctx.fillRect(hx,hy-11,tw,15);
      ctx.strokeStyle=`rgba(${col},${.8*alpha})`;ctx.strokeRect(hx+.5,hy-10.5,tw-1,14);ctx.fillStyle=`rgba(${col},${alpha})`;ctx.fillText(head,hx+5,hy);
    }
    ctx.restore();
  }
  _drawSupplyDemand(ctx,l){
    if(!this.showSupplyDemand)return;
    const timeline=this._timeline();if(!timeline.length)return;
    const range=this.getVisibleLogicalRange();
    ctx.save();
    const nt=this.supplyDemandNoTradeArea;
    if(nt&&Number.isFinite(nt.low)&&Number.isFinite(nt.high)&&nt.high>nt.low){
      const yTop=this.priceToCoordinate(nt.high),yBot=this.priceToCoordinate(nt.low);
      if(Number.isFinite(yTop)&&Number.isFinite(yBot)){
        const top=Math.min(yTop,yBot),bottom=Math.max(yTop,yBot);
        if(!(bottom<l.top||top>l.bottom)){
          ctx.fillStyle="rgba(251,191,36,.045)";ctx.strokeStyle="rgba(251,191,36,.28)";ctx.setLineDash([3,5]);
          ctx.fillRect(l.left,top,l.width,Math.max(2,bottom-top));ctx.strokeRect(l.left+.5,top+.5,l.width-1,Math.max(1,bottom-top-1));ctx.setLineDash([]);
          const ntLabel=`NO TRADE / WAIT FOR EDGE  ${nt.low.toFixed(2)}–${nt.high.toFixed(2)}`;
          ctx.font="800 9px 'Courier New',monospace";const tw=ctx.measureText(ntLabel).width+10;
          const lx=Math.max(l.left+4,l.right-tw-5),ly=Math.max(l.top+12,Math.min(l.bottom-3,top+13));
          ctx.fillStyle="rgba(55,40,10,.92)";ctx.fillRect(lx,ly-10,tw,14);ctx.fillStyle="#fbbf24";ctx.fillText(ntLabel,lx+5,ly);
        }
      }
    }
    if(!Array.isArray(this.supplyDemandZones)||!this.supplyDemandZones.length){ctx.restore();return;}
    for(const z of this.supplyDemandZones){
      if(!z||z.state==="broken")continue;
      const startIndex=this._indexForTime(z.startTime);
      if(startIndex>range.to+2)continue;
      const x1=Math.max(l.left,this._xForIndex(Math.max(range.from,startIndex)));
      const x2=l.right;
      const yTop=this.priceToCoordinate(z.high),yBot=this.priceToCoordinate(z.low);
      if(!Number.isFinite(yTop)||!Number.isFinite(yBot))continue;
      const top=Math.min(yTop,yBot),bottom=Math.max(yTop,yBot);
      if(bottom<l.top||top>l.bottom)continue;
      const isDemand=z.type==="demand",tested=z.state==="tested";
      ctx.fillStyle=isDemand?(tested?"rgba(16,185,129,.075)":"rgba(16,185,129,.13)"):(tested?"rgba(244,63,94,.075)":"rgba(244,63,94,.13)");
      ctx.strokeStyle=isDemand?(tested?"rgba(52,211,153,.48)":"rgba(52,211,153,.82)"):(tested?"rgba(251,113,133,.48)":"rgba(251,113,133,.82)");
      ctx.lineWidth=z.score>=80?1.8:1;ctx.setLineDash(tested?[5,4]:[]);
      ctx.fillRect(x1,top,Math.max(2,x2-x1),Math.max(2,bottom-top));ctx.strokeRect(x1+.5,top+.5,Math.max(1,x2-x1-1),Math.max(1,bottom-top-1));ctx.setLineDash([]);
      const tags=[];if(z.components?.gex>=12)tags.push("GEX");if(z.components?.flow>=12)tags.push("FLOW");if(z.components?.trend>=12)tags.push("VWAP/EMA");
      const label=`${isDemand?"DEMAND":"SUPPLY"} ${z.low.toFixed(2)}–${z.high.toFixed(2)} · ${Math.round(z.score)}/100 · ${String(z.state||"fresh").toUpperCase()}${tags.length?" · "+tags.join("+"):""}`;
      ctx.font="800 9px 'Courier New',monospace";const tw=ctx.measureText(label).width+10;
      const lx=Math.max(l.left+2,Math.min(l.right-tw-2,x1+4)),ly=Math.max(l.top+12,Math.min(l.bottom-3,top+13));
      ctx.fillStyle=isDemand?"rgba(3,47,38,.93)":"rgba(65,18,28,.93)";ctx.fillRect(lx,ly-10,tw,14);ctx.fillStyle=isDemand?"#6ee7b7":"#fda4af";ctx.fillText(label,lx+5,ly);
    }
    ctx.restore();
  }
  _drawSupplyDemandSignals(ctx,l){
    if(!Array.isArray(this.supplyDemandSignals)||!this.supplyDemandSignals.length)return;
    const range=this.getVisibleLogicalRange();ctx.save();
    for(const sig of this.supplyDemandSignals){
      if(!sig||!Number.isFinite(Number(sig.time))||!Number.isFinite(Number(sig.price)))continue;
      const idx=this._indexForTime(sig.time);if(idx<range.from-2||idx>range.to+2)continue;
      const x=this._xForIndex(idx),isCall=sig.type==="call",priceY=this.priceToCoordinate(sig.price);if(!Number.isFinite(x)||!Number.isFinite(priceY))continue;
      const markerY=isCall?Math.min(l.bottom-18,priceY+13):Math.max(l.top+18,priceY-13),tipY=isCall?priceY+2:priceY-2;
      ctx.fillStyle=isCall?"#34d399":"#f87171";ctx.strokeStyle=isCall?"rgba(52,211,153,.95)":"rgba(248,113,113,.95)";ctx.lineWidth=1.25;
      ctx.beginPath();
      if(isCall){ctx.moveTo(x,tipY);ctx.lineTo(x-6,markerY);ctx.lineTo(x+6,markerY);}else{ctx.moveTo(x,tipY);ctx.lineTo(x-6,markerY);ctx.lineTo(x+6,markerY);}
      ctx.closePath();ctx.fill();ctx.stroke();
      const tierLabel=sig.strength==="very-strong"?"VERY STRONG":sig.strength==="strong"?"STRONG":"";
      const label=`${isCall?"▲":"▼"} ${tierLabel?`${tierLabel} `:""}${isCall?"CALL":"PUT"} ${Math.round(Number(sig.confidence)||0)}%`;
      ctx.font="900 11px 'Courier New',monospace";const tw=ctx.measureText(label).width+14,boxH=20;
      let bx=x-tw/2,by=isCall?markerY+5:markerY-boxH-5;bx=Math.max(l.left+2,Math.min(l.right-tw-2,bx));by=Math.max(l.top+2,Math.min(l.bottom-boxH-2,by));
      ctx.fillStyle=isCall?"rgba(3,47,38,.96)":"rgba(65,18,28,.96)";ctx.strokeStyle=isCall?"rgba(52,211,153,.86)":"rgba(248,113,113,.86)";ctx.lineWidth=1;
      ctx.beginPath();ctx.roundRect?.(bx,by,tw,boxH,4);if(ctx.roundRect){ctx.fill();ctx.stroke();}else{ctx.fillRect(bx,by,tw,boxH);ctx.strokeRect(bx+.5,by+.5,tw-1,boxH-1);}
      ctx.fillStyle=isCall?"#6ee7b7":"#fda4af";ctx.fillText(label,bx+7,by+14);
    }
    ctx.restore();
  }
  _drawCandles(ctx,series,l){const {first,last}=this._visibleIndexes(),range=this.getVisibleLogicalRange(),step=l.width/Math.max(1,range.to-range.from+1),bodyW=Math.max(1,Math.min(18,step*.68));for(let i=first;i<=last;i++){const b=series.data[i];if(!b)continue;const x=this._xForIndex(i),openY=this.priceToCoordinate(b.open),closeY=this.priceToCoordinate(b.close),highY=this.priceToCoordinate(b.high),lowY=this.priceToCoordinate(b.low),up=Number(b.close)>=Number(b.open),color=up?(series.options.upColor||"#26a69a"):(series.options.downColor||"#ef5350");ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,highY);ctx.lineTo(x,lowY);ctx.stroke();ctx.fillStyle=color;const top=Math.min(openY,closeY),height=Math.max(1,Math.abs(closeY-openY));ctx.fillRect(x-bodyW/2,top,bodyW,height);}
    if(window.osShowHammerPatterns&&step>=13){
      ctx.save();ctx.font="800 9px 'Courier New',monospace";ctx.textAlign="center";
      const end=Math.min(last,series.data.length-2),occupied=[];
      for(let i=first;i<=end;i++){
        const matches=osCandlePatterns(series.data,i);if(!matches.length)continue;
        const best=matches[0],x=this._xForIndex(i),y=this.priceToCoordinate(series.data[i].low)+16;
        if(y>l.bottom-8||x<l.left+35||x>l.right-35)continue;
        // Keep labels legible at narrow zoom levels; prioritize more specific formations.
        if(occupied.some(v=>Math.abs(v.x-x)<Math.max(50,step*1.2)&&Math.abs(v.y-y)<17&&v.priority>=best.priority))continue;
        const label=best.name.replace(/ Pattern| Candlestick/g,'').toUpperCase(),short=label.length>15?label.slice(0,14)+'…':label;
        const color=best.bias>0?'#34d399':best.bias<0?'#fb7185':'#a78bfa',w=ctx.measureText(short).width+10;
        ctx.fillStyle='rgba(7,11,18,.94)';ctx.fillRect(x-w/2,y-10,w,14);
        ctx.fillStyle=color;ctx.fillText(short,x,y);
        occupied.push({x,y,priority:best.priority});
      }
      ctx.restore();
    }
    const lastBar=series.data[series.data.length-1];if(lastBar&&series.options.priceLineVisible!==false){const y=this.priceToCoordinate(lastBar.close);if(Number.isFinite(y)&&y>=l.top&&y<=l.bottom){ctx.save();ctx.strokeStyle=Number(lastBar.close)>=Number(lastBar.open)?"rgba(38,166,154,.65)":"rgba(239,83,80,.65)";ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(l.left,y);ctx.lineTo(l.right,y);ctx.stroke();ctx.restore();this._axisTag(ctx,l,y,Number(lastBar.close).toFixed(2),Number(lastBar.close)>=Number(lastBar.open)?"#16877e":"#b93838");}}}
  _drawLineSeries(ctx,series,l){if(!series.data.length)return;ctx.save();ctx.strokeStyle=series.options.color||"#38bdf8";ctx.lineWidth=Math.max(1,Number(series.options.lineWidth)||1);ctx.setLineDash(this._lineDash(series.options.lineStyle));ctx.beginPath();let started=false;for(const p of series.data){const i=this._indexForTime(p.time),range=this.getVisibleLogicalRange();if(i<range.from-1||i>range.to+1)continue;const x=this._xForIndex(i),y=this.priceToCoordinate(p.value);if(!Number.isFinite(x)||!Number.isFinite(y))continue;if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);}if(started)ctx.stroke();ctx.restore();}
  _drawPriceLines(ctx,l){for(const series of this.series)for(const line of series.priceLines){const y=this.priceToCoordinate(line.price);if(!Number.isFinite(y)||y<l.top||y>l.bottom)continue;ctx.save();ctx.strokeStyle=line.color||"#38bdf8";ctx.lineWidth=Math.max(1,Number(line.lineWidth)||1);ctx.setLineDash(this._lineDash(line.lineStyle));ctx.beginPath();ctx.moveTo(l.left,y);ctx.lineTo(l.right,y);ctx.stroke();ctx.setLineDash([]);ctx.font="700 9px 'Courier New',monospace";const title=String(line.title||"");if(title){const w=ctx.measureText(title).width+8;ctx.fillStyle="rgba(7,11,18,.9)";ctx.fillRect(Math.max(l.left,l.right-w),y-9,w,15);ctx.fillStyle=line.color||"#38bdf8";ctx.fillText(title,Math.max(l.left+4,l.right-w+4),y+2);}ctx.restore();}}
  _axisTag(ctx,l,y,text,color){ctx.save();ctx.font="700 10px 'Courier New',monospace";const w=Math.max(48,ctx.measureText(text).width+10);ctx.fillStyle=color;ctx.fillRect(l.right,y-9,w,18);ctx.fillStyle="#fff";ctx.fillText(text,l.right+5,y+4);ctx.restore();}
  _drawAxes(ctx,l){const b=this._priceBounds();ctx.save();ctx.font="10px 'Courier New',monospace";ctx.fillStyle=this.options.layout?.textColor||"#91a7bb";ctx.strokeStyle=this.options.rightPriceScale?.borderColor||"#223149";ctx.beginPath();ctx.moveTo(l.right+.5,l.top);ctx.lineTo(l.right+.5,l.bottom);ctx.stroke();if(l.rightVisible){for(let i=0;i<=6;i++){const y=l.top+l.height*i/6,value=b.max-(b.max-b.min)*i/6;ctx.fillText(value.toFixed(b.max-b.min<10?2:1),l.right+6,y+3);}}
    if(l.timeVisible){ctx.beginPath();ctx.moveTo(l.left,l.bottom+.5);ctx.lineTo(l.right,l.bottom+.5);ctx.stroke();const data=this._timeline(),r=this.getVisibleLogicalRange();for(let i=0;i<=7;i++){const index=Math.max(0,Math.min(data.length-1,Math.round(r.from+(r.to-r.from)*i/7))),bar=data[index];if(!bar)continue;const label=formatMarketTime(chartTimeDate(bar.time),false,false),x=this._xForIndex(index),w=ctx.measureText(label).width;ctx.fillText(label,Math.max(l.left,Math.min(l.right-w,x-w/2)),l.bottom+18);}}ctx.restore();}
  _drawDrawings(ctx){
    const l=this._layout(),all=[...this.drawings];
    if(swiftAutoDILinesEnabled){
      const r=this.getVisibleLogicalRange();
      for(const c of swiftAutoDICrosses){
        if(c.index<r.from-1||c.index>r.to+1)continue;
        const x=this._xForIndex(c.index);
        ctx.save();ctx.strokeStyle=c.bullish?'#34d399':'#f87171';ctx.lineWidth=1.6;
        ctx.setLineDash([6,4]);ctx.beginPath();ctx.moveTo(x,l.top);ctx.lineTo(x,l.bottom);ctx.stroke();
        ctx.setLineDash([]);ctx.font="bold 10px Courier New";
        ctx.fillStyle=c.bullish?'#34d399':'#f87171';
        ctx.fillText((c.bullish?'+DI ↑':'-DI ↓')+' '+c.adx.toFixed(1),x+4,l.top+28);
        ctx.restore();
      }
    }
    if(this.drawingMode&&this.pointer){
      const hover=this._pointFromCoordinates(this.pointer.x,this.pointer.y);
      if(hover&&(["horizontal","vertical"].includes(this.drawingTool)||this.drawingPoints.length))all.push({type:this.drawingTool,points:["horizontal","vertical"].includes(this.drawingTool)?[hover]:[...this.drawingPoints,hover],extend:this.drawingTool==="trend"&&this.extendTrend,preview:true});
    }
    const screenPoint=point=>({x:this.timeToCoordinate(point.time),y:this.priceToCoordinate(point.price),source:point});
    const lineAt=(a,b,x)=>Math.abs(b.x-a.x)<.001?a.y:a.y+(b.y-a.y)*(x-a.x)/(b.x-a.x);
    const stroke=(a,b)=>{ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();};
    ctx.save();ctx.beginPath();ctx.rect(l.left,l.top,l.width,l.height);ctx.clip();ctx.lineWidth=2;
    for(const drawing of all){
      const points=(drawing.points||[]).map(screenPoint).filter(point=>Number.isFinite(point.x)&&Number.isFinite(point.y));
      if(!points.length)continue;
      const color=drawing.type==="channel"?"#22d3ee":drawing.type==="vertical"?"#a78bfa":drawing.type==="horizontal"?"#fbbf24":"#60a5fa",selected=drawing===this.selectedDrawing,hovered=drawing===this.hoverDrawing,drawColor=selected?"#e2e8f0":hovered?"#93c5fd":color;
      ctx.globalAlpha=drawing.preview?.62:1;ctx.strokeStyle=drawColor;ctx.fillStyle=drawColor;ctx.lineWidth=selected||hovered?3:2;ctx.setLineDash(drawing.preview?[6,4]:[]);
      if(drawing.type==="vertical"){
        stroke({x:points[0].x,y:l.top},{x:points[0].x,y:l.bottom});
      }else if(drawing.type==="horizontal"){
        stroke({x:l.left,y:points[0].y},{x:l.right,y:points[0].y});
      }else if(points.length>=2&&drawing.type==="ray"){
        const [a,b]=points;if(Math.abs(b.x-a.x)<.001){stroke(a,{x:a.x,y:b.y>=a.y?l.bottom:l.top});}else{const edge=b.x>=a.x?l.right:l.left,target={x:edge,y:lineAt(a,b,edge)};stroke(a,target);}
      }else if(points.length>=2&&drawing.type==="trend"){
        const [a,b]=points;if(drawing.extend){if(Math.abs(b.x-a.x)<.001)stroke({x:a.x,y:l.top},{x:a.x,y:l.bottom});else stroke({x:l.left,y:lineAt(a,b,l.left)},{x:l.right,y:lineAt(a,b,l.right)});}else stroke(a,b);
      }else if(drawing.type==="channel"&&points.length>=3){
        const [a,b,c]=points;if(Math.abs(b.x-a.x)<.001){const x1=a.x,x2=c.x;ctx.save();ctx.globalAlpha=drawing.preview?.08:.12;ctx.fillStyle="#22d3ee";ctx.fillRect(Math.min(x1,x2),l.top,Math.abs(x2-x1),l.height);ctx.restore();ctx.globalAlpha=drawing.preview?.62:1;ctx.strokeStyle=drawColor;stroke({x:x1,y:l.top},{x:x1,y:l.bottom});stroke({x:x2,y:l.top},{x:x2,y:l.bottom});ctx.setLineDash([3,4]);stroke({x:(x1+x2)/2,y:l.top},{x:(x1+x2)/2,y:l.bottom});}else{const baseLeft=lineAt(a,b,l.left),baseRight=lineAt(a,b,l.right),offset=c.y-lineAt(a,b,c.x),otherLeft=baseLeft+offset,otherRight=baseRight+offset;ctx.save();ctx.globalAlpha=drawing.preview?.08:.12;ctx.fillStyle="#22d3ee";ctx.beginPath();ctx.moveTo(l.left,baseLeft);ctx.lineTo(l.right,baseRight);ctx.lineTo(l.right,otherRight);ctx.lineTo(l.left,otherLeft);ctx.closePath();ctx.fill();ctx.restore();ctx.globalAlpha=drawing.preview?.62:1;ctx.strokeStyle=drawColor;ctx.setLineDash(drawing.preview?[6,4]:[]);stroke({x:l.left,y:baseLeft},{x:l.right,y:baseRight});stroke({x:l.left,y:otherLeft},{x:l.right,y:otherRight});ctx.setLineDash([3,4]);stroke({x:l.left,y:baseLeft+offset/2},{x:l.right,y:baseRight+offset/2});}
      }else if(points.length>=2){stroke(points[0],points[1]);}
      ctx.setLineDash([]);
      if(drawing.preview||selected)for(const point of points){ctx.beginPath();ctx.arc(point.x,point.y,point.source.snappedTo?5:4,0,Math.PI*2);ctx.fillStyle=point.source.snappedTo?"#fbbf24":drawColor;ctx.fill();ctx.strokeStyle="#07111d";ctx.lineWidth=1;ctx.stroke();if(point.source.snappedTo&&drawing.preview){ctx.font="800 9px 'Courier New',monospace";ctx.fillText(point.source.snappedTo,point.x+6,point.y-6);}}
    }
    ctx.restore();
    if(typeof scheduleSwiftVerticalExtensions==="function")scheduleSwiftVerticalExtensions();
  }
  _drawCrosshair(ctx,l){
    if(!this.pointer||this.drag||this.editDrag)return;
    const {x,y}=this.pointer;
    if(x<l.left||x>l.right||y<l.top||y>l.bottom)return;
    ctx.save();
    ctx.strokeStyle="rgba(159,180,200,.55)";
    ctx.setLineDash([4,4]);
    ctx.beginPath();
    ctx.moveTo(x,l.top);ctx.lineTo(x,l.bottom);ctx.moveTo(l.left,y);ctx.lineTo(l.right,y);ctx.stroke();
    ctx.setLineDash([]);
    if(l.rightVisible)this._axisTag(ctx,l,y,this.coordinateToPrice(y).toFixed(2),"#374b63");

    const data=this._timeline(),r=this.getVisibleLogicalRange();
    const index=Math.max(0,Math.min(data.length-1,Math.round(r.from+((x-l.left)/l.width)*(r.to-r.from))));
    const bar=this.series.find(s=>s.type==="candles")?.data[index];
    if(bar){
      const hoverTime=formatChartHoverTime(bar.time);
      const contracts=tvCandleContractTotals.get(Number(bar.time));
      const callContracts=Math.round(Number(contracts?.callContracts)||0);
      const putContracts=Math.round(Number(contracts?.putContracts)||0);
      const callPremium=Math.max(0,Number(contracts?.callPremium)||0);
      const putPremium=Math.max(0,Number(contracts?.putPremium)||0);
      const totalPremium=callPremium+putPremium;
      const fmtDollar=v=>v>=1e9?`$${(v/1e9).toFixed(2)}B`:v>=1e6?`$${(v/1e6).toFixed(2)}M`:v>=1e3?`$${(v/1e3).toFixed(1)}K`:`$${Math.round(v).toLocaleString("en-US")}`;
      const timeText=hoverTime;
      const callText=`CALL ${callContracts.toLocaleString("en-US")} CONTRACTS · ${fmtDollar(callPremium)}`;
      const putText=`PUT  ${putContracts.toLocaleString("en-US")} CONTRACTS · ${fmtDollar(putPremium)}`;
      const volumeText=`OPTION $ VOLUME ${fmtDollar(totalPremium)}`;
      const candleX=this._xForIndex(index);
      const candleTop=this.priceToCoordinate(Math.max(Number(bar.open),Number(bar.close)));
      const candleBottom=this.priceToCoordinate(Math.min(Number(bar.open),Number(bar.close)));
      const candleMid=Number.isFinite(candleTop)&&Number.isFinite(candleBottom)?(candleTop+candleBottom)/2:y;

      // Keep contract totals beside the hovered candle instead of in a fixed
      // upper-left legend. The tooltip flips sides near the chart edge.
      ctx.font="800 10px 'Courier New',monospace";
      const tooltipWidth=Math.max(172,ctx.measureText(timeText).width+18,ctx.measureText(callText).width+18,ctx.measureText(putText).width+18,ctx.measureText(volumeText).width+18);
      const tooltipHeight=68,gap=12;
      let tooltipLeft=candleX+gap;
      if(tooltipLeft+tooltipWidth>l.right-5)tooltipLeft=candleX-gap-tooltipWidth;
      tooltipLeft=Math.max(l.left+5,Math.min(l.right-tooltipWidth-5,tooltipLeft));
      const tooltipTop=Math.max(l.top+5,Math.min(l.bottom-tooltipHeight-5,candleMid-tooltipHeight/2));

      ctx.fillStyle="rgba(7,11,18,.96)";
      ctx.fillRect(tooltipLeft,tooltipTop,tooltipWidth,tooltipHeight);
      ctx.strokeStyle="rgba(56,189,248,.48)";
      ctx.strokeRect(tooltipLeft+.5,tooltipTop+.5,tooltipWidth-1,tooltipHeight-1);
      ctx.fillStyle="#d8e6f5";
      ctx.fillText(timeText,tooltipLeft+9,tooltipTop+14);
      ctx.fillStyle="#ff7183";
      ctx.fillText(putText,tooltipLeft+9,tooltipTop+31);
      ctx.fillStyle="#55e6b2";
      ctx.fillText(callText,tooltipLeft+9,tooltipTop+46);
      ctx.fillStyle="#7dd3fc";
      ctx.fillText(volumeText,tooltipLeft+9,tooltipTop+61);

      if(l.timeVisible){
        ctx.font="800 10px 'Courier New',monospace";
        const tagWidth=Math.min(l.width,ctx.measureText(hoverTime).width+16),tagHeight=20;
        const tagLeft=Math.max(l.left,Math.min(l.right-tagWidth,x-tagWidth/2)),tagTop=l.bottom+3;
        ctx.fillStyle="#374b63";ctx.fillRect(tagLeft,tagTop,tagWidth,tagHeight);
        ctx.strokeStyle="#66809b";ctx.strokeRect(tagLeft+.5,tagTop+.5,tagWidth-1,tagHeight-1);
        ctx.fillStyle="#f2f7fb";ctx.textAlign="center";ctx.textBaseline="middle";
        ctx.fillText(hoverTime,tagLeft+tagWidth/2,tagTop+tagHeight/2);
        ctx.textAlign="left";ctx.textBaseline="alphabetic";
      }
    }
    ctx.restore();
  }
  render(){if(this.frame!=null)return;const raf=globalThis.requestAnimationFrame||((fn)=>setTimeout(fn,16));this.frame=raf(()=>{this.frame=null;this._renderNow();});}
  _renderNow(){if(!this.ctx||!this.width||!this.height)return;const ctx=this.ctx,l=this._layout();ctx.setTransform(this.dpr,0,0,this.dpr,0,0);ctx.fillStyle=this.options.layout?.background?.color||"#070b12";ctx.fillRect(0,0,this.width,this.height);this._drawGrid(ctx,l);const candles=this.series.find(s=>s.type==="candles"),hist=this.series.filter(s=>s.type==="histogram");for(const s of hist.filter(s=>s.options.priceScaleId==="flow-volume"))this._drawHistogram(ctx,s,l,true);this._drawSupplyDemand(ctx,l);this._drawFlowForce(ctx,l);if(candles)this._drawCandles(ctx,candles,l);for(const s of this.series.filter(s=>s.type==="line"))this._drawLineSeries(ctx,s,l);this._drawHarmonics(ctx,l);this._drawSupplyDemandSignals(ctx,l);if(candles)this._drawVolumeProfile(ctx,candles,l);this._drawFlowForceLegend(ctx,l);if(!candles)for(const s of hist.filter(s=>s.options.priceScaleId!=="flow-volume"))this._drawHistogram(ctx,s,l,false);this._drawPriceLines(ctx,l);this._drawDrawings(ctx);this._drawAxes(ctx,l);this._drawCrosshair(ctx,l);if(!this._timeline().length){ctx.fillStyle=this.options.layout?.textColor||"#647a91";ctx.font="700 12px 'Courier New',monospace";ctx.fillText("Waiting for Massive candle data…",18,38);}}
}


// ── SPY SUPPLY / DEMAND ENGINE · 5M STRUCTURE + 1M 0DTE TRIGGER ──────────
let tvSupplyDemandEnabled=true;
let tvSupplyDemandZones=[];
let tvSupplyDemandNoTradeArea=null;
let tvSupplyDemandSignals=[];
let sdLastSignalKey="";
let osAiSignalLatched=false;
let osAiSignalLatchedSide="";
let sdGexContext={rows:[],callWall:null,putWall:null,netGex:0,updatedAt:0};
const SD_CONFIG={pivot:3,atrPeriod:14,impulseAtr:1.05,zoneAtr:0.52,minScore:50,maxZones:10,breakAtr:0.18,mergeAtr:0.30,majorTf:5,flowLookbackMs:30*60*1000};
function sdAtr(bars,p=14){
  const out=new Array(bars.length).fill(0),trs=[];
  for(let i=0;i<bars.length;i++){const h=Number(bars[i].high),l=Number(bars[i].low),prev=i?Number(bars[i-1].close):Number(bars[i].open);const tr=Math.max(h-l,Math.abs(h-prev),Math.abs(l-prev));trs.push(tr);const from=Math.max(0,i-p+1);let sum=0;for(let j=from;j<=i;j++)sum+=trs[j];out[i]=sum/(i-from+1);}return out;
}
function sdVolumeAvg(bars,i,n=20){let sum=0,c=0;for(let j=Math.max(0,i-n+1);j<=i;j++){const v=Number(bars[j].volume)||0;if(v>0){sum+=v;c++;}}return c?sum/c:0;}
function sdFlowComponents(startMs=Date.now()-SD_CONFIG.flowLookbackMs){
  const out={askCall:0,bidPut:0,askPut:0,bidCall:0,total:0,available:false};
  try{for(const r of (Array.isArray(pressurePrints)?pressurePrints:[])){const ts=tapeTsMs(r.ts||r.timestamp||r.time)||0;if(ts<startMs)continue;const prem=Math.max(0,Number(r.prem??r.premium??r.notional??0));if(prem<100000)continue;const side=String(r.side||"").toLowerCase(),execution=String(r.execution||"").toUpperCase();if(side==="call"&&execution==="ASK BUY")out.askCall+=prem;else if(side==="put"&&execution==="BID SELL")out.bidPut+=prem;else if(side==="put"&&execution==="ASK BUY")out.askPut+=prem;else if(side==="call"&&execution==="BID SELL")out.bidCall+=prem;}out.total=out.askCall+out.bidPut+out.askPut+out.bidCall;out.available=out.total>0;}catch(_){}return out;
}
function sdFlowScore(type,startMs){
  const f=sdFlowComponents(Math.max(startMs||0,Date.now()-SD_CONFIG.flowLookbackMs));if(!f.available)return{score:0,available:false,...f,favorable:0,adverse:0};
  const favorable=type==="demand"?f.askCall+f.bidPut:f.askPut+f.bidCall,adverse=type==="demand"?f.askPut+f.bidCall:f.askCall+f.bidPut,total=favorable+adverse;
  const ratio=total?favorable/total:.5;return{score:Math.max(0,Math.min(20,ratio*20)),available:true,...f,favorable,adverse};
}
function sdGexScore(type,low,high){
  const rows=Array.isArray(sdGexContext.rows)?sdGexContext.rows:[];if(!rows.length)return{score:0,available:false,near:null,label:"GEX unavailable"};
  const mid=(low+high)/2,near=[...rows].sort((a,b)=>Math.abs(a.s-mid)-Math.abs(b.s-mid)).slice(0,3),maxAbs=Math.max(1,...rows.map(r=>Math.abs((r.cg||0)-(r.pg||0))));
  let weighted=0,weights=0;for(const r of near){const dist=Math.abs(r.s-mid),w=1/(1+dist),net=(r.cg||0)-(r.pg||0);weighted+=net*w;weights+=w;}const local=weights?weighted/weights:0;
  let alignment=type==="demand"?Math.max(0,local/maxAbs):Math.max(0,-local/maxAbs);let wallBoost=0,label="local GEX";
  if(type==="demand"&&sdGexContext.putWall){const d=Math.abs(sdGexContext.putWall.s-mid);if(d<=Math.max(2,(high-low)*5)){wallBoost=.28;label="put-wall/GEX support";}}
  if(type==="supply"&&sdGexContext.callWall){const d=Math.abs(sdGexContext.callWall.s-mid);if(d<=Math.max(2,(high-low)*5)){wallBoost=.28;label="call-wall/GEX resistance";}}
  const score=Math.min(20,(alignment*.72+wallBoost)*20);return{score,available:true,near:near[0]||null,local,label};
}
function sdTrendScore(type,bars,i){
  if(!bars?.length)return{score:0,ema9:null,ema21:null,vwap:null};const d=studyData(bars),idx=Math.max(0,Math.min(i,bars.length-1)),close=Number(bars[idx].close),ema9=Number(d.ema9[idx]?.value),ema21=Number(d.ema21[idx]?.value),vwap=Number(d.vwap[idx]?.value);let pts=0;
  if(type==="demand"){if(close>=vwap)pts+=10;if(ema9>=ema21)pts+=10;}else{if(close<=vwap)pts+=10;if(ema9<=ema21)pts+=10;}return{score:pts,ema9,ema21,vwap,close};
}
function sdMajorBars(){
  if(tvTimeframe===1)return aggregateBars(tvBars,SD_CONFIG.majorTf);
  return tvBars;
}
function computeSupplyDemandZones(bars){
  if(!Array.isArray(bars)||bars.length<12)return[];const atr=sdAtr(bars,SD_CONFIG.atrPeriod),p=SD_CONFIG.pivot,zones=[];
  for(let i=p;i<bars.length-p-2;i++){
    const b=bars[i],a=Math.max(.01,atr[i]||0),low=Number(b.low),high=Number(b.high),open=Number(b.open),close=Number(b.close);let pivotLow=true,pivotHigh=true;
    for(let j=i-p;j<=i+p;j++){if(j===i)continue;if(Number(bars[j].low)<=low)pivotLow=false;if(Number(bars[j].high)>=high)pivotHigh=false;}
    const forward=bars.slice(i+1,Math.min(bars.length,i+6));if(!forward.length)continue;const maxH=Math.max(...forward.map(x=>Number(x.high))),minL=Math.min(...forward.map(x=>Number(x.low))),upImpulse=maxH-high,downImpulse=low-minL,volAvg=sdVolumeAvg(bars,i),vol=Number(b.volume)||0,volRatio=volAvg?vol/volAvg:1;
    let type=null,impulse=0;if(pivotLow&&upImpulse>=a*SD_CONFIG.impulseAtr){type="demand";impulse=upImpulse/a;}if(pivotHigh&&downImpulse>=a*SD_CONFIG.impulseAtr&&(!type||downImpulse>upImpulse)){type="supply";impulse=downImpulse/a;}if(!type)continue;
    const bodyLow=Math.min(open,close),bodyHigh=Math.max(open,close),width=Math.max(a*.16,Math.min(a*SD_CONFIG.zoneAtr,(high-low)*.72));let zLow,zHigh;if(type==="demand"){zLow=low;zHigh=Math.min(bodyHigh,low+width);}else{zHigh=high;zLow=Math.max(bodyLow,high-width);}if(zHigh<=zLow){zLow=low;zHigh=high;}
    const wick=type==="demand"?(Math.min(open,close)-low):(high-Math.max(open,close));const rejection=Math.min(25,8+Math.max(0,impulse-SD_CONFIG.impulseAtr)*8+Math.min(8,Math.max(0,wick/a)*12));const volumeScore=Math.min(15,Math.max(0,(volRatio-.75))*12);
    const gex=sdGexScore(type,zLow,zHigh),flow=sdFlowScore(type,Number(b.time)*1000),trend=sdTrendScore(type,bars,i);let score=rejection+volumeScore+gex.score+flow.score+trend.score;
    if(!gex.available)score=Math.min(score,85);if(!flow.available)score=Math.min(score,80);if(!gex.available&&!flow.available)score=Math.min(score,65);score=Math.max(0,Math.min(100,score));if(score<SD_CONFIG.minScore)continue;
    let state="fresh",tests=0,broken=false;for(let j=i+2;j<bars.length;j++){const x=bars[j],xa=Math.max(.01,atr[j]||a),xh=Number(x.high),xl=Number(x.low),xc=Number(x.close);if(type==="demand"&&xc<zLow-xa*SD_CONFIG.breakAtr){broken=true;break;}if(type==="supply"&&xc>zHigh+xa*SD_CONFIG.breakAtr){broken=true;break;}if(xh>=zLow&&xl<=zHigh){tests++;state="tested";}}
    if(broken)continue;const repeatBonus=Math.min(6,tests*2);score=Math.max(35,Math.min(100,score+repeatBonus-Math.max(0,tests-2)*5));const components={rejection,volume:volumeScore,gex:gex.score,flow:flow.score,trend:trend.score};
    const candidate={type,low:zLow,high:zHigh,score,state,tests,startTime:Number(b.time),pivotIndex:i,sourceTf:tvTimeframe===1?5:tvTimeframe,components,gex,flow,trend};const existing=zones.find(z=>z.type===type&&Math.abs(((z.low+z.high)/2)-((candidate.low+candidate.high)/2))<=a*SD_CONFIG.mergeAtr);if(existing){if(candidate.score>existing.score)Object.assign(existing,candidate);}else zones.push(candidate);
  }
  const last=Number(bars[bars.length-1].close);zones.sort((a,b)=>{const da=Math.abs(((a.low+a.high)/2)-last),db=Math.abs(((b.low+b.high)/2)-last);return (b.score-a.score)*3+(da-db);});const half=Math.floor(SD_CONFIG.maxZones/2),demand=zones.filter(z=>z.type==="demand").slice(0,half),supply=zones.filter(z=>z.type==="supply").slice(0,half);return[...demand,...supply].sort((a,b)=>a.low-b.low);
}
function sdNoTradeArea(zones,current){
  const demand=zones.filter(z=>z.type==="demand"&&z.high<current).sort((a,b)=>b.high-a.high)[0]||zones.filter(z=>z.type==="demand").sort((a,b)=>Math.abs(b.high-current)-Math.abs(a.high-current))[0];
  const supply=zones.filter(z=>z.type==="supply"&&z.low>current).sort((a,b)=>a.low-b.low)[0]||zones.filter(z=>z.type==="supply").sort((a,b)=>Math.abs(a.low-current)-Math.abs(b.low-current))[0];if(!demand||!supply||supply.low<=demand.high)return null;return{low:demand.high,high:supply.low,demand,supply};
}
function sdEntrySignal(zones){
  if(!tvBars.length)return{signal:"WAIT",detail:"waiting for live price / flow data",confidence:0,confirmed:false};
  if(tvTimeframe!==1)return{signal:"WAIT",detail:"switch to 1m for SPY 0DTE AI entry signals",confidence:0,confirmed:false};

  const i=tvBars.length-1,bar=tvBars[i],current=Number(bar.close),d=studyData(tvBars);
  const ema9=Number(d.ema9[i]?.value),ema21=Number(d.ema21[i]?.value),ema200=Number(d.ema200[i]?.value);
  const f=sdFlowComponents(Date.now()-10*60*1000);
  const bullFlow=Number(f.askCall||0)+Number(f.bidPut||0);
  const bearFlow=Number(f.askPut||0)+Number(f.bidCall||0);
  const totalFlow=bullFlow+bearFlow;

  const vol=Number(bar.volume)||0;
  const volAvg=sdVolumeAvg(tvBars,i,20)||0;
  const volRatio=volAvg>0?vol/volAvg:0;

  const crossed=(dir)=>{
    if(i<1)return false;
    for(let k=Math.max(1,i-2);k<=i;k++){
      const a9=Number(d.ema9[k]?.value),a21=Number(d.ema21[k]?.value);
      const p9=Number(d.ema9[k-1]?.value),p21=Number(d.ema21[k-1]?.value);
      if(![a9,a21,p9,p21].every(Number.isFinite))continue;
      if(dir==="call" && p9<=p21 && a9>a21)return true;
      if(dir==="put" && p9>=p21 && a9<a21)return true;
    }
    return false;
  };

  const scoreSide=(type)=>{
    const isCall=type==="call";
    const fav=isCall?bullFlow:bearFlow,adv=isCall?bearFlow:bullFlow;
    const flowRatio=totalFlow>0?fav/totalFlow:0;
    const flowPct=Math.round(flowRatio*100);
    const flowPts=totalFlow>0?Math.max(0,Math.min(20,flowRatio*20)):0;

    const emaAligned=Number.isFinite(ema9)&&Number.isFinite(ema21)&&(isCall?ema9>ema21:ema9<ema21);
    const freshCross=crossed(type);
    const emaPts=(emaAligned?20:0)+(freshCross?30:0);

    const priceVs200=Number.isFinite(ema200)&&(isCall?current>ema200:current<ema200);
    const ema21Vs200=Number.isFinite(ema21)&&Number.isFinite(ema200)&&(isCall?ema21>ema200:ema21<ema200);
    const ema200Pts=priceVs200?20:0;

    let volumePts=0;
    if(volRatio>=1.50)volumePts=5;
    else if(volRatio>=1.20)volumePts=4;
    else if(volRatio>=1.00)volumePts=3;
    else if(volRatio>=0.80)volumePts=2;
    else if(volRatio>0)volumePts=1;

    const priceAligned=Number.isFinite(ema9)&&Number.isFinite(ema21)&&(isCall?(current>ema9&&current>ema21):(current<ema9&&current<ema21));
    const pricePts=0; // EMA position is already represented by the EMA200 confirmation weight.
    const vix=getVixAiContext(type);
    const vixPts=vix.available?Math.max(0,Math.min(5,(Number(vix.pts)||0)/3)):0;
    const gamma=getGammaFlipAiContext(type,current);
    const gammaPts=gamma.available?gamma.pts:0;

    const basePts=flowPts+emaPts+ema200Pts+volumePts; // max 95
    // Preserve the existing 100-point core model, then blend in Gamma Flip as a
    // 10-point regime confirmation. The 110-point result is normalized to 100.
    const corePts=vix.available?(basePts+vixPts):(basePts*(100/95));
    const confidence=Math.round(Math.max(0,Math.min(100,gamma.available?((corePts+gammaPts)*(100/110)):corePts)));
    const vixConfirm=!vix.available || vixPts>=1.67;
    const gammaConfirm=!gamma.available || gamma.aligned;
    const confirmOk=totalFlow>0&&flowPct>=55&&emaAligned&&volRatio>=0.80&&vixConfirm&&gammaConfirm;
    return{type,confidence,flowPct,flowPts,emaPts,ema200Pts,volumePts,pricePts,vixPts,vix,gammaPts,gamma,emaAligned,freshCross,priceVs200,ema21Vs200,priceAligned,volRatio,fav,adv};
  };

  const call=scoreSide("call"),put=scoreSide("put");
  const q=call.confidence>=put.confidence?call:put;
  const side=q.type==="call"?"CALL":"PUT";

  let signal="WAIT",strength="wait",confirmed=false;
  if(q.confidence>=85&&q.confirmOk&&q.freshCross){signal=`VERY STRONG ${side}`;strength="very-strong";confirmed=true;}
  else if(q.confidence>=78&&q.confirmOk&&q.freshCross){signal=`STRONG ${side}`;strength="strong";confirmed=true;}
  else if(q.confidence>=70&&q.confirmOk){signal=`${side} CONFIRM`;strength="confirmed";confirmed=true;}
  else if(q.confidence>=55){signal=`WATCH ${side}`;strength="watch";}

  const flowLabel=totalFlow?`${q.flowPct}% ${side} flow`:"no classified option flow";
  const crossLabel=q.freshCross?`fresh EMA9/21 ${q.type==="call"?"bull":"bear"} cross`:(q.emaAligned?"EMA9/21 aligned":"EMA9/21 not aligned");
  const ema200Label=Number.isFinite(ema200)?(q.priceVs200?`price correct side EMA200 ${ema200.toFixed(2)}`:`price wrong side EMA200 ${ema200.toFixed(2)}`):"EMA200 warming up";
  const volumeLabel=volAvg?`volume ${q.volRatio.toFixed(2)}× 20-bar avg`:"volume average warming up";
  const vixLabel=q.vix?.available?`${q.vix.label} · ${Number(q.vixPts||0).toFixed(1)}/5`:`VIX fallback mode${vixFeedError?" · "+vixFeedError:""}`;
  const gammaLabel=q.gamma?.available?`${q.gamma.label} · ${q.gamma.aligned?"regime confirms":"regime conflicts"} · ${Number(q.gammaPts||0).toFixed(0)}/10`:"Gamma Flip unavailable · core model only";

  return{
    signal,type:q.type,confidence:q.confidence,strength,confirmed,
    detail:`${flowLabel} · ${crossLabel} · ${ema200Label} · ${volumeLabel} · ${gammaLabel} · ${vixLabel}`,
    quality:q,
    zone:null
  };
}
function sdRecordChartSignal(entry){
  if(!tvBars.length)return;

  // Reset the latch whenever the AI drops back to WATCH / WAIT.
  if(!entry||!entry.confirmed){
    osAiSignalLatched=false;
    osAiSignalLatchedSide="";
    return;
  }

  const bar=tvBars.at(-1);
  const time=Number(bar.time);
  const type=entry.type==="call"?"call":"put";

  // Do not print repeated markers while the same confirmed condition remains active.
  if(osAiSignalLatched && osAiSignalLatchedSide===type)return;

  const key=`ai-${type}:${time}`;
  if(key===sdLastSignalKey||tvSupplyDemandSignals.some(x=>x.key===key))return;
  sdLastSignalKey=key;
  osAiSignalLatched=true;
  osAiSignalLatchedSide=type;

  tvSupplyDemandSignals.push({
    key,
    zoneKey:`ai-${type}`,
    type,
    time,
    price:type==="call"?Number(bar.low):Number(bar.high),
    confidence:Number(entry.confidence)||0,
    strength:entry.strength||"confirmed",
    zoneScore:0,
    detail:"AI FLOW/EMA/VOLUME · "+(entry.detail||"")
  });

  if(tvSupplyDemandSignals.length>40){
    tvSupplyDemandSignals=tvSupplyDemandSignals.slice(-40);
  }
}

function osAiMoney(v){v=Number(v)||0;if(v>=1e6)return "$"+(v/1e6).toFixed(1)+"M";if(v>=1e3)return "$"+(v/1e3).toFixed(0)+"K";return "$"+Math.round(v);}
function osAiNearestZone(type,current){
  const z=tvSupplyDemandZones.filter(x=>x.type===type);
  if(!z.length)return null;
  return [...z].sort((a,b)=>Math.min(Math.abs(a.low-current),Math.abs(a.high-current))-Math.min(Math.abs(b.low-current),Math.abs(b.high-current)))[0];
}
function osUpdateDirectionBox(bar,ema9,ema21,ema200,f,volRatio){
  const put=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  const bars=tvBars||[];
  // Use the most recently CLOSED bar; the live bar can change before its close.
  const closed=bars.length>1?bars[bars.length-2]:null;
  const previous=bars.slice(Math.max(0,bars.length-7),Math.max(0,bars.length-2));
  const detected=closed?osCandlePatterns(bars,bars.length-2):[];
  const pattern=detected[0]?.name||null;
  const patternBias=detected[0]?.bias||0;
  const closes=previous.map(x=>Number(x.close)).filter(Number.isFinite);
  const rising=closes.length>=3&&closes.at(-1)>closes[0];
  const falling=closes.length>=3&&closes.at(-1)<closes[0];
  put('os-ai-pattern','CLOSED: '+(pattern||'NONE')+(pattern?' · '+(rising?'AFTER RISE':falling?'AFTER DROP':'SIDEWAYS'):''));
  let bull=0,bear=0,available=0;const notes=[];
  const add=(weight,bias)=>{available+=weight;if(bias>0)bull+=weight;else if(bias<0)bear+=weight;else{bull+=weight/2;bear+=weight/2;}};
  const buy=Number(f.askCall||0)+Number(f.bidPut||0),sell=Number(f.askPut||0)+Number(f.bidCall||0);
  if(buy+sell>0){const share=buy/(buy+sell);available+=30;bull+=30*share;bear+=30*(1-share);notes.push('FLOW');}
  if(Number.isFinite(ema9)&&Number.isFinite(ema21)&&ema9>0&&ema21>0){add(10,ema9>ema21?1:ema9<ema21?-1:0);notes.push('EMA');}
  const price=Number(bar.close);
  if(Number.isFinite(ema200)&&ema200>0)add(5,price>ema200?1:price<ema200?-1:0);
  const flip=Number(gammaFlipState?.price);
  const gexFresh=Date.now()-Number(sdGexContext?.updatedAt||0)<180000;
  if(gexFresh&&Number.isFinite(flip)&&flip>0){add(15,price>flip?1:price<flip?-1:0);notes.push('GAMMA');}
  const cw=Number(sdGexContext?.callWall?.s),pw=Number(sdGexContext?.putWall?.s);
  const cwOk=gexFresh&&Number.isFinite(cw)&&cw>0,pwOk=gexFresh&&Number.isFinite(pw)&&pw>0;
  if(cwOk||pwOk){let bias=0;if(pwOk&&price>=pw&&price-pw<=1.5)bias=1;if(cwOk&&price<=cw&&cw-price<=1.5)bias=-1;if(cwOk&&price>cw+.15)bias=1;if(pwOk&&price<pw-.15)bias=-1;add(15,bias);notes.push('WALLS');}
  put('os-ai-walls','PUT WALL '+(pwOk?'$'+pw.toFixed(2):'N/A')+' · CALL WALL '+(cwOk?'$'+cw.toFixed(2):'N/A'));
  if(pattern){add(15,patternBias);notes.push('PATTERN');}
  if(Number.isFinite(volRatio)&&volRatio>0){add(10,volRatio>=1.2?(price>Number(bar.open)?1:price<Number(bar.open)?-1:0):0);notes.push('VOLUME');}
  const b=Math.round(bull),r=Math.round(bear);
  put('os-ai-bull','CALL '+b+'/100');put('os-ai-bear','PUT '+r+'/100');
  const coverage=Math.round(available);
  const decision=coverage<50?'WAIT · INSUFFICIENT INPUTS':Math.abs(b-r)<15?'WAIT · MIXED SIGNALS':b>r?'CALL BIAS · CONFIRM BREAKOUT':'PUT BIAS · CONFIRM BREAKDOWN';
  put('os-ai-direction',decision);
  put('os-ai-direction-note','Input coverage '+coverage+'/100 · '+notes.join(' / ')+' · Scores are NOT probabilities.');
  const el=document.getElementById('os-ai-direction');if(el)el.style.color=decision.startsWith('CALL')?'#34d399':decision.startsWith('PUT')?'#f87171':'#fbbf24';
}
function updateOptionsSwiftAI(entry){
  const panel=document.getElementById("os-ai-panel");if(!panel||!tvBars.length)return;
  const bar=tvBars.at(-1),current=Number(bar.close),d=studyData(tvBars),i=tvBars.length-1;
  const ema9=Number(d.ema9[i]?.value),ema21=Number(d.ema21[i]?.value),ema200=Number(d.ema200[i]?.value);
  const f=sdFlowComponents(Date.now()-10*60*1000);
  const bullFlow=Number(f.askCall||0)+Number(f.bidPut||0);
  const bearFlow=Number(f.askPut||0)+Number(f.bidCall||0);
  const totalFlow=bullFlow+bearFlow;
  const bullPct=totalFlow?Math.round(bullFlow/totalFlow*100):0,bearPct=totalFlow?100-bullPct:0;
  const vol=Number(bar.volume)||0,volAvg=sdVolumeAvg(tvBars,i,20)||0,volRatio=volAvg?vol/volAvg:0;
  const q=entry?.quality||{};

  let state=String(entry?.signal||"WAIT"),confidence=Number(entry?.confidence)||0;
  let type=state.includes("CALL")?"call":state.includes("PUT")?"put":"wait";
  const color=type==="call"?"#34d399":type==="put"?"#f87171":"#fbbf24";

  panel.classList.remove("os-ai-call","os-ai-put","os-ai-wait");
  panel.classList.add(type==="call"?"os-ai-call":type==="put"?"os-ai-put":"os-ai-wait");

  const set=(id,val)=>{const e=document.getElementById(id);if(e)e.textContent=val;};
  set("os-ai-state",state);
  set("os-ai-confidence",confidence?confidence+"%":"—");
  set("os-ai-clock",new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",second:"2-digit"}));
  set("os-ai-sub",entry?.confirmed?"flow + trend confirmation":"waiting for flow / EMA / volume alignment");

  set("os-ai-flow",totalFlow?`${bullPct}% BULL / ${bearPct}% BEAR`:"NO CLASSIFIED FLOW");
  set("os-ai-flow-score",Number.isFinite(q.flowPts)?`${Math.round(q.flowPts)}/20 · ${q.flowPct||0}% ${q.type==="put"?"PUT":"CALL"}`:"—");
  set("os-ai-ema",Number.isFinite(ema9)&&Number.isFinite(ema21)?`${ema9>=ema21?"BULL":"BEAR"} ${ema9.toFixed(2)} / ${ema21.toFixed(2)}`:"WARMING UP");
  set("os-ai-cross",q.freshCross?(q.type==="call"?"↑ BULL CROSS · +30/50":"↓ BEAR CROSS · +30/50"):(q.emaAligned?"ALIGNED · +20/50 · NO FRESH CROSS":"NOT ALIGNED"));
  set("os-ai-ema200",Number.isFinite(ema200)?`${current>=ema200?"ABOVE":"BELOW"} ${ema200.toFixed(2)}${q.ema21Vs200?" · TREND OK":""}`:"WARMING UP");
  const gamma=q.gamma||getGammaFlipAiContext(q.type||"call",current);
  set("os-ai-gamma",gamma.available?`${current>=gamma.flip?"ABOVE":"BELOW"} $${gamma.flip.toFixed(2)} · ${Math.abs(current-gamma.flip).toFixed(2)} AWAY`:"UNAVAILABLE");
  set("os-ai-gamma-score",gamma.available?`${Number(q.gammaPts||0).toFixed(0)}/10 · ${gamma.aligned?"CONFIRMS":"CONFLICTS"}`:"CORE MODEL ONLY");
  set("os-ai-volume",volAvg?`${volRatio.toFixed(2)}× AVG20 · ${volRatio>=1.2?"EXPANDING":volRatio>=.8?"NORMAL":"LIGHT"}`:"WARMING UP");
  const vix=q.vix||getVixAiContext(q.type||"call");
  set("os-ai-vix",vix.available?`${vixLast.toFixed(2)} · ${vix.bias} · 1m ${Number.isFinite(vix.c1)?vix.c1.toFixed(2)+"%":"—"} · 3m ${Number.isFinite(vix.c3)?vix.c3.toFixed(2)+"%":"—"}`:"UNAVAILABLE · FALLBACK");
  set("os-ai-vix-score",vix.available?`${Number(q.vixPts||0).toFixed(1)}/5 · ${q.type==="call"?"CALL likes ↓VIX":"PUT likes ↑VIX"}`:"BASE MODEL NORMALIZED");

  osUpdateDirectionBox(bar,ema9,ema21,ema200,f,volRatio);
  const action=document.getElementById("os-ai-action");
  if(action){
    if(entry?.confirmed) action.textContent=`${state} · ${entry.detail}`;
    else if(state.startsWith("WATCH")) action.textContent=`${state} · need ≥70% + flow ≥55% + EMA9/21 alignment + volume ≥0.80× avg${q.gamma?.available?" + Gamma Flip regime":""}${q.vix?.available?" + VIX ≥1.7/5":""}`;
    else action.textContent=`WAIT · ${entry?.detail||"waiting for live confirmation"}`;
  }

  const stateEl=document.getElementById("os-ai-state"),confEl=document.getElementById("os-ai-confidence");
  if(stateEl)stateEl.style.color=color;if(confEl)confEl.style.color=color;
}
/* ── Harmonic Butterfly detector (XABCD) ──
   Bullish: X low → A high → B low (≈0.786 XA) → C high (0.382–0.886 AB) → D low below X (1.27–1.618 XA, 1.618–2.618 BC)
   Bearish: mirror image. Pivots come from an ATR-scaled zigzag on real (non-Heikin-Ashi) candles. */
const BFLY_SCALES={auto:[2,3.5],small:[1.5],medium:[2.5],large:[4]};
let bflyEnabled=localStorage.getItem("options_swift_bfly")!=="0";
let bflyScale=localStorage.getItem("options_swift_bfly_scale")||"auto";if(!BFLY_SCALES[bflyScale])bflyScale="auto";
let tvButterflies=[];
function bflyATR(bars,len=14){
  const out=new Array(bars.length).fill(null);let sum=0;const q=[];
  for(let i=0;i<bars.length;i++){
    const b=bars[i],pc=i?bars[i-1].close:b.close,tr=Math.max(b.high-b.low,Math.abs(b.high-pc),Math.abs(b.low-pc));
    q.push(tr);sum+=tr;if(q.length>len)sum-=q.shift();out[i]=sum/q.length;
  }
  return out;
}
function bflyZigzag(bars,atr,mult){
  if(bars.length<10)return[];
  const piv=[];let dir=0,extI=0,extP=bars[0].close;
  for(let i=1;i<bars.length;i++){
    const b=bars[i],thr=Math.max(mult*(atr[i]||0),b.close*0.0006);
    if(dir>=0){
      if(b.high>=extP||dir===0&&b.high>extP){extP=b.high;extI=i;if(dir===0)dir=1;}
      if(dir===1&&extP-b.low>=thr){piv.push({i:extI,p:extP,t:"H"});dir=-1;extP=b.low;extI=i;continue;}
    }
    if(dir<=0){
      if(b.low<=extP||dir===0){if(dir===0&&b.low<extP){extP=b.low;extI=i;dir=-1;}else if(dir===-1){extP=b.low;extI=i;}}
      if(dir===-1&&b.high-extP>=thr){piv.push({i:extI,p:extP,t:"L"});dir=1;extP=b.high;extI=i;}
    }
  }
  if(dir!==0)piv.push({i:extI,p:extP,t:dir===1?"H":"L",live:true}); // current, unconfirmed extreme
  return piv;
}
const bflyIn=(v,lo,hi)=>v>=lo&&v<=hi;
const bflyCloseness=(v,ideal,tol)=>Math.max(0,1-Math.abs(v-ideal)/tol);
function bflyPRZ(bull,X,A,B,C){
  const xa=Math.abs(A.p-X.p),bc=Math.abs(C.p-B.p),s=bull?-1:1;
  const xa127=A.p+s*1.27*xa,xa1618=A.p+s*1.618*xa,bc1618=C.p+s*1.618*bc,bc2618=C.p+s*2.618*bc;
  const r1=[Math.min(xa127,xa1618),Math.max(xa127,xa1618)],r2=[Math.min(bc1618,bc2618),Math.max(bc1618,bc2618)];
  let lo=Math.max(r1[0],r2[0]),hi=Math.min(r1[1],r2[1]),overlap=lo<=hi;
  if(!overlap){ // no confluence: fall back to the 1.27 XA level ± a sliver, with a score penalty
    const pad=xa*0.06;lo=xa127-pad;hi=xa127+pad;
  }
  return{lo,hi,overlap,xa127,xa1618};
}
function bflyFlowConfluence(bull,dIndex){
  try{
    if(typeof getChartFlowOrders!=="function")return null;
    const span=tvTimeframe*60,t0=tvBars[Math.max(0,dIndex-2)]?.time,t1=tvBars[Math.min(tvBars.length-1,dIndex+2)]?.time;if(t0==null||t1==null)return null;
    let with_=0,against=0;
    for(const o of getChartFlowOrders()){
      const prem=Number(o.prem||0);if(prem<chartFlowMinPremium)continue;
      const t=Math.floor(Math.floor(tapeTsMs(o.ts)/1000)/span)*span;if(t<t0||t>t1+span)continue;
      const b=chartFlowDirection(o);if(b==="BULLISH")bull?with_+=prem:against+=prem;else if(b==="BEARISH")bull?against+=prem:with_+=prem;
    }
    return with_||against?{with_,against}:null;
  }catch(_){return null;}
}
function bflyOutcome(bull,dIdx,D,A,stop,bars){
  const t1=D+(A-D)*0.382,t2=D+(A-D)*0.618;let status="ACTIVE";
  for(let i=dIdx+1;i<bars.length;i++){
    const b=bars[i];
    if(bull?b.low<=stop:b.high>=stop){status="STOPPED";break;}
    if(bull?b.high>=t2:b.low<=t2){status="T2 HIT";break;}
    if(bull?b.high>=t1:b.low<=t1)status="T1 HIT";
  }
  return{t1,t2,status};
}
function detectButterflies(bars){
  if(!bars||bars.length<30)return[];
  const atr=bflyATR(bars),last=bars.length-1,price=bars[last].close,found=[];
  for(const mult of BFLY_SCALES[bflyScale]){
    const pv=bflyZigzag(bars,atr,mult);
    // completed / in-PRZ patterns: five consecutive pivots
    for(let k=0;k+4<pv.length;k++){
      const [X,A,B,C,D]=pv.slice(k,k+5),bull=X.t==="L";
      const xa=Math.abs(A.p-X.p),ab=Math.abs(A.p-B.p),bc=Math.abs(C.p-B.p),cd=Math.abs(D.p-C.p),ad=Math.abs(A.p-D.p);
      if(!xa||!ab||!bc)continue;
      const rB=ab/xa,rC=bc/ab,rD=ad/xa,rCD=cd/bc;
      if(!bflyIn(rB,0.72,0.84)||!bflyIn(rC,0.382,0.886)||!bflyIn(rD,1.20,1.70)||!bflyIn(rCD,1.45,2.9))continue;
      if(bull?!(B.p>X.p&&C.p<A.p&&D.p<X.p):!(B.p<X.p&&C.p>A.p&&D.p>X.p))continue;
      const prz=bflyPRZ(bull,X,A,B,C);
      let score=35*bflyCloseness(rB,0.786,0.06)+25*bflyCloseness(rD,1.27,0.35)+20*bflyCloseness(rCD,2.0,0.9)+10*bflyCloseness(rC,0.618,0.3)+10;
      if(!prz.overlap)score-=12;
      const stop=bull?Math.min(D.p,prz.xa1618)-xa*0.08:Math.max(D.p,prz.xa1618)+xa*0.08;
      const out=bflyOutcome(bull,D.i,D.p,A.p,stop,bars);
      const status=D.live&&out.status==="ACTIVE"?"IN PRZ":out.status;
      found.push({bull,pts:[X,A,B,C,D],ratios:{rB,rC,rD,rCD},prz,stop,t1:out.t1,t2:out.t2,status,score:Math.max(0,Math.min(100,Math.round(score))),dIndex:D.i,complete:true,mult});
    }
    // forming: X-A-B-C confirmed, D leg in progress toward the PRZ
    const n=pv.length;
    if(n>=5){
      const [X,A,B,C,Dl]=pv.slice(n-5),bull=X.t==="L";
      const xa=Math.abs(A.p-X.p),ab=Math.abs(A.p-B.p),bc=Math.abs(C.p-B.p);
      if(xa&&ab&&bc&&Dl.live){
        const rB=ab/xa,rC=bc/ab;
        if(bflyIn(rB,0.72,0.84)&&bflyIn(rC,0.382,0.886)&&(bull?B.p>X.p&&C.p<A.p:B.p<X.p&&C.p>A.p)){
          const prz=bflyPRZ(bull,X,A,B,C);
          const notYet=bull?price>prz.hi:price<prz.lo,blown=bull?price<prz.xa1618-xa*0.08:price>prz.xa1618+xa*0.08;
          if(notYet&&!blown){
            let score=35*bflyCloseness(rB,0.786,0.06)+10*bflyCloseness(rC,0.618,0.3)+25;if(!prz.overlap)score-=12;
            const dist=Math.abs(price-(bull?prz.hi:prz.lo));
            found.push({bull,pts:[X,A,B,C],ratios:{rB,rC},prz,status:"FORMING",score:Math.max(0,Math.min(100,Math.round(score))),dIndex:last,complete:false,mult,distance:dist});
          }
        }
      }
    }
  }
  // de-dupe across scales: same direction sharing X or D (or overlapping spans) → keep best
  found.sort((a,b)=>b.score-a.score);
  const kept=[];
  for(const p of found){
    const x0=p.pts[0].i,x1=p.dIndex;
    if(kept.some(q=>q.bull===p.bull&&x0<=q.dIndex&&x1>=q.pts[0].i&&(q.pts[0].i===x0||q.dIndex===x1||Math.abs(q.pts[1].i-p.pts[1].i)<=2)))continue;
    kept.push(p);
  }
  for(const p of kept)if(p.complete)p.flow=bflyFlowConfluence(p.bull,p.dIndex);
  return kept.sort((a,b)=>a.dIndex-b.dIndex).slice(-8);
}
function refreshButterflyPatterns(){
  tvButterflies=bflyEnabled?detectButterflies(tvBars):[];
  if(tvChart){tvChart.butterflies=tvButterflies.map(p=>({...p,times:p.pts.map(pt=>tvBars[pt.i]?.time),dTime:tvBars[p.dIndex]?.time}));tvChart.showButterflies=bflyEnabled;tvChart.render();}
  const e=document.getElementById("tv-bfly-summary");if(!e)return;
  if(!bflyEnabled){e.innerHTML=`<i class="tv-dot" style="background:#64748b"></i>Butterfly: off`;return;}
  const live=tvButterflies.filter(p=>p.status==="FORMING"||p.status==="IN PRZ"||p.status==="ACTIVE").sort((a,b)=>b.dIndex-a.dIndex)[0];
  if(!live){e.innerHTML=`<i class="tv-dot" style="background:#a78bfa"></i>Butterfly: ${tvButterflies.length?`${tvButterflies.length} past pattern${tvButterflies.length===1?"":"s"} on chart · none active`:"scanning — no valid XABCD yet"}`;return;}
  const c=live.bull?"#34d399":"#fb7185";
  e.innerHTML=`<i class="tv-dot" style="background:${c}"></i><b style="color:${c}">${live.bull?"BULLISH":"BEARISH"} BUTTERFLY ${live.status}</b> · PRZ ${live.prz.lo.toFixed(2)}–${live.prz.hi.toFixed(2)} · score ${live.score}${live.t1?` · T1 ${live.t1.toFixed(2)} · stop ${live.stop.toFixed(2)}`:""}`;
}
function toggleButterfly(btn,silent=false){
  bflyEnabled=!bflyEnabled;try{localStorage.setItem("options_swift_bfly",bflyEnabled?"1":"0");}catch(_){}
  (btn||document.getElementById("tv-bfly-btn"))?.classList.toggle("on",bflyEnabled);refreshButterflyPatterns();
}
function setButterflyScale(value){
  if(!BFLY_SCALES[value])return;bflyScale=value;try{localStorage.setItem("options_swift_bfly_scale",value);}catch(_){}
  const s=document.getElementById("tv-bfly-scale");if(s)s.value=value;refreshButterflyPatterns();
}
window.addEventListener("storage",e=>{
  if(e.key==="options_swift_bfly"){const want=e.newValue!=="0";if(want!==bflyEnabled)toggleButterfly(null,true);}
  if(e.key==="options_swift_bfly_scale"&&e.newValue)setButterflyScale(e.newValue);
});
{const syncBfly=()=>{document.getElementById("tv-bfly-btn")?.classList.toggle("on",bflyEnabled);const s=document.getElementById("tv-bfly-scale");if(s)s.value=bflyScale;};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",syncBfly);else syncBfly();}
function refreshSupplyDemandZones(){
  const major=sdMajorBars();tvSupplyDemandZones=computeSupplyDemandZones(major);const current=Number(tvBars.at(-1)?.close);tvSupplyDemandNoTradeArea=Number.isFinite(current)?sdNoTradeArea(tvSupplyDemandZones,current):null;const entry=sdEntrySignal(tvSupplyDemandZones);sdRecordChartSignal(entry);updateOptionsSwiftAI(entry);
  if(tvChart){tvChart.supplyDemandZones=tvSupplyDemandZones;tvChart.supplyDemandNoTradeArea=tvSupplyDemandNoTradeArea;tvChart.supplyDemandSignals=tvSupplyDemandSignals;tvChart.showSupplyDemand=tvSupplyDemandEnabled;tvChart.render();}
  const e=document.getElementById("tv-sd-summary");if(e){const d=tvSupplyDemandZones.filter(z=>z.type==="demand"),s=tvSupplyDemandZones.filter(z=>z.type==="supply"),bestD=[...d].sort((a,b)=>b.score-a.score)[0],bestS=[...s].sort((a,b)=>b.score-a.score)[0],sigColor=entry.signal.includes("CALL")?"#34d399":entry.signal.includes("PUT")?"#f87171":entry.signal==="NO TRADE"?"#fbbf24":"#9fb4c8";e.innerHTML=`<i class="tv-dot" style="background:${sigColor}"></i><b style="color:${sigColor}">${entry.signal}</b> · ${entry.detail}${bestD?` · D ${bestD.low.toFixed(2)}–${bestD.high.toFixed(2)} (${Math.round(bestD.score)})`:""}${bestS?` · S ${bestS.low.toFixed(2)}–${bestS.high.toFixed(2)} (${Math.round(bestS.score)})`:""}`;}
  try{refreshButterflyPatterns();}catch(e){console.warn("Butterfly scan failed",e);}
}
function toggleSupplyDemand(btn){tvSupplyDemandEnabled=!tvSupplyDemandEnabled;btn?.classList.toggle("on",tvSupplyDemandEnabled);if(tvChart){tvChart.showSupplyDemand=tvSupplyDemandEnabled;tvChart.render();}if(CHART_WINDOW_MODE)try{sendChartWindowCommand("supplyDemand",tvSupplyDemandEnabled);}catch(_){} }


// Extend each saved vertical drawing through the Volume and ADX/DI panes.
// The price chart retains ownership of the drawing and its timestamp.
let swiftVerticalExtensionFrame=0;
function scheduleSwiftVerticalExtensions(){
  if(swiftVerticalExtensionFrame)return;
  swiftVerticalExtensionFrame=requestAnimationFrame(()=>{swiftVerticalExtensionFrame=0;renderSwiftVerticalExtensions();});
}
function renderSwiftVerticalExtensions(){
  if(!tvChart)return;
  const pricePane=document.getElementById('tv-main-chart');
  const priceRect=pricePane?.getBoundingClientRect();
  if(!priceRect?.width)return;
  const lines=(tvChart.drawings||[]).filter(d=>d.type==='vertical'&&d.points?.[0]);
  if(swiftAutoDILinesEnabled)for(const c of swiftAutoDICrosses)lines.push({autoDI:c,points:[{time:c.time,diCrossLogicalIndex:c.index}]});
  const panes=[document.getElementById('swift-adx-pane')];
  for(const pane of panes){
    if(!pane)continue;
    let layer=pane.querySelector('.swift-vertical-extensions');
    if(!layer){
      layer=document.createElement('div');layer.className='swift-vertical-extensions';
      Object.assign(layer.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden',zIndex:'4'});
      pane.appendChild(layer);
    }
    layer.replaceChildren();
    if(pane.hidden||getComputedStyle(pane).display==='none')continue;
    const paneRect=pane.getBoundingClientRect();
    for(const d of lines){
      const x=Number.isFinite(d.points[0].diCrossLogicalIndex)?tvChart._xForIndex(d.points[0].diCrossLogicalIndex):tvChart.timeToCoordinate(d.points[0].time);
      if(!Number.isFinite(x))continue;
      const paneX=priceRect.left+x-paneRect.left;
      if(paneX<0||paneX>paneRect.width)continue;
      const el=document.createElement('div');
      Object.assign(el.style,{position:'absolute',left:`${paneX}px`,top:'0',bottom:'0',width:'0',borderLeft:`2px ${d.autoDI?'dashed':'solid'} ${d.autoDI?(d.autoDI.bullish?'#34d399':'#f87171'):(d===tvChart.selectedDrawing?'#e2e8f0':'#a78bfa')}`,opacity:'0.9'});
      layer.appendChild(el);
    }
  }
}

// Snap a manually placed/moved vertical line to a confirmed +DI/-DI crossover.
// A crossover belongs to the candle where the DI ordering changes (not a guessed sub-candle time).
let swiftDISnapEnabled=false;
function toggleSwiftDISnap(btn){
  swiftDISnapEnabled=!swiftDISnapEnabled;
  btn?.classList.toggle('on',swiftDISnapEnabled);
  if(btn)btn.textContent='DI Cross Snap: '+(swiftDISnapEnabled?'On':'Off');
  try{localStorage.setItem('options_swift_di_cross_snap',swiftDISnapEnabled?'1':'0');}catch(_){}
}
function swiftSnapVerticalToDICross(point){
  if(!swiftDISnapEnabled||!point||!tvCandles?.data?.length)return point;
  const bars=swiftADXBars(),idx=Number.isInteger(point.index)?point.index:bars.findIndex(b=>Number(b.time)===Number(point.time));
  if(idx<0)return point;
  const values=swiftADXCalculate(bars),maxDistance=3;
  let best=null;
  for(let i=Math.max(15,idx-maxDistance);i<=Math.min(bars.length-1,idx+maxDistance);i++){
    const a=values[i-1],b=values[i];
    if(!a||!b||![a.plus,a.minus,b.plus,b.minus].every(Number.isFinite))continue;
    const prev=a.plus-a.minus,now=b.plus-b.minus;
    if(!((prev<=0&&now>0)||(prev>=0&&now<0)))continue;
    const distance=Math.abs(i-idx);
    if(!best||distance<best.distance)best={index:i,distance,kind:now>0?'BULLISH +DI CROSS':'BEARISH -DI CROSS'};
  }
  if(!best)return {...point,diCrossSnap:null};
  return {...point,time:Number(bars[best.index].time),index:best.index,snappedTo:'DI CROSS',diCrossSnap:best.kind};
}
try{swiftDISnapEnabled=localStorage.getItem('options_swift_di_cross_snap')==='1';}catch(_){}
window.addEventListener('DOMContentLoaded',()=>{
 const btn=document.getElementById('os-di-snap-btn');if(btn){btn.classList.toggle('on',swiftDISnapEnabled);btn.textContent='DI Cross Snap: '+(swiftDISnapEnabled?'On':'Off');}
});

// Automatic DI crossover lines: only completed candles, ADX >= 18 at the crossover.
let swiftAutoDILinesEnabled=true,swiftAutoDICrosses=[];
try{swiftAutoDILinesEnabled=localStorage.getItem('options_swift_auto_di_18')!=='0';}catch(_){}
function toggleSwiftAutoDILines(btn){
  swiftAutoDILinesEnabled=!swiftAutoDILinesEnabled;
  btn?.classList.toggle('on',swiftAutoDILinesEnabled);
  try{localStorage.setItem('options_swift_auto_di_18',swiftAutoDILinesEnabled?'1':'0');}catch(_){}
  swiftADXSchedule();tvChart?.render();scheduleSwiftVerticalExtensions();
}
function swiftUpdateAutoDICrosses(bars,values){
  const found=[];
  // Do not confirm a cross using the currently forming 1-minute candle.
  const last=Math.max(0,bars.length-2);
  for(let i=1;i<=last;i++){
    const a=values[i-1],b=values[i];
    if(!a||!b||![a.plus,a.minus,b.plus,b.minus,b.adx].every(Number.isFinite)||b.adx<18)continue;
    const prior=a.plus-a.minus,current=b.plus-b.minus;
    const bullish=prior<=0&&current>0,bearish=prior>=0&&current<0;
    if(bullish||bearish)found.push({index:i,time:bars[i].time,adx:b.adx,bullish});
  }
  swiftAutoDICrosses=found;
}
// Wilder's Directional Movement Index / ADX (14), computed from original SPY OHLC.
let swiftADXEnabled=true,swiftADXChart=null,swiftADXFrame=0;
function swiftADXBars(){const d=tvCandles?.data||[];return (Array.isArray(tvBars)&&tvBars.length===d.length)?tvBars:d;}
function swiftADXCalculate(bars,period=14){
  const n=bars.length,out=Array.from({length:n},()=>({adx:null,plus:null,minus:null}));
  if(n<period+1)return out;
  const tr=[],pd=[],md=[];
  for(let i=1;i<n;i++){
    const a=bars[i],b=bars[i-1],up=a.high-b.high,down=b.low-a.low;
    tr[i]=Math.max(a.high-a.low,Math.abs(a.high-b.close),Math.abs(a.low-b.close));
    pd[i]=up>down&&up>0?up:0;md[i]=down>up&&down>0?down:0;
  }
  let st=0,sp=0,sm=0,dx=[];
  for(let i=1;i<=period;i++){st+=tr[i];sp+=pd[i];sm+=md[i];}
  for(let i=period;i<n;i++){
    if(i>period){st=st-st/period+tr[i];sp=sp-sp/period+pd[i];sm=sm-sm/period+md[i];}
    const plus=st>0?100*sp/st:0,minus=st>0?100*sm/st:0;
    out[i].plus=plus;out[i].minus=minus;
    dx[i]=plus+minus>0?100*Math.abs(plus-minus)/(plus+minus):0;
    if(i===2*period-1){let sum=0;for(let j=period;j<=i;j++)sum+=dx[j];out[i].adx=sum/period;}
    else if(i>2*period-1)out[i].adx=(out[i-1].adx*(period-1)+dx[i])/period;
  }
  return out;
}
function toggleSwiftADX(btn){swiftADXEnabled=!swiftADXEnabled;document.getElementById('swift-adx-pane').hidden=!swiftADXEnabled;btn?.classList.toggle('on',swiftADXEnabled);try{localStorage.setItem('options_swift_adx_enabled',swiftADXEnabled?'1':'0');}catch(_){}if(swiftADXEnabled)swiftADXRefresh();scheduleSwiftVerticalExtensions();}
function swiftADXRefresh(){
  if(!tvCandles?.data?.length||!tvChart)return;
  const bars=swiftADXBars(),values=swiftADXCalculate(bars),range=tvChart.getVisibleLogicalRange();
  swiftUpdateAutoDICrosses(bars,values);tvChart.render();scheduleSwiftVerticalExtensions();
  if(!swiftADXEnabled||!window.Chart)return;
  const first=Math.max(0,Math.floor(range.from)-2),last=Math.min(bars.length-1,Math.ceil(range.to)+2);
  const latest=values[values.length-1],display=document.getElementById('swift-adx-values');
  const fmt=v=>Number.isFinite(v)?v.toFixed(1):'—';
  display.textContent=`ADX (14) ${fmt(latest.adx)}  |  +DI ${fmt(latest.plus)}  |  -DI ${fmt(latest.minus)}  |  ${latest.adx==null?'WARMING UP':latest.adx>=25?'STRONGER TREND':'WEAK / DEVELOPING TREND'}`;
  // A numeric x axis uses the exact logical indices of the main candle canvas.
  // Fixed plot margins match SwiftNativeChart._layout(): left 8, right 68.
  const points=fn=>{const out=[];for(let i=first;i<=last;i++){const y=fn(values[i]);if(Number.isFinite(y))out.push({x:i,y});}return out;};
  const data={datasets:[
    {label:'ADX',data:points(v=>v.adx),borderColor:'#fbbf24',borderWidth:2,pointRadius:0,spanGaps:false},
    {label:'+DI',data:points(v=>v.plus),borderColor:'#34d399',borderWidth:1.7,pointRadius:0},
    {label:'-DI',data:points(v=>v.minus),borderColor:'#f87171',borderWidth:1.7,pointRadius:0},
    {label:'25 threshold',data:[{x:range.from-.5,y:25},{x:range.to+.5,y:25}],borderColor:'#64748b',borderDash:[5,5],borderWidth:1,pointRadius:0}]};
  const xMin=range.from-.5,xMax=range.to+.5;
  const xOpts={type:'linear',min:xMin,max:xMax,bounds:'ticks',offset:false,
    ticks:{display:false},grid:{display:false},border:{display:false}};
  if(!swiftADXChart){
    swiftADXChart=new Chart(document.getElementById('swift-adx-canvas'),{type:'line',data,
      options:{animation:false,responsive:true,maintainAspectRatio:false,parsing:false,normalized:true,
        layout:{padding:{left:8,right:8,top:0,bottom:0}},
        interaction:{mode:'nearest',intersect:false,axis:'x'},
        plugins:{legend:{display:false},tooltip:{mode:'nearest',intersect:false}},
        scales:{x:xOpts,y:{position:'right',min:0,max:100,afterFit:axis=>{axis.width=60;},ticks:{color:'#8093a7',stepSize:25},grid:{color:'rgba(100,116,139,.16)'}}}}});
  }else{
    swiftADXChart.data=data;
    swiftADXChart.options.scales.x.min=xMin;
    swiftADXChart.options.scales.x.max=xMax;
    swiftADXChart.options.scales.x.ticks.display=false;
    swiftADXChart.update('none');
  }
}
// Allow a vertical line to originate directly in the ADX/DI panel.
// Chart.js category x-axis pixel -> displayed candle index -> original candle time.
// Snap to the actual visible +DI/-DI intersection, including the vertical position.
// Use the crossing candle's timestamp so every panel shares the same x-coordinate.
function swiftStartVerticalFromDIPane(event){
  if(event.button!==0||!tvChart||!tvCandles?.data?.length||!swiftADXChart||!swiftADXEnabled)return;
  if(!tvChart.drawingMode||tvChart.drawingTool!=='vertical')return;
  const canvas=document.getElementById('swift-adx-canvas');
  const rect=canvas.getBoundingClientRect();
  const x=event.clientX-rect.left;
  const y=event.clientY-rect.top;
  const area=swiftADXChart.chartArea;
  if(!area||x<area.left||x>area.right||y<area.top||y>area.bottom)return;
  const range=tvChart.getVisibleLogicalRange();
  const first=Math.max(0,Math.floor(range.from));
  const last=Math.min(tvCandles.data.length-1,Math.ceil(range.to));
  const values=swiftADXCalculate(swiftADXBars());
  const scaleX=swiftADXChart.scales.x,scaleY=swiftADXChart.scales.y;
  let best=null;
  for(let i=Math.max(first+1,15);i<=last;i++){
    const prev=values[i-1],now=values[i];
    if(!prev||!now||![prev.plus,prev.minus,now.plus,now.minus].every(Number.isFinite))continue;
    const d0=prev.plus-prev.minus,d1=now.plus-now.minus;
    if(!((d0<=0&&d1>0)||(d0>=0&&d1<0)))continue;
    const fraction=Math.abs(d0)/(Math.abs(d0)+Math.abs(d1));
    const crossX=scaleX.getPixelForValue(i-1+fraction);
    const crossY=scaleY.getPixelForValue(prev.plus+(now.plus-prev.plus)*fraction);
    const dx=x-crossX,dy=y-crossY;
    const distance=Math.hypot(dx,dy);
    if(!best||distance<best.distance)best={index:i,fraction,distance,kind:d1>0?'BULLISH +DI CROSS':'BEARISH -DI CROSS'};
  }
  // Mouse-position mode: clicking the DI pane places the line at the exact
  // horizontal cursor coordinate, including positions BETWEEN candle centers.
  // Snap mode is optional and only snaps when within 24px of a real crossover.
  // Use the mouse's viewport X against the PRICE chart's own drawing geometry.
  // Chart.js ADX category coordinates are not the same as the custom price-chart
  // coordinates (different left padding / axis widths / visible-range spacing).
  // Using them shifted vertical drawings several minutes left of the cursor.
  const priceCanvas=tvChart.canvas;
  const priceRect=priceCanvas.getBoundingClientRect();
  const priceX=(event.clientX-priceRect.left)*tvChart.width/priceRect.width;
  const priceLayout=tvChart._layout();
  const visibleRange=tvChart.getVisibleLogicalRange();
  const slots=Math.max(1,visibleRange.to-visibleRange.from+1);
  const rawLogical=visibleRange.from-0.5+(priceX-priceLayout.left)/priceLayout.width*slots;
  if(!Number.isFinite(rawLogical))return;
  const useCross=swiftDISnapEnabled&&best&&best.distance<=24;
  const logical=useCross?best.index-1+best.fraction:rawLogical;
  const nearest=Math.max(0,Math.min(tvCandles.data.length-1,Math.round(logical)));
  const bar=tvCandles.data[nearest];
  if(!bar)return;
  event.preventDefault();
  tvChart.addDrawingPoint({time:Number(bar.time),index:nearest,
    diCrossLogicalIndex:logical,price:Number(bar.close),
    snappedTo:useCross?'DI CROSS':'MOUSE POSITION',
    diCrossSnap:useCross?best.kind:null});
  scheduleSwiftVerticalExtensions();
}
window.addEventListener('DOMContentLoaded',()=>{
  const canvas=document.getElementById('swift-adx-canvas');
  canvas?.addEventListener('pointerdown',swiftStartVerticalFromDIPane);
});

function initSwiftADXResizer(){
  const pane=document.getElementById('swift-adx-pane');
  const grip=document.getElementById('swift-adx-resizer');
  if(!pane||!grip||grip.dataset.ready)return;
  grip.dataset.ready='1';
  const MIN=110,MAX=900;
  const clamp=v=>Math.max(MIN,Math.min(MAX,Math.round(v)));
  const setHeight=(value,persist)=>{
    const height=clamp(value);
    pane.style.height=height+'px';
    document.documentElement.style.setProperty('--swift-adx-height',height+'px');
    if(CHART_WINDOW_MODE && tvChart){
      const main=document.getElementById('tv-main-chart');
      if(main){tvChart.resize(main.clientWidth,main.clientHeight);tvChart.render();}
    }
    if(swiftADXChart){swiftADXChart.resize();swiftADXChart.update('none');}
    scheduleSwiftVerticalExtensions();
    if(persist){try{localStorage.setItem('options_swift_adx_height_450_v3',String(clamp(value)));}catch(_){}}
  };
  setHeight(250,false); // Default ADX panel fills upward into the chart window.
  try{const saved=Number(localStorage.getItem('options_swift_adx_height_450_v3'));if(Number.isFinite(saved)&&saved>=MIN)setHeight(saved,false);}catch(_){}
  let startY=0,startH=0,dragging=false;
  grip.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    e.preventDefault();e.stopPropagation();
    startY=e.clientY;startH=pane.getBoundingClientRect().height;dragging=true;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('swift-adx-resizing');
  });
  grip.addEventListener('pointermove',e=>{
    if(!dragging)return;
    e.preventDefault();
    setHeight(startH+startY-e.clientY,false);
  });
  const finish=()=>{
    if(!dragging)return;
    dragging=false;
    document.body.classList.remove('swift-adx-resizing');
    setHeight(pane.getBoundingClientRect().height,true);
  };
  grip.addEventListener('pointerup',finish);
  grip.addEventListener('pointercancel',finish);
  grip.addEventListener('lostpointercapture',finish);
  grip.addEventListener('keydown',e=>{
    if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
    e.preventDefault();
    const h=pane.getBoundingClientRect().height;
    setHeight(e.key==='Home'?MIN:e.key==='End'?MAX:h+(e.key==='ArrowDown'?20:-20),true);
  });
  // Bottom edge grip: drag downward to enlarge, upward to shrink.
  const bottom=document.getElementById('swift-adx-bottom-resizer');
  if(bottom){
    let y0=0,h0=0,active=false;
    bottom.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;
      e.preventDefault();e.stopPropagation();
      y0=e.clientY;h0=pane.getBoundingClientRect().height;active=true;
      bottom.setPointerCapture(e.pointerId);
      document.body.classList.add('swift-adx-resizing');
    });
    bottom.addEventListener('pointermove',e=>{
      if(!active)return;
      e.preventDefault();setHeight(h0+e.clientY-y0,false);
    });
    const end=()=>{
      if(!active)return;
      active=false;document.body.classList.remove('swift-adx-resizing');
      setHeight(pane.getBoundingClientRect().height,true);
    };
    bottom.addEventListener('pointerup',end);
    bottom.addEventListener('pointercancel',end);
    bottom.addEventListener('lostpointercapture',end);
    bottom.addEventListener('keydown',e=>{
      if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
      e.preventDefault();
      const h=pane.getBoundingClientRect().height;
      setHeight(e.key==='Home'?MIN:e.key==='End'?MAX:h+(e.key==='ArrowDown'?20:-20),true);
    });
  }
  new ResizeObserver(()=>{if(swiftADXChart){swiftADXChart.resize();swiftADXChart.update('none');}scheduleSwiftVerticalExtensions();}).observe(pane);
}
function swiftADXSchedule(){if(swiftADXFrame)return;swiftADXFrame=requestAnimationFrame(()=>{swiftADXFrame=0;swiftADXRefresh();});}
function initTradingChart(){
  if(tvChart) return;
  const main=document.getElementById("tv-main-chart"),vol=document.getElementById("tv-volume-chart");
  if(!main||!vol) return;
  const theme=chartBackgroundOptions(tvChartTheme);
  const common={layout:theme.layout,grid:theme.grid,rightPriceScale:{visible:true,borderColor:theme.borderColor},timeScale:{visible:true},handleScroll:true,handleScale:true};
  tvChart=new OptionsSwiftCanvasChart(main,{...common,width:main.clientWidth,height:main.clientHeight});
  tvChart.showVolumeProfile=tvStudies.profile;
  tvFlowVolume=tvChart.addHistogramSeries({priceScaleId:"flow-volume",title:"$200K+ FLOW"});
  tvCandles=tvChart.addCandlestickSeries({upColor:"#26a69a",downColor:"#ef5350",priceLineVisible:true,lastValueVisible:true});
  for(const method of ['setData','update']){const original=tvCandles[method].bind(tvCandles);tvCandles[method]=function(...args){const result=original(...args);swiftADXSchedule();return result;};}
  try{swiftADXEnabled=localStorage.getItem('options_swift_adx_enabled')!=='0';}catch(_){}
  document.getElementById('swift-adx-pane').hidden=!swiftADXEnabled;
  initSwiftADXResizer();
  document.getElementById('tv-adx-btn')?.classList.toggle('on',swiftADXEnabled);
  tvVwap=tvChart.addLineSeries({color:tvColors.vwap,lineWidth:2,title:"VWAP"});
  tvEma7=tvChart.addLineSeries({color:tvColors.ema7,lineWidth:2,title:"EMA 7"});
  tvEma9=tvChart.addLineSeries({color:tvColors.ema9,lineWidth:2,title:"EMA 9"});
  tvEma21=tvChart.addLineSeries({color:tvColors.ema21,lineWidth:2,title:"EMA 21"});
  tvEma200=tvChart.addLineSeries({color:tvColors.ema200,lineWidth:2,title:"EMA 200"});
  tvBbUpper=tvChart.addLineSeries({color:tvColors.bb,lineWidth:1,lineStyle:2,title:"BB Upper"});
  tvBbMiddle=tvChart.addLineSeries({color:tvColors.bb,lineWidth:1,lineStyle:3,title:"BB Basis"});
  tvBbLower=tvChart.addLineSeries({color:tvColors.bb,lineWidth:1,lineStyle:2,title:"BB Lower"});
  tvVolumeChart=new OptionsSwiftCanvasChart(vol,{...common,width:vol.clientWidth,height:vol.clientHeight,plotRightInset:68,rightPriceScale:{visible:false},timeScale:{visible:false},handleScroll:false,handleScale:false});
  tvVolume=tvVolumeChart.addHistogramSeries({priceScaleId:"volume"});
  tvChart.timeScale().subscribeVisibleLogicalRangeChange(r=>{if(!r)return;tvVolumeChart.timeScale().setVisibleLogicalRange(r);scheduleFlowCandleLabels();swiftADXSchedule();});
  tvResizeObserver=new ResizeObserver(()=>{tvChart?.applyOptions({width:main.clientWidth,height:main.clientHeight});tvVolumeChart?.applyOptions({width:vol.clientWidth,height:vol.clientHeight});scheduleFlowCandleLabels();swiftADXSchedule();});
  tvResizeObserver.observe(main);tvResizeObserver.observe(vol);const profileBtn=document.getElementById("tv-profile-btn");profileBtn?.classList.toggle("on",tvStudies.profile);profileBtn?.setAttribute("aria-pressed",tvStudies.profile?"true":"false");syncTradingChartModeUI();setChartBackground(tvChartTheme,true);updateCustomDrawingControls();
}
function chartBackgroundOptions(theme=tvChartTheme){
  return theme==="white"
    ?{layout:{background:{color:"#ffffff"},textColor:"#334155"},grid:{vertLines:{color:"#e2e8f0"},horzLines:{color:"#e2e8f0"}},borderColor:"#cbd5e1"}
    :{layout:{background:{color:"#070b12"},textColor:"#9fb4c8"},grid:{vertLines:{color:"#111b29"},horzLines:{color:"#111b29"}},borderColor:"#223149"};
}
function setChartBackground(value,silent=false){
  const theme=value==="white"?"white":"dark";tvChartTheme=theme;
  try{localStorage.setItem("options_swift_chart_background",theme);}catch(_){}
  const select=document.getElementById("tv-background-select");if(select)select.value=theme;
  const options=chartBackgroundOptions(theme);
  for(const chart of [tvChart,tvVolumeChart])if(chart){chart.applyOptions({layout:options.layout,grid:options.grid,rightPriceScale:{visible:chart===tvChart,borderColor:options.borderColor}});chart.render();}
  if(CHART_WINDOW_MODE&&!silent)sendChartWindowCommand("background",theme);
  else if(!CHART_WINDOW_MODE&&isChartWindowOpen()&&!silent)scheduleChartWindowSync(true);
}
const CUSTOM_DRAW_LABELS={trend:"TREND",ray:"RAY",horizontal:"HORIZONTAL",channel:"CHANNEL",vertical:"VERTICAL"};
function customDrawInstruction(tool=tvChart?.drawingTool){return tool==="vertical"?"click a candle/time":tool==="horizontal"?"click a price":tool==="channel"?"click 3 points: baseline start, baseline end, channel width":"click 2 points";}
function updateCustomDrawingControls(){if(!tvChart)return;const tool=document.getElementById("os-draw-tool"),draw=document.getElementById("os-draw-line-btn"),extend=document.getElementById("os-draw-extend-btn"),magnet=document.getElementById("os-magnet-btn"),eraser=document.getElementById("os-eraser-btn");if(tool)tool.value=tvChart.drawingTool;if(draw){draw.classList.toggle("on",tvChart.drawingMode);draw.textContent=tvChart.drawingMode?`Draw: ${CUSTOM_DRAW_LABELS[tvChart.drawingTool]}`:"Draw: Off";}if(extend){extend.classList.toggle("on",tvChart.extendTrend);extend.textContent=`Extend: ${tvChart.extendTrend?"On":"Off"}`;}if(magnet){magnet.classList.toggle("on",tvChart.magnetMode);magnet.textContent=`Magnet: ${tvChart.magnetMode?"On":"Off"}`;}if(eraser){const ready=!!tvChart.selectedDrawing;eraser.classList.toggle("on",ready);eraser.disabled=!ready;eraser.textContent="Erase Selected";}}
function setCustomDrawTool(value){if(!tvChart)return;tvChart.setDrawingTool(value);updateCustomDrawingControls();const st=document.getElementById("tv-chart-status");if(st&&tvChart.drawingMode)st.textContent=`DRAW ${CUSTOM_DRAW_LABELS[tvChart.drawingTool]} · ${customDrawInstruction()}`;}
function toggleCustomDrawLine(){if(!tvChart)return;tvChart.setDrawingMode(!tvChart.drawingMode);updateCustomDrawingControls();const st=document.getElementById("tv-chart-status");if(st&&tvChart.drawingMode)st.textContent=`DRAW ${CUSTOM_DRAW_LABELS[tvChart.drawingTool]} · ${customDrawInstruction()} · magnet ${tvChart.magnetMode?"ON":"OFF"}`;else updateTradingChartStatus();}
function toggleCustomTrendExtension(){if(!tvChart)return;tvChart.setTrendExtension(!tvChart.extendTrend);updateCustomDrawingControls();}
function toggleCustomMagnet(){if(!tvChart)return;tvChart.setMagnetMode(!tvChart.magnetMode);updateCustomDrawingControls();const st=document.getElementById("tv-chart-status");if(st&&tvChart.drawingMode)st.textContent=`DRAW ${CUSTOM_DRAW_LABELS[tvChart.drawingTool]} · ${customDrawInstruction()} · magnet ${tvChart.magnetMode?"ON":"OFF"}`;}
function eraseSelectedDrawing(){if(!tvChart?.selectedDrawing)return;tvChart.deleteDrawing(tvChart.selectedDrawing);updateCustomDrawingControls();const st=document.getElementById("tv-chart-status");if(st)st.textContent="SELECTED DRAWING ERASED · all other drawings were kept";}
function clearCustomDrawings(){tvChart?.clearDrawings();}
function chartDateET(d=new Date()){return new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);}
function chartStartDate(){const d=new Date();d.setDate(d.getDate()-(tvTimeframe>=30?20:tvTimeframe>=15?10:5));return chartDateET(d);}
function aggregateBars(rows,mult){
  if(mult===1)return rows;
  const out=[], buckets=new Map();
  rows.forEach(r=>{const span=mult*60, key=Math.floor(r.time/span)*span;let b=buckets.get(key);if(!b){b={time:key,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume||0,vwapNumer:(r.vwap??r.close)*(r.volume||0)};buckets.set(key,b);out.push(b);}else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.volume+=(r.volume||0);b.vwapNumer+=(r.vwap??r.close)*(r.volume||0);}});
  return out.map(b=>({...b,vwap:b.volume?b.vwapNumer/b.volume:b.close}));
}
function setChartFlowStorageStatus(text,color="#9fb4c8"){
  const el=document.getElementById("tv-flow-storage-status");
  if(el){el.textContent=text;el.style.color=color;}
}
function openChartFlowDb(){
  if(chartFlowDbPromise)return chartFlowDbPromise;
  chartFlowDbPromise=new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB){reject(new Error("IndexedDB unavailable"));return;}
    const request=indexedDB.open(CHART_FLOW_DB_NAME,1);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(CHART_FLOW_DB_STORE))db.createObjectStore(CHART_FLOW_DB_STORE,{keyPath:"chartFlowId"});};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error("Unable to open flow history"));
  });
  return chartFlowDbPromise;
}
function chartFlowDirection(order){
  if(order?.direction==="BULLISH"||order?.direction==="BEARISH")return order.direction;
  const execution=String(order?.execution||"").toUpperCase();
  if(execution==="ASK BUY")return order.side==="call"?"BULLISH":"BEARISH";
  if(execution==="BID SELL")return order.side==="call"?"BEARISH":"BULLISH";
  return "UNCLEAR";
}
function normalizeChartFlowOrder(order){
  if(!order||(order.side!=="call"&&order.side!=="put"))return null;
  const size=Math.max(0,Number(order.size||0));
  const premium=Math.max(0,Number(order.prem??(Number(order.price||0)*size*100)));
  const tsMs=tapeTsMs(order.ts),firstMs=tapeTsMs(order.firstMs??order.ts);
  if(!size||premium<CANDLE_FLOW_MIN_PREMIUM||!Number.isFinite(tsMs)||tsMs<=0||!Number.isFinite(firstMs)||firstMs<=0)return null;
  const parsed=order.sym?parseOCC(order.sym):null;
  const expiration=isValidExpiry(order.expiration)?order.expiration:(parsed?.expiration||getSelectedExpiry());
  const execution=String(order.execution||"MID / UNCLEAR").toUpperCase();
  const symbol=String(order.sym||`${expiration}:${order.side}:${Number(order.strike)}`);
  // Rebuild the ID from canonical millisecond time so older nanosecond IDs and
  // restored millisecond records collapse into the same order.
  const chartFlowId=String(`${expiration}|${symbol}|${execution}|${chartFlowDirection(order)}|${Math.floor(firstMs/60000)}|${Math.round(firstMs)}`).slice(0,240);
  return{chartFlowId,expiration,sym:order.sym||"",ts:tsMs,firstMs,side:order.side,strike:Number(order.strike),price:Number(order.price||0),size,prem:premium,printCount:Math.max(1,Number(order.printCount||1)),execution,direction:chartFlowDirection(order),orderType:String(order.orderType||"ORDER"),capturedAt:tapeTsMs(order.capturedAt)||Date.now(),
    liveBid:Number.isFinite(+order.liveBid)&&+order.liveBid>0?+order.liveBid:null,
    liveAsk:Number.isFinite(+order.liveAsk)&&+order.liveAsk>0?+order.liveAsk:null,
    liveTs:Number.isFinite(+order.liveTs)?+order.liveTs:null};
}
// ── Candle flow live mark / estimated P&L ─────────────────────────────────
// Quote source priority: live WS NBBO → chain snapshot NBBO → quote shipped
// with the order (chart window, which has no options feed of its own).
function flowOrderQuote(order){
  if(!CHART_WINDOW_MODE){
    const hist=order.sym?(optionQuoteMap.get(order.sym)||[]):[];
    const q=hist.length?hist[hist.length-1]:null;
    if(q&&Number(q.bid)>0&&Number(q.ask)>0)return{bid:+q.bid,ask:+q.ask,ts:fTS(q.ts),src:"NBBO"};
    const c=lookupChainContract(order.sym,order.side,order.strike),lq=c?.last_quote||{};
    const bid=Number(lq.bid??lq.bid_price??0),ask=Number(lq.ask??lq.ask_price??0);
    if(bid>0&&ask>0&&ask>=bid)return{bid,ask,ts:tapeTsMs(lq.last_updated)||Date.now(),src:"SNAPSHOT"};
  }
  if(order.liveBid>0&&order.liveAsk>0)return{bid:order.liveBid,ask:order.liveAsk,ts:order.liveTs||null,src:"SYNC"};
  return null;
}
// Buyer or seller of premium. Execution first; otherwise infer from side + direction.
function flowOrderRole(order){
  const ex=String(order.execution||"").toUpperCase();
  if(ex==="ASK BUY")return"BUY";
  if(ex==="BID SELL")return"SELL";
  const dir=chartFlowDirection(order);
  if(dir==="BULLISH")return order.side==="call"?"BUY":"SELL";
  if(dir==="BEARISH")return order.side==="put"?"BUY":"SELL";
  return null;
}
// Group = same candle + same strike + same call/put + same direction.
function flowGroupPnL(orders){
  let size=0,cost=0,pnl=0,pnlBasis=0,priced=0,quote=null;
  for(const {order} of orders){
    const sz=Number(order.size||0),px=Number(order.price||0);if(!sz||!(px>0))continue;
    size+=sz;cost+=px*sz;
    const q=flowOrderQuote(order);if(q&&(!quote||(q.ts||0)>(quote.ts||0)))quote=q;
    const role=flowOrderRole(order);if(!q||!role)continue;
    // executable exit: a buyer sells at bid, a seller buys back at ask
    const exit=role==="BUY"?q.bid:q.ask;
    pnl+=(role==="BUY"?exit-px:px-exit)*sz*100;pnlBasis+=px*sz*100;priced++;
  }
  const avgFill=size?cost/size:null,mark=quote?(quote.bid+quote.ask)/2:null;
  const stale=quote?.ts?(Date.now()-quote.ts>30000&&quote.src!=="SNAPSHOT"):false;
  return{size,avgFill,mark,bid:quote?.bid??null,ask:quote?.ask??null,src:quote?.src||null,stale,
    pnl:priced?pnl:null,pct:priced&&pnlBasis?pnl/pnlBasis:null,
    markChg:mark!=null&&avgFill?(mark-avgFill)/avgFill:null,priced,role:orders.length?flowOrderRole(orders[0].order):null};
}
function fmtFlowPnl(r){
  if(r.pnl==null)return r.markChg==null?"":`Δ${r.markChg>=0?"+":""}${(r.markChg*100).toFixed(1)}%`;
  return `${r.pnl>=0?"+":"-"}${fD(Math.abs(r.pnl))} ${r.pct>=0?"+":""}${(r.pct*100).toFixed(1)}%`;
}
function mergeChartFlowOrders(records=[]){
  const map=new Map(chartFlowOrders.map(order=>[order.chartFlowId,order]));
  for(const raw of records){
    const order=normalizeChartFlowOrder(raw);if(!order)continue;
    const previous=map.get(order.chartFlowId);
    if(!previous||order.capturedAt>=Number(previous.capturedAt||0))map.set(order.chartFlowId,order);
  }
  const cutoff=Date.now()-CHART_FLOW_RETENTION_MS;
  const next=[...map.values()].filter(order=>Number(order.ts)>=cutoff).sort((a,b)=>Number(b.ts)-Number(a.ts)).slice(0,CHART_FLOW_MAX);
  // Any grouped order can grow as split prints/sweeps arrive. Comparing only the
  // newest row leaves the chart cache stale when an older group crosses $200K.
  const flowDigest = rows => rows.map(o=>`${o.chartFlowId}:${Math.round(Number(o.prem||0))}:${Number(o.size||0)}:${Number(o.printCount||1)}`).join("|");
  const changed = flowDigest(next) !== flowDigest(chartFlowOrders);
  chartFlowOrders=next;
  if(changed){
    chartFlowVersion++;
    flowVolumeCache=null; // invalidate chart label volume cache
  }
}
function currentQualifyingChartFlowOrders(groupedOverride=null){
  const groupedRaw=Array.isArray(groupedOverride)?groupedOverride:getGroupedTapeOrders();
  const grouped=groupedRaw.map(normalizeChartFlowOrder).filter(Boolean);

  // A raw print >= $200K must be allowed onto the candle chart even when no
  // reconstructed group is formed. If that print belongs to a multi-print group,
  // the group is authoritative so premium/contracts are not counted twice.
  const multiGroups=groupedRaw.filter(g=>Number(g?.printCount||1)>1).map(g=>({
    sym:String(g?.sym||""),
    side:g?.side,
    strike:Number(g?.strike),
    execution:String(g?.execution||"MID / UNCLEAR").toUpperCase(),direction:chartFlowDirection(g),
    firstMs:tapeTsMs(g?.firstMs??g?.ts),
    lastMs:tapeTsMs(g?.lastMs??g?.ts)
  }));
  const rawStandalone=[];
  for(const raw of tapePrints){
    const order=normalizeChartFlowOrder(raw);
    if(!order)continue;
    const rawMs=tapeTsMs(raw.ts);
    const rawExecution=String(raw.execution||"MID / UNCLEAR").toUpperCase();
    const covered=multiGroups.some(g=>
      g.sym===String(raw.sym||"") && g.side===raw.side &&
      g.strike===Number(raw.strike) && g.execution===rawExecution &&
      chartFlowDirection(g)===chartFlowDirection(raw) &&
      rawMs>=g.firstMs && rawMs<=g.lastMs
    );
    if(!covered)rawStandalone.push(order);
  }

  const map=new Map();
  for(const order of grouped)map.set(order.chartFlowId,order);
  for(const order of rawStandalone)if(!map.has(order.chartFlowId))map.set(order.chartFlowId,order);
  return[...map.values()].sort((a,b)=>Number(b.ts)-Number(a.ts));
}
function getChartFlowOrders(expiration=getSelectedExpiry()){
  const map=new Map();
  for(const order of chartFlowOrders)if(order.expiration===expiration)map.set(order.chartFlowId,order);
  for(const order of currentQualifyingChartFlowOrders())if(order.expiration===expiration)map.set(order.chartFlowId,order);
  return[...map.values()].sort((a,b)=>Number(b.ts)-Number(a.ts));
}
function loadChartFlowFallback(){
  try{const rows=JSON.parse(localStorage.getItem(CHART_FLOW_FALLBACK_KEY)||"[]");return Array.isArray(rows)?rows:[];}catch(_){return[];}
}
async function initChartFlowArchive(){
  if(CHART_WINDOW_MODE)return;
  let rows=[],usedFallback=false;
  try{
    const db=await openChartFlowDb();
    rows=await new Promise((resolve,reject)=>{const tx=db.transaction(CHART_FLOW_DB_STORE,"readonly"),request=tx.objectStore(CHART_FLOW_DB_STORE).getAll();request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>reject(request.error);});
  }catch(_){rows=loadChartFlowFallback();usedFallback=true;}
  mergeChartFlowOrders(rows);
  chartFlowArchiveLoaded=true;
  setChartFlowStorageStatus(`● ${chartFlowOrders.length.toLocaleString()} stored $200K+ order${chartFlowOrders.length===1?"":"s"} · ${CHART_FLOW_RETENTION_LABEL}${usedFallback?" · fallback storage":""}`,"#34d399");
  scheduleFlowCandleLabels();
  refreshFlowVolumeSeries();
  scheduleChartFlowArchive();
}
async function persistChartFlowArchive(){
  mergeChartFlowOrders(currentQualifyingChartFlowOrders());
  try{
    const db=await openChartFlowDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(CHART_FLOW_DB_STORE,"readwrite"),store=tx.objectStore(CHART_FLOW_DB_STORE);
      store.clear();for(const order of chartFlowOrders)store.put(order);
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("Flow history save aborted"));
    });
    setChartFlowStorageStatus(`● ${chartFlowOrders.length.toLocaleString()} stored $200K+ order${chartFlowOrders.length===1?"":"s"} · ${CHART_FLOW_RETENTION_LABEL}`,"#34d399");
  }catch(_){
    try{
      const fallback=chartFlowOrders.slice(0,750);localStorage.setItem(CHART_FLOW_FALLBACK_KEY,JSON.stringify(fallback));
      setChartFlowStorageStatus(`● ${fallback.length.toLocaleString()} stored $200K+ orders · fallback storage`,"#fbbf24");
    }catch(__){setChartFlowStorageStatus("● FLOW HISTORY STORAGE FULL · live chart only","#f87171");}
  }
}
function scheduleChartFlowArchive(){
  if(CHART_WINDOW_MODE||chartFlowArchiveTimer)return;
  chartFlowArchiveTimer=setTimeout(async()=>{chartFlowArchiveTimer=null;await persistChartFlowArchive();scheduleFlowCandleLabels();refreshFlowVolumeSeries();},1200);
}
// Resolve option-flow timestamps to the nearest real chart candle. This keeps
// $200K+ grouped flow visible when a REST/backfilled candle timestamp differs by
// one bucket or when a single 1-minute candle was missing during live recovery.
function resolveFlowCandleEntry(ts,bars=tvBars,maxDistanceSeconds=null){
  if(!Array.isArray(bars)||!bars.length)return null;
  const seconds=Math.floor(tapeTsMs(ts)/1000);
  if(!Number.isFinite(seconds))return null;
  const span=Math.max(60,Number(tvTimeframe||1)*60);
  const target=Math.floor(seconds/span)*span;
  let lo=0,hi=bars.length-1,best=null,bestDiff=Infinity;
  while(lo<=hi){
    const mid=(lo+hi)>>1,bar=bars[mid],t=Number(bar?.time);
    if(!Number.isFinite(t)){lo=mid+1;continue;}
    const diff=Math.abs(t-target);
    if(diff<bestDiff){best={bar,index:mid,time:t};bestDiff=diff;}
    if(t<target)lo=mid+1;else if(t>target)hi=mid-1;else break;
  }
  const limit=maxDistanceSeconds==null?span:Math.max(0,Number(maxDistanceSeconds));
  return best&&bestDiff<=limit?best:null;
}

function buildFlowTapeVolumeData(){
  // Cache until chart-flow version, premium filter, or timeframe changes.
  const ver = (typeof chartFlowVersion === "number" ? chartFlowVersion : 0)
    + (typeof flowForceVersion === "number" ? 0 : 0); // versioned with chartFlowVersion
  if(flowVolumeCache && flowVolumeCacheVersion === chartFlowVersion
      && flowVolumeCacheMinPrem === chartFlowMinPremium
      && flowVolumeCache._tf === tvTimeframe
      && flowVolumeCache._barCount === tvBars.length){
    return flowVolumeCache;
  }
  const buckets=new Map();
  const span=tvTimeframe*60;
  let callPremiumTotal=0,putPremiumTotal=0,bullPremiumTotal=0,bearPremiumTotal=0,unclearPremiumTotal=0,callContractsTotal=0,putContractsTotal=0,orderCount=0,printCount=0;
  for(const order of getChartFlowOrders()){
    if(order?.side!=="call"&&order?.side!=="put")continue;
    const size=Math.max(0,Number(order.size||0));
    const premium=Math.max(0,Number(order.prem??(Number(order.price||0)*size*100)));
    const seconds=Math.floor(tapeTsMs(order.ts)/1000);
    if(!size||premium<chartFlowMinPremium||!Number.isFinite(seconds))continue;
    const matched=resolveFlowCandleEntry(order.ts,tvBars,span);
    if(!matched)continue;
    const key=matched.time;
    let bucket=buckets.get(key);
    if(!bucket){bucket={callPremium:0,putPremium:0,bullPremium:0,bearPremium:0,unclearPremium:0,askBuyPremium:0,bidSellPremium:0,callContracts:0,putContracts:0,orders:0,prints:0};buckets.set(key,bucket);}
    if(order.side==="call"){
      bucket.callPremium+=premium;bucket.callContracts+=size;callPremiumTotal+=premium;callContractsTotal+=size;
    }else{
      bucket.putPremium+=premium;bucket.putContracts+=size;putPremiumTotal+=premium;putContractsTotal+=size;
    }
    const direction=chartFlowDirection(order);
    if(direction==="BULLISH"){bucket.bullPremium+=premium;bullPremiumTotal+=premium;}
    else if(direction==="BEARISH"){bucket.bearPremium+=premium;bearPremiumTotal+=premium;}
    else{bucket.unclearPremium+=premium;unclearPremiumTotal+=premium;}
    if(order.execution==="ASK BUY")bucket.askBuyPremium+=premium;
    else if(order.execution==="BID SELL")bucket.bidSellPremium+=premium;
    bucket.orders++;bucket.prints+=Number(order.printCount||1);orderCount++;printCount+=Number(order.printCount||1);
  }
  const _out={buckets,callPremiumTotal,putPremiumTotal,bullPremiumTotal,bearPremiumTotal,unclearPremiumTotal,callContractsTotal,putContractsTotal,orderCount,printCount,_tf:tvTimeframe,_barCount:tvBars.length};
  flowVolumeCache=_out; flowVolumeCacheVersion=chartFlowVersion; flowVolumeCacheMinPrem=chartFlowMinPremium;
  return _out;
}
function candleContractStoreKey(expiry=getSelectedExpiry()){return `${CANDLE_CONTRACT_STORE_PREFIX}:${expiry}`;}
function pruneCandleContractMinuteTotals(now=Date.now()){
  const cutoffSec=Math.floor((now-CANDLE_CONTRACT_RETENTION_MS)/1000);
  for(const key of [...candleContractMinuteTotals.keys()])if(Number(key)<cutoffSec)candleContractMinuteTotals.delete(key);
}
function recordCandleContracts(ts,side,size,premium=0){
  if(CHART_WINDOW_MODE)return;
  const ms=tapeTsMs(ts),contracts=Math.max(0,Number(size)||0),premiumDollars=Math.max(0,Number(premium)||0),kind=String(side||"").toLowerCase();
  if(!Number.isFinite(ms)||ms<=0||!contracts||(kind!=="call"&&kind!=="put"))return;
  const minute=Math.floor(Math.floor(ms/1000)/60)*60;
  let bucket=candleContractMinuteTotals.get(minute);
  if(!bucket){bucket={callContracts:0,putContracts:0,callPremium:0,putPremium:0,prints:0};candleContractMinuteTotals.set(minute,bucket);}
  if(kind==="call"){bucket.callContracts+=contracts;bucket.callPremium=(Number(bucket.callPremium)||0)+premiumDollars;}
  else {bucket.putContracts+=contracts;bucket.putPremium=(Number(bucket.putPremium)||0)+premiumDollars;}
  bucket.prints++;
  pruneCandleContractMinuteTotals();
  refreshCandleContractTotals();
  scheduleCandleContractPersist();
  scheduleChartWindowFlowSync();
}
function scheduleCandleContractPersist(){
  if(CHART_WINDOW_MODE||candleContractPersistTimer)return;
  candleContractPersistTimer=setTimeout(()=>{candleContractPersistTimer=null;persistCandleContractTotals();},500);
}
function persistCandleContractTotals(expiry=getSelectedExpiry()){
  if(CHART_WINDOW_MODE)return;
  try{
    pruneCandleContractMinuteTotals();
    const rows=[...candleContractMinuteTotals.entries()].map(([time,v])=>({time,...v}));
    localStorage.setItem(candleContractStoreKey(expiry),JSON.stringify({savedAt:Date.now(),rows}));
  }catch(e){console.warn("Candle contract persistence skipped",e);}
}
function loadCandleContractTotals(expiry=getSelectedExpiry()){
  if(CHART_WINDOW_MODE)return;
  candleContractMinuteTotals=new Map();
  try{
    const raw=localStorage.getItem(candleContractStoreKey(expiry));
    if(raw){
      const parsed=JSON.parse(raw),cutoffSec=Math.floor((Date.now()-CANDLE_CONTRACT_RETENTION_MS)/1000);
      for(const row of (Array.isArray(parsed?.rows)?parsed.rows:[])){
        const time=Number(row?.time);if(!Number.isFinite(time)||time<cutoffSec)continue;
        candleContractMinuteTotals.set(time,{callContracts:Math.max(0,Number(row.callContracts)||0),putContracts:Math.max(0,Number(row.putContracts)||0),callPremium:Math.max(0,Number(row.callPremium)||0),putPremium:Math.max(0,Number(row.putPremium)||0),prints:Math.max(0,Number(row.prints)||0)});
      }
    }
  }catch(e){console.warn("Unable to restore candle contract totals",e);}
  refreshCandleContractTotals();
}
function buildCandleContractTotals(){
  const span=Math.max(1,Number(tvTimeframe)||1)*60,buckets=new Map();
  pruneCandleContractMinuteTotals();
  for(const [minute,trade] of candleContractMinuteTotals){
    const key=Math.floor(Number(minute)/span)*span;
    let bucket=buckets.get(key);
    if(!bucket){bucket={callContracts:0,putContracts:0,callPremium:0,putPremium:0,prints:0};buckets.set(key,bucket);}
    bucket.callContracts+=Math.max(0,Number(trade.callContracts)||0);
    bucket.putContracts+=Math.max(0,Number(trade.putContracts)||0);
    bucket.callPremium+=Math.max(0,Number(trade.callPremium)||0);
    bucket.putPremium+=Math.max(0,Number(trade.putPremium)||0);
    bucket.prints+=Math.max(0,Number(trade.prints)||0);
  }
  return new Map([...buckets.entries()].sort((a,b)=>a[0]-b[0]));
}
function refreshCandleContractTotals(){
  // Contract hover counts ALL captured option WebSocket prints. The $200K+ setting
  // applies only to Flow Marks / large-order labels and cannot zero these totals.
  if(!CHART_WINDOW_MODE)tvCandleContractTotals=buildCandleContractTotals();
  tvChart?.render();
  return tvCandleContractTotals;
}
function serializeCandleContractTotals(){
  refreshCandleContractTotals();
  return [...tvCandleContractTotals.entries()].map(([time,value])=>({time,...value}));
}
function receiveCandleContractTotals(rows){
  tvCandleContractTotals=new Map((Array.isArray(rows)?rows:[]).filter(row=>Number.isFinite(Number(row?.time))).map(row=>[Number(row.time),{callContracts:Math.max(0,Number(row.callContracts)||0),putContracts:Math.max(0,Number(row.putContracts)||0),callPremium:Math.max(0,Number(row.callPremium)||0),putPremium:Math.max(0,Number(row.putPremium)||0),prints:Math.max(0,Number(row.prints)||0)}]));
}
function flowHistogramData(data=buildFlowTapeVolumeData()){
  const points=[];
  for(const bar of tvBars){
    const flow=data.buckets.get(bar.time);if(!flow)continue;
    const total=flow.callPremium+flow.putPremium;
    const directional=flow.bullPremium+flow.bearPremium;
    const net=flow.bullPremium-flow.bearPremium;
    const color=!directional||Math.abs(net)/directional<.12?"rgba(251,191,36,.48)":net>0?"rgba(52,211,153,.52)":"rgba(248,113,113,.52)";
    points.push({time:bar.time,value:total,color});
  }
  return points;
}
function refreshFlowVolumeSeries(){if(tvFlowVolume)tvFlowVolume.setData(tvStudies.flow?flowHistogramData():[]);}
// ── FLOW FORCE ────────────────────────────────────────────────────────────────
// Every live options-WS print that the NBBO classifier marks BULLISH (call ASK BUY / put BID SELL)
// or BEARISH (put ASK BUY / call BID SELL) is added to a per-minute contract ledger. The ledger is
// kept per expiration in localStorage so the ribbon survives reloads, then re-bucketed to whatever
// candle timeframe is showing. Ribbon = bullish share of the last N bars' contracts.
function flowForceStoreKey(expiry=getSelectedExpiry()){return `${FLOW_FORCE_STORE_PREFIX}:${expiry}`;}
function flowForceRecord(tsMs,premium,delta,direction,source="live"){
  if(CHART_WINDOW_MODE)return;
  if(direction!=="BULLISH"&&direction!=="BEARISH")return;
  const prem=Math.max(0,Number(premium)||0),d=Math.abs(Number(delta)),ms=tapeTsMs(tsMs);
  // Exact Options Swift formula: Trade Force = Premium × |Delta|.
  // If the chain snapshot has not supplied delta yet, wait rather than inventing a weight.
  if(!prem||!Number.isFinite(d)||d<=0||!Number.isFinite(ms)||ms<=0)return;
  const force=prem*Math.min(1,d);
  const minute=Math.floor(ms/60000)*60;
  let bucket=flowForceLedger.get(minute);
  if(!bucket){bucket={bull:0,bear:0,live:0,estimated:0};flowForceLedger.set(minute,bucket);}
  if(direction==="BULLISH")bucket.bull+=force;else bucket.bear+=force;
  if(source==="estimated")bucket.estimated=(bucket.estimated||0)+force;else bucket.live=(bucket.live||0)+force;
  flowForceVersion++;
  scheduleFlowForceRefresh();
  scheduleFlowForcePersist();
}
function scheduleFlowForcePersist(){
  if(CHART_WINDOW_MODE||flowForcePersistTimer)return;
  flowForcePersistTimer=setTimeout(()=>{flowForcePersistTimer=null;persistFlowForce();},2000);
}
function persistFlowForce(expiry=getSelectedExpiry()){
  if(CHART_WINDOW_MODE)return;
  try{
    const key=flowForceStoreKey(expiry),cutoff=Math.floor(Date.now()/1000)-FLOW_FORCE_KEEP_SEC;
    // A second dashboard tab sees the identical feed, so merge by max per minute instead of overwriting.
    const raw=localStorage.getItem(key);
    if(raw){
      for(const row of (JSON.parse(raw)?.rows||[])){
        const t=Number(row?.[0]),bull=Number(row?.[1])||0,bear=Number(row?.[2])||0,live=Number(row?.[3])||0,estimated=Number(row?.[4])||0;
        if(!Number.isFinite(t)||t<cutoff)continue;
        const cur=flowForceLedger.get(t);
        if(!cur)flowForceLedger.set(t,{bull,bear,live,estimated});else{cur.bull=Math.max(cur.bull,bull);cur.bear=Math.max(cur.bear,bear);cur.live=Math.max(cur.live||0,live);cur.estimated=Math.max(cur.estimated||0,estimated);}
      }
    }
    for(const t of [...flowForceLedger.keys()])if(t<cutoff)flowForceLedger.delete(t);
    const rows=[...flowForceLedger.entries()].sort((a,b)=>a[0]-b[0]).map(([t,v])=>[t,v.bull,v.bear,v.live||0,v.estimated||0]);
    localStorage.setItem(key,JSON.stringify({savedAt:Date.now(),rows}));
  }catch(e){console.warn("Flow Force persistence skipped",e);}
}
function loadFlowForce(){
  if(CHART_WINDOW_MODE)return;
  flowForceLedger=new Map();
  try{
    const raw=localStorage.getItem(flowForceStoreKey()),cutoff=Math.floor(Date.now()/1000)-FLOW_FORCE_KEEP_SEC;
    for(const row of (raw?JSON.parse(raw)?.rows:[])||[]){
      const t=Number(row?.[0]),bull=Number(row?.[1])||0,bear=Number(row?.[2])||0,live=Number(row?.[3])||0,estimated=Number(row?.[4])||0;
      if(Number.isFinite(t)&&t>=cutoff&&(bull||bear))flowForceLedger.set(t,{bull,bear,live,estimated});
    }
  }catch(e){console.warn("Unable to restore Flow Force history",e);}
  flowForceVersion++;
  scheduleFlowForceRefresh();
}
function serializeFlowForce(){return [...flowForceLedger.entries()].map(([t,v])=>[t,v.bull,v.bear,v.live||0,v.estimated||0]);}
function receiveFlowForce(rows){
  flowForceLedger=new Map((Array.isArray(rows)?rows:[]).filter(r=>Array.isArray(r)&&Number.isFinite(Number(r[0]))).map(r=>[Number(r[0]),{bull:Math.max(0,Number(r[1])||0),bear:Math.max(0,Number(r[2])||0),live:Math.max(0,Number(r[3])||0),estimated:Math.max(0,Number(r[4])||0)}]));
}
function buildFlowForceRows(){
  const span=Math.max(1,Number(tvTimeframe)||1)*60,len=flowForceLen,per=new Map();
  for(const [minute,v] of flowForceLedger){
    const key=Math.floor(minute/span)*span;let b=per.get(key);
    if(!b){b={bull:0,bear:0,live:0,estimated:0};per.set(key,b);}
    b.bull+=v.bull;b.bear+=v.bear;b.live+=v.live||0;b.estimated+=v.estimated||0;
  }
  const rows=new Map(),win=[];let wBull=0,wBear=0,wLive=0,wEstimated=0,prev=null;
  for(const bar of tvBars){
    if(prev!=null&&bar.time-prev>4*3600){win.length=0;wBull=0;wBear=0;wLive=0;wEstimated=0;} // new session: restart the lookback
    prev=bar.time;
    const b=per.get(bar.time)||{bull:0,bear:0,live:0,estimated:0};
    win.push(b);wBull+=b.bull;wBear+=b.bear;wLive+=b.live||0;wEstimated+=b.estimated||0;
    if(win.length>len){const old=win.shift();wBull-=old.bull;wBear-=old.bear;wLive-=old.live||0;wEstimated-=old.estimated||0;}
    const total=wBull+wBear;
    const score=total>0?100*(wBull-wBear)/total:null; // normalized Flow Force: -100 bearish to +100 bullish
    rows.set(bar.time,{time:bar.time,bull:b.bull,bear:b.bear,wBull,wBear,wLive,wEstimated,score,share:Number.isFinite(score)?50+score/2:null});
  }
  return rows;
}
function scheduleFlowForceRefresh(){
  if(flowForceRefreshTimer)return;
  flowForceRefreshTimer=setTimeout(()=>{flowForceRefreshTimer=null;refreshFlowForceSeries();},120);
}
function refreshFlowForceNow(){
  if(flowForceRefreshTimer){clearTimeout(flowForceRefreshTimer);flowForceRefreshTimer=null;}
  refreshFlowForceSeries();
}
function refreshFlowForceSeries(){
  if(!CHART_WINDOW_MODE&&isChartWindowOpen()){scheduleChartWindowFlowSync();return;}
  const map=tvStudies.flowForce?buildFlowForceRows():new Map();let hasData=false;
  for(const r of map.values())if(Number.isFinite(r.share)){hasData=true;break;}
  tvFlowForce={map,len:flowForceLen,hasData};
  if(tvChart){tvChart.showFlowForce=!!tvStudies.flowForce;tvChart.flowForce=tvFlowForce;tvChart.render();}
}
function setFlowForceLength(value,silent=false){
  const next=Number(value);if(!FLOW_FORCE_LENGTHS.includes(next))return;
  flowForceLen=next;
  try{localStorage.setItem("options_swift_flow_force_len",String(next));}catch(_){}
  const select=document.getElementById("tv-flowforce-len");if(select)select.value=String(next);
  refreshFlowForceSeries();
  if(!silent){if(CHART_WINDOW_MODE)sendChartWindowCommand("flowForceLen",next);else if(isChartWindowOpen())scheduleChartWindowSync(true);}
}
function flowOutcomeForDirection(time,bias){
  const horizon=Math.max(15,tvTimeframe);
  if(bias!=="BULLISH"&&bias!=="BEARISH")return{bias:"UNCLEAR",horizon,pending:false,movePct:null,followed:null};
  const target=time+horizon*60;
  const session=chartDateET(new Date(time*1000));
  const entry=tvBars.find(bar=>bar.time===time),future=tvBars.find(bar=>bar.time>=target&&chartDateET(new Date(bar.time*1000))===session);
  if(!entry||!future)return{bias,horizon,pending:true,movePct:null,followed:null};
  const movePct=(future.close-entry.close)/Math.max(.01,entry.close);
  return{bias,horizon,pending:false,movePct,followed:bias==="BULLISH"?movePct>0:movePct<0};
}
function flowOrderDte(order){
  const expiration=isValidExpiry(order?.expiration)?order.expiration:(order?.sym?parseOCC(order.sym)?.expiration:null);
  if(!isValidExpiry(expiration))return"?";
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:MARKET_TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(tapeTsMs(order.ts))).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
  const tradeDate=new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`),expiryDate=new Date(`${expiration}T00:00:00Z`);
  return String(Math.max(0,Math.round((expiryDate-tradeDate)/86400000)));
}
function flowExecutionShort(execution){
  const value=String(execution||"").toUpperCase();
  if(value==="ASK BUY")return"ASK";
  if(value==="BID SELL")return"BID";
  if(value==="MULTI-LEG")return"MULTI";
  if(value==="LATE PRINT")return"LATE";
  if(value==="NO NBBO")return"NO NBBO";
  if(value==="STALE NBBO")return"STALE";
  return"MID";
}
const FLOW_MARK_GAPS=[10,22,38,60];
let flowMarkGap=+(localStorage.getItem("options_swift_flow_gap")||22);if(!FLOW_MARK_GAPS.includes(flowMarkGap))flowMarkGap=22;
function setFlowMarkGap(value){
  const next=+value;if(!FLOW_MARK_GAPS.includes(next))return;flowMarkGap=next;
  try{localStorage.setItem("options_swift_flow_gap",String(next));}catch(_){}
  const sel=document.getElementById("tv-flow-gap-select");if(sel)sel.value=String(next);
  scheduleFlowCandleLabels();
}
window.addEventListener("storage",e=>{if(e.key==="options_swift_flow_gap"&&e.newValue)setFlowMarkGap(e.newValue);});
{const syncGapSel=()=>{const sel=document.getElementById("tv-flow-gap-select");if(sel)sel.value=String(flowMarkGap);};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",syncGapSel);else syncGapSel();}
function flowMarkPremiumText(){return `$${Math.round(chartFlowMinPremium/1000)}K+`;}
function renderFlowCandleLabels(){
  const layer=document.getElementById("tv-flow-label-layer"),summary=document.getElementById("tv-flow-label-summary");
  if(!layer)return;
  layer.replaceChildren();
  if(!tvStudies.flow){if(summary)summary.textContent=`${flowMarkPremiumText()} stored flow: hidden`;return;}
  const data=buildFlowTapeVolumeData();
  if(summary){
    if(!tvBars.length)summary.textContent=`${flowMarkPremiumText()} stored flow: waiting for price candles`;
    else if(!data.orderCount)summary.textContent=`${flowMarkPremiumText()} stored flow: no qualifying orders in the loaded candle range`;
    else summary.textContent=`${flowMarkPremiumText()} stored flow · ${fN(data.orderCount)} orders / ${fN(data.printCount)} prints · BULL ${fD(data.bullPremiumTotal)} · BEAR ${fD(data.bearPremiumTotal)} · UNCLEAR ${fD(data.unclearPremiumTotal)}`;
  }
  if(!tvChart||!tvCandles||!tvBars.length||!data.orderCount||!layer.clientWidth)return;
  const W=layer.clientWidth,H=layer.clientHeight;
  const range=tvChart.timeScale().getVisibleLogicalRange();
  const first=Math.max(0,Math.floor(range?.from??0)),last=Math.min(tvBars.length-1,Math.ceil(range?.to??tvBars.length-1));
  const visibleBars=[];
  for(let index=first;index<=last;index++){const bar=tvDisplayBars[index]||tvBars[index];if(bar)visibleBars.push({bar,index,time:Number(bar.time)});}

  // ── 1. STRICT chart grouping: ONE group per candle + strike + direction ──
  const span=tvTimeframe*60,groups=new Map();let orderTotal=0;
  for(const order of getChartFlowOrders()){
    const premium=Number(order.prem||0);if(premium<chartFlowMinPremium)continue;
    const matched=resolveFlowCandleEntry(order.ts,tvBars,span);if(!matched)continue;
    const time=matched.time;
    if(matched.index<first||matched.index>last)continue;
    const entry={bar:tvDisplayBars[matched.index]||tvBars[matched.index],index:matched.index};
    const bias=chartFlowDirection(order),strike=Number(order.strike),key=`${time}|${order.side}|${strike}|${bias}`;
    let g=groups.get(key);
    if(!g){
      const {bar,index}=entry,x=tvChart.timeScale().timeToCoordinate(time),highY=tvCandles.priceToCoordinate(bar.high),lowY=tvCandles.priceToCoordinate(bar.low);
      if(!Number.isFinite(x)||!Number.isFinite(highY)||!Number.isFinite(lowY))continue;
      g={key,time,index,x,highY,lowY,bias,strike,optSide:order.side,orders:[],premium:0,callPrem:0,putPrem:0};groups.set(key,g);
    }
    g.orders.push({order,premium});g.premium+=premium;if(order.side==="call")g.callPrem+=premium;else g.putPrem+=premium;orderTotal++;
  }
  if(!groups.size)return;
  const list=[...groups.values()];
  for(const g of list){
    g.orders.sort((a,b)=>b.premium-a.premium);
    g.live=flowGroupPnL(g.orders);g.pnlText=fmtFlowPnl(g.live);
    // PUT premium above the candle high, CALL premium below the candle low
    // (colour still shows direction: green bullish / red bearish / amber unclear)
    g.side=g.optSide==="put"?"above":"below";
  }
  // an UNCLEAR group sharing a wick with a directional group sits one step further out
  const wickSlots=new Map();
  for(const g of [...list].sort((a,b)=>(a.bias==="UNCLEAR")-(b.bias==="UNCLEAR"))){const k=`${g.time}|${g.side}`,n=wickSlots.get(k)||0;g.slot=n;wickSlots.set(k,n+1);}

  // ── 2. geometry & tier budgets scale with chart width and zoom ──
  const maxPrem=Math.max(...list.map(g=>g.premium)),minPrem=chartFlowMinPremium;
  const dotSize=p=>Math.round(7+9*Math.sqrt(Math.max(0,(p-minPrem))/Math.max(1,maxPrem-minPrem)));
  const barPx=W/Math.max(1,last-first+1);
  const fullBudget=Math.max(3,Math.floor(W/(barPx<6?220:150)));   // detailed labels
  const chipBudget=Math.max(6,Math.floor(W/(barPx<6?90:60)));     // short $ chips
  const TOP_RESERVED=38,BOTTOM_RESERVED=12,LANE0=14,LANE_STEP=19,MAX_LANES=9,LABEL_H=16,GAP_X=5,GAP_Y=2;
  const occupied=[];
  // keep-out box around every visible candle so no mark ever covers a wick end
  const WICK_PAD=Math.max(6,flowMarkGap*.6),candleCols=[];
  for(let index=first;index<=last;index++){
    const bar=tvDisplayBars[index]||tvBars[index];if(!bar)continue;
    const x=tvChart.timeScale().timeToCoordinate(bar.time),hy=tvCandles.priceToCoordinate(bar.high),ly=tvCandles.priceToCoordinate(bar.low);
    if(!Number.isFinite(x)||!Number.isFinite(hy)||!Number.isFinite(ly))continue;
    const half=Math.max(2,barPx*.45);candleCols.push({x,hy,ly});
    occupied.push({left:x-half,right:x+half,top:hy-WICK_PAD,bottom:ly+WICK_PAD});
  }
  const localExtreme=(x,halfW,side)=>{let v=null;for(const c of candleCols){if(Math.abs(c.x-x)>halfW+barPx*.5)continue;const y=side==="above"?c.hy:c.ly;v=v==null?y:(side==="above"?Math.min(v,y):Math.max(v,y));}return v;};
  const aiPanel=document.getElementById("os-ai-panel");
  if(aiPanel&&aiPanel.offsetParent){const a=aiPanel.getBoundingClientRect(),r=layer.getBoundingClientRect();occupied.push({left:a.left-r.left-4,right:a.right-r.left+4,top:a.top-r.top-4,bottom:a.bottom-r.top+4});}
  const overlaps=b=>occupied.some(o=>b.left<o.right+GAP_X&&b.right>o.left-GAP_X&&b.top<o.bottom+GAP_Y&&b.bottom>o.top-GAP_Y);
  const col=b=>b==="BULLISH"?"#34d399":b==="BEARISH"?"#fb7185":"#fbbf24";
  const arrowOf=b=>b==="BULLISH"?"▲":b==="BEARISH"?"▼":"◆";
  const strikeTxt=o=>{const s=Number(o.strike);return Number.isInteger(s)?String(s):String(s).replace(/0+$/,"").replace(/\.$/,"");};

  // ── 3. dots: every group gets a premium-sized dot on its wick (never hidden) ──
  const fragment=document.createDocumentFragment();
  for(const g of list){
    const d=dotSize(g.premium),dir=g.side==="above"?-1:1;
    const own=g.side==="above"?g.highY:g.lowY,near=localExtreme(g.x,d/2,g.side),wickY=near==null?own:(g.side==="above"?Math.min(own,near):Math.max(own,near));
    g.dotD=d;g.dotY=wickY+dir*(flowMarkGap+d/2+g.slot*(d+3));
    // dots are drawn under labels; register them so labels don't cover them
    occupied.push({left:g.x-d/2,right:g.x+d/2,top:g.dotY-d/2,bottom:g.dotY+d/2});
  }

  // ── 4. labels: biggest groups first, full → chip → dot-only ──
  const ranked=[...list].sort((a,b)=>b.premium-a.premium);
  let fullCount=0,chipCount=0;
  const place=(g,text,width)=>{
    const sides=[g.side]; // puts always above, calls always below — never flipped to the other side
    const cx=Math.max(width/2+2,Math.min(W-width/2-2,g.x));
    for(const side of sides){
      const sd=side==="above"?-1:1,edge=side===g.side?g.dotY+sd*(g.dotD/2):(side==="above"?g.highY:g.lowY)+sd*flowMarkGap;
      for(let lane=0;lane<MAX_LANES;lane++){
        const cy=edge+sd*(LANE0+lane*LANE_STEP-(side===g.side?6:0));
        if(cy-LABEL_H/2<TOP_RESERVED||cy+LABEL_H/2>H-BOTTOM_RESERVED)continue;
        const box={left:cx-width/2,right:cx+width/2,top:cy-LABEL_H/2,bottom:cy+LABEL_H/2};
        if(overlaps(box))continue;
        occupied.push(box);return{cx,cy,side,box};
      }
    }
    return null;
  };
  for(const g of ranked){
    const top=g.orders[0].order,n=g.orders.length,arrow=arrowOf(g.bias);
    const lead=`${top.side==="call"?"C":"P"}${strikeTxt(top)} ${flowExecutionShort(top.execution)} ${flowOrderDte(top)}DTE`;
    let tier=null,text=null,pos=null;
    const mk="";
    const pl="";
    if(fullCount<fullBudget){
      text=n>1?`${arrow} ${fD(g.premium)} ×${n} · ${lead}`:`${arrow} ${lead} ${fD(g.premium)}`;
      const extra=`${mk}${pl}`?` ·${mk}${pl}`:"";
      pos=place(g,text+extra,(text+extra).length*6.1+14);if(pos)tier="full";
    }
    if(!tier&&chipCount<chipBudget){
      text=`${arrow} ${top.side==="call"?"C":"P"}${strikeTxt(top)} ${fD(g.premium).replace(/\.0K$/,"K").replace(/(\.\d)\dM$/,"$1M")}${n>1?` ×${n}`:""}`;
      pos=place(g,text+pl,(text+pl).length*6.1+10);if(pos)tier="chip";
    }
    g.tier=tier||"dot";g.text=text;g.pos=pos;
    if(tier==="full")fullCount++;else if(tier==="chip")chipCount++;
  }

  // ── 5. draw ──
  for(const g of list){
    const outcome=flowOutcomeForDirection(g.time,g.bias),c=col(g.bias);
    const outcomeText=outcome.pending?`${outcome.horizon}m result pending`:outcome.movePct==null?`${outcome.horizon}m result unavailable`:`${outcome.horizon}m ${outcome.followed?"FOLLOWED ✓":"DID NOT FOLLOW ✕"} · SPY ${outcome.movePct>=0?"+":""}${(outcome.movePct*100).toFixed(2)}%`;
    const rows=g.orders.slice(0,10).map(({order,premium})=>`  ${order.side==="call"?"C":"P"}${strikeTxt(order)} ${flowExecutionShort(order.execution)} ${flowOrderDte(order)}DTE ${fD(premium)} · ${fN(order.size)} ct${Number(order.printCount||1)>1?` · ${fN(order.printCount)} prints`:""}`);
    if(g.orders.length>10)rows.push(`  … +${g.orders.length-10} more`);
    const L=g.live,px=v=>v==null?"—":`$${v.toFixed(2)}`;
    const roleTxt=L.role==="BUY"?"buyer → exit at BID":L.role==="SELL"?"seller → exit at ASK":"direction unclear → no executable P&L";
    const liveTxt=`${g.optSide==="call"?"CALL":"PUT"} $${strikeTxt({strike:g.strike})} · ${fN(L.size)} ct · avg fill ${px(L.avgFill)}\nMARK ${px(L.mark)}${L.stale?" (stale)":""} · bid ${px(L.bid)} / ask ${px(L.ask)}${L.src?` · ${L.src}`:" · no quote"}\nEST P&L ${L.pnl==null?"—":`${L.pnl>=0?"+":"-"}${fD(Math.abs(L.pnl))} (${L.pct>=0?"+":""}${(L.pct*100).toFixed(1)}%)`} · ${roleTxt}`;
    const tip=`${formatMarketTime(chartTimeDate(g.time),false,false)} · ${g.bias} · ${fD(g.premium)} in ${g.orders.length} order${g.orders.length===1?"":"s"}\n${liveTxt}\n${rows.join("\n")}\n${outcomeText}`;

    const dot=document.createElement("div");dot.className=`tv-flow-dot ${g.bias.toLowerCase()}${outcome.followed===false?" failed":""}`;
    dot.style.cssText=`left:${g.x}px;top:${g.dotY}px;width:${g.dotD}px;height:${g.dotD}px;--c:${c}`;dot.title=tip;
    fragment.append(dot);
    if(g.tier==="dot")continue;
    const {cx,cy,side}=g.pos,labelEdge=cy+(side==="above"?LABEL_H/2:-LABEL_H/2),dist=Math.abs(labelEdge-g.dotY);
    if(dist>g.dotD/2+6){
      const conn=document.createElement("div");conn.className="tv-flow-connector";
      conn.style.cssText=`left:${g.x}px;top:${Math.min(g.dotY,labelEdge)}px;height:${dist}px;border-left-color:${c}66`;
      fragment.append(conn);
    }
    const badge=document.createElement("div");badge.className=`tv-flow-candle-label ${g.tier} ${g.bias.toLowerCase()}`;
    badge.style.left=`${cx}px`;badge.style.top=`${cy}px`;badge.title=tip;
    const main=document.createElement("span");main.className=`flow-order-main ${g.bias.toLowerCase()}`;main.textContent=g.text;


    // Follow-through check/X intentionally hidden on chart labels.
    badge.append(main);fragment.append(badge);
  }
  layer.appendChild(fragment);
  if(summary){const hidden=list.filter(g=>g.tier==="dot").length;summary.textContent+=` · ${list.length} clusters (${fullCount} labelled, ${chipCount} chips${hidden?`, ${hidden} dot-only — hover or zoom in`:""})`;}
}
function scheduleFlowCandleLabels(){
  if(!CHART_WINDOW_MODE&&isChartWindowOpen()){scheduleChartWindowFlowSync();return;}
  // Skip expensive label layout when Flow Marks are off or chart tab is not visible.
  if(!tvStudies.flow){
    const layer=document.getElementById("tv-flow-label-layer");
    if(layer) layer.replaceChildren();
    return;
  }
  const chartVisible = CHART_WINDOW_MODE
    || document.getElementById("tc-chart")?.classList.contains("on");
  if(!chartVisible) return;
  if(tvFlowLabelFrame!=null)return;
  const schedule=globalThis.requestAnimationFrame||((fn)=>setTimeout(fn,16));
  tvFlowLabelFrame=schedule(()=>{tvFlowLabelFrame=null;renderFlowCandleLabels();});
}
function heikinAshiBar(bar,previous=null){
  const close=(bar.open+bar.high+bar.low+bar.close)/4;
  const open=previous?(previous.open+previous.close)/2:(bar.open+bar.close)/2;
  return{time:bar.time,open,high:Math.max(bar.high,open,close),low:Math.min(bar.low,open,close),close,volume:bar.volume||0};
}
function buildTradingDisplayBars(bars=tvBars){
  if(tvChartMode!=="heikin")return bars.map(b=>({time:b.time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume||0}));
  const output=[];let previous=null;
  bars.forEach(bar=>{const candle=heikinAshiBar(bar,previous);output.push(candle);previous=candle;});
  return output;
}
function syncTradingChartModeUI(){
  document.querySelectorAll("[data-chart-mode]").forEach(btn=>{
    const active=btn.dataset.chartMode===tvChartMode;
    btn.classList.toggle("on",active);
    btn.setAttribute("aria-pressed",String(active));
  });
  const isHeikin=tvChartMode==="heikin";
  const watermark=document.getElementById("tv-chart-watermark");
  const note=document.getElementById("tv-candle-mode-note");
  const watermarkMeta=watermark?.querySelector(".tv-brand-meta");
  if(watermarkMeta)watermarkMeta.textContent=`SPY · ${isHeikin?"HEIKIN ASHI":"CANDLES"} · ${DEMO_MODE?"MOCK DATA":"MASSIVE SIP"} · OPTIONS SWIFT CANVAS · NEW YORK TIME`;
  if(note)note.textContent=isHeikin?"Price: Heikin Ashi smoothed candles":"Price: standard OHLC candles";
}
function updateTradingChartStatus(){
  const st=document.getElementById("tv-chart-status");
  if(st&&tvBars.length&&!st.classList.contains("tv-error"))st.textContent=`OPTIONS SWIFT ${DEMO_MODE?"DEMO":"LIVE"} · ${tvBars.length.toLocaleString()} candles · ${tvTimeframe<60?tvTimeframe+"m":"1H"} · ${tvChartMode==="heikin"?"HEIKIN ASHI":"STANDARD"}`;
}
function setChartMode(mode){
  if(mode!=="candles"&&mode!=="heikin")return;
  tvChartMode=mode;
  localStorage.setItem("options_swift_chart_mode",mode);
  syncTradingChartModeUI();
  applyTradingChartData(false);
  updateTradingChartStatus();
  if(CHART_WINDOW_MODE)sendChartWindowCommand("mode",mode);
}
function emaData(bars,len){let e=null,k=2/(len+1);return bars.map(b=>{e=e==null?b.close:b.close*k+e*(1-k);return{time:b.time,value:e};});}
function bollingerData(bars,len=20,mult=2){
  const upper=[],middle=[],lower=[],window=[];
  bars.forEach(b=>{window.push(b.close);if(window.length>len)window.shift();const mean=window.reduce((a,x)=>a+x,0)/window.length;const variance=window.reduce((a,x)=>a+(x-mean)*(x-mean),0)/window.length;const sd=Math.sqrt(variance);upper.push({time:b.time,value:mean+mult*sd});middle.push({time:b.time,value:mean});lower.push({time:b.time,value:mean-mult*sd});});
  return{upper,middle,lower};
}
function studyData(bars){let pv=0,v=0;const vwap=bars.map(b=>{const q=b.volume||0;pv+=(b.vwap??((b.high+b.low+b.close)/3))*q;v+=q;return{time:b.time,value:v?pv/v:b.close};});const bb=bollingerData(bars,20,2);return{vwap,ema7:emaData(bars,7),ema9:emaData(bars,9),ema21:emaData(bars,21),ema200:emaData(bars,200),bb};}
async function loadTradingChart(force=false){
  if(CHART_WINDOW_MODE&&window.opener&&!window.opener.closed){sendChartWindowCommand("refresh");return;}
  initTradingChart(); if(!tvChart||tvLoading||!API_KEY)return;if(!force&&tvLoadedTf===tvTimeframe&&tvBars.length)return;
  tvLoading=true;const st=document.getElementById("tv-chart-status");if(st){st.textContent=DEMO_MODE?"Loading synthetic candles.":"Loading Massive candles…";st.classList.remove("tv-error");}
  try{
    const end=chartDateET(),start=chartStartDate();
    const j=await pg(`/v2/aggs/ticker/SPY/range/1/minute/${start}/${end}?adjusted=true&sort=asc&limit=50000`);
    const raw=(j?.results||[]).map(r=>({time:Math.floor(r.t/1000),open:r.o,high:r.h,low:r.l,close:r.c,volume:r.v||0,vwap:r.vw??r.c}));
    if(!raw.length)throw new Error("No candle data returned for this stock plan.");
    // REST is authoritative on reopen. De-duplicate by exact 1-minute timestamp,
    // sort chronologically, then rebuild the selected timeframe. This prevents
    // stale/duplicate WebSocket-built candles from creating visual skips.
    const deduped=[...new Map(raw.map(b=>[b.time,b])).values()].sort((a,b)=>a.time-b.time);
    tvBars=aggregateBars(deduped,tvTimeframe);tvLoadedTf=tvTimeframe;applyTradingChartData(false);
    if(tvLiveFollow)scrollTradingChartToLatest();
    updateTradingChartStatus();
  }catch(e){if(st){st.textContent=`Chart unavailable: ${e.message||e}`;st.classList.add("tv-error");}}
  finally{tvLoading=false;}
}
async function reconcileFinalizedTradingCandles(){
  if((CHART_WINDOW_MODE&&window.opener&&!window.opener.closed)||!API_KEY||tvLoading||!tvBars.length)return;
  try{
    const day=chartDateET();
    const j=await pg(`/v2/aggs/ticker/SPY/range/1/minute/${day}/${day}?adjusted=true&sort=asc&limit=5000`);
    const raw=(j?.results||[]).map(r=>({time:Math.floor(r.t/1000),open:r.o,high:r.h,low:r.l,close:r.c,volume:r.v||0,vwap:r.vw??r.c}));
    if(!raw.length)return;
    const official=aggregateBars(raw,tvTimeframe),span=tvTimeframe*60,cutoff=Math.floor(Date.now()/1000)-12;
    const byTime=new Map(tvBars.map((bar,index)=>[bar.time,index]));
    let changed=false;
    for(const bar of official){
      if(bar.time+span>cutoff)continue; // only replace candles the server has finalized
      const index=byTime.get(bar.time);
      if(index==null){tvBars.push(bar);changed=true;continue;}
      const old=tvBars[index];
      if(old.open!==bar.open||old.high!==bar.high||old.low!==bar.low||old.close!==bar.close||old.volume!==bar.volume){tvBars[index]=bar;changed=true;}
    }
    if(changed){tvBars.sort((a,b)=>a.time-b.time);applyTradingChartData(false);}
  }catch(_){/* Keep the live chart running; retry on the next reconciliation. */}
}
function applyTradingChartData(fit=false){
  if(!tvCandles)return;
  flowVolumeCache=null;
  refreshCandleContractTotals();
  if(!CHART_WINDOW_MODE&&isChartWindowOpen()){scheduleChartWindowSync(true);return;}
  tvDisplayBars=buildTradingDisplayBars();
  tvChart.showVolumeProfile=tvStudies.profile;tvChart.showFlowForce=!!tvStudies.flowForce;
  tvCandles.setData(tvDisplayBars.map(({time,open,high,low,close,volume})=>({time,open,high,low,close,volume:Number(volume)||0})));
  tvVolume.setData(tvDisplayBars.map(b=>({time:b.time,value:b.volume,color:b.close>=b.open?"rgba(38,166,154,.55)":"rgba(239,83,80,.55)"})));
  refreshFlowVolumeSeries();refreshFlowForceSeries();
  const d=studyData(tvBars);
  tvVwap.setData(tvStudies.vwap?d.vwap:[]);tvEma7.setData(tvStudies.ema7?d.ema7:[]);tvEma9.setData(tvStudies.ema9?d.ema9:[]);tvEma21.setData(tvStudies.ema21?d.ema21:[]);tvEma200.setData(tvStudies.ema200?d.ema200:[]);
  tvBbUpper.setData(tvStudies.bb?d.bb.upper:[]);tvBbMiddle.setData(tvStudies.bb?d.bb.middle:[]);tvBbLower.setData(tvStudies.bb?d.bb.lower:[]);
  scheduleFlowCandleLabels();refreshChartLevels();refreshSupplyDemandZones();if(fit)fitTradingChart();
}
function updateTradingChartTick(price,eventTimestamp=Date.now()){
  const lp=document.getElementById("tv-live-price");if(lp)lp.textContent=price?`$${price.toFixed(2)}`:"—";
  if(!tvBars.length||!price)return;
  const eventMs=tapeTsMs(eventTimestamp)||Date.now();
  const eventSeconds=Math.floor(eventMs/1000),span=tvTimeframe*60,key=Math.floor(eventSeconds/span)*span;
  let b=tvBars[tvBars.length-1];
  // A corrected or delayed trade must never be appended after a newer candle.
  if(b&&key<b.time)return;
  if(!b||b.time!==key){
    const previousTime=b?.time;
    b={time:key,open:price,high:price,low:price,close:price,volume:0,vwap:price};tvBars.push(b);
    // If the browser was suspended long enough to jump over one or more chart
    // buckets, immediately ask REST to reconcile the missing finalized candles.
    if(previousTime!=null && key-previousTime>span){
      clearTimeout(updateTradingChartTick._gapTimer);
      updateTradingChartTick._gapTimer=setTimeout(()=>reconcileFinalizedTradingCandles(),900);
    }
  }
  else{b.high=Math.max(b.high,price);b.low=Math.min(b.low,price);b.close=price;}
  if(!CHART_WINDOW_MODE&&isChartWindowOpen()){scheduleChartWindowTick(price,eventMs);return;}
  if(!tvCandles)return;
  const index=tvBars.length-1;
  const displayBar=tvChartMode==="heikin"?heikinAshiBar(b,index?tvDisplayBars[index-1]:null):{time:b.time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume||0};
  tvDisplayBars[index]=displayBar;tvDisplayBars.length=tvBars.length;
  tvCandles.update({time:displayBar.time,open:displayBar.open,high:displayBar.high,low:displayBar.low,close:displayBar.close,volume:Number(displayBar.volume)||0});
  tvVolume.update({time:displayBar.time,value:displayBar.volume,color:displayBar.close>=displayBar.open?"rgba(38,166,154,.55)":"rgba(239,83,80,.55)"});
  if(tvStudies.flowForce&&!tvFlowForce.map.has(b.time))refreshFlowForceNow(); // new candle: ribbon gets its slot in the same frame
  scheduleFlowCandleLabels();
  const d=studyData(tvBars);if(tvStudies.vwap)tvVwap.update(d.vwap[d.vwap.length-1]);if(tvStudies.ema7)tvEma7.update(d.ema7[d.ema7.length-1]);if(tvStudies.ema9)tvEma9.update(d.ema9[d.ema9.length-1]);if(tvStudies.ema21)tvEma21.update(d.ema21[d.ema21.length-1]);if(tvStudies.ema200)tvEma200.update(d.ema200[d.ema200.length-1]);if(tvStudies.bb){tvBbUpper.update(d.bb.upper[d.bb.upper.length-1]);tvBbMiddle.update(d.bb.middle[d.bb.middle.length-1]);tvBbLower.update(d.bb.lower[d.bb.lower.length-1]);}
  refreshSupplyDemandZones();
  // Live mode follows the newest candle. Manual historical inspection is still
  // available by scrolling left after the chart has opened.
  if(CHART_WINDOW_MODE && tvLiveFollow) scrollTradingChartToLatest();
}
function setChartTimeframe(tf,btn){
  const next=Number(tf);if(![1,3,5,15,30,60].includes(next))return;
  tvTimeframe=next;
  document.querySelectorAll("[data-tf]").forEach(b=>b.classList.toggle("on",+b.dataset.tf===next));
  tvLoadedTf=null;
  if(CHART_WINDOW_MODE&&window.opener&&!window.opener.closed){sendChartWindowCommand("timeframe",next);return;}
  loadTradingChart(true);
}
function toggleChartStudy(name,btn){
  if(!(name in tvStudies))return;
  const enabled=!tvStudies[name];
  tvStudies[name]=enabled;
  btn?.classList.toggle("on",enabled);
  btn?.setAttribute("aria-pressed",enabled?"true":"false");
  if(name==="profile"){
    try{localStorage.setItem("options_swift_volume_profile",enabled?"1":"0");}catch(_){}
    // Update and repaint the active canvas immediately. applyTradingChartData can
    // intentionally return early while a detached chart window is open.
    if(tvChart){tvChart.showVolumeProfile=enabled;tvChart.render();}
  }
  if(name==="flowForce")try{localStorage.setItem("options_swift_flow_force",enabled?"1":"0");}catch(_){}
  if(name==="flow"&&tvChart){tvChart._invalidateBounds();tvChart.render();} // add/remove put/call label headroom
  applyTradingChartData(false);
  if(CHART_WINDOW_MODE)sendChartWindowCommand("study",{name,value:enabled});
  else if(isChartWindowOpen())scheduleChartWindowSync(true);
}
function setChartFlowMinPremium(value,silent=false){
  const next=Number(value);if(!FLOW_MARK_PREMIUM_LEVELS.has(next))return;
  chartFlowMinPremium=next;localStorage.setItem("options_swift_chart_flow_min",String(next));
  const select=document.getElementById("tv-flow-premium-select");if(select)select.value=String(next);
  refreshFlowVolumeSeries();scheduleFlowCandleLabels();
  if(!silent){if(CHART_WINDOW_MODE)sendChartWindowCommand("flowPremium",next);else if(isChartWindowOpen())scheduleChartWindowSync(true);}
}
function setStudyColor(name,color,silent=false){tvColors[name]=color;const map={vwap:[tvVwap],ema7:[tvEma7],ema9:[tvEma9],ema21:[tvEma21],ema200:[tvEma200],bb:[tvBbUpper,tvBbMiddle,tvBbLower]};(map[name]||[]).forEach(series=>series?.applyOptions({color}));const dot=document.getElementById("tv-dot-"+name);if(dot)dot.style.background=color;if(CHART_WINDOW_MODE&&!silent)sendChartWindowCommand("color",{name,color});}
let tvLiveFollow=true;
function updateTradingChartLiveFollowButton(){
  const btn=document.getElementById("tv-live-follow-btn");if(!btn)return;
  btn.classList.toggle("on",tvLiveFollow);
  btn.textContent=tvLiveFollow?"● LIVE FOLLOW":"○ RETURN LIVE";
}
function disableTradingChartLiveFollow(){
  if(!tvLiveFollow)return;tvLiveFollow=false;updateTradingChartLiveFollowButton();
}
function enableTradingChartLiveFollow(){
  tvLiveFollow=true;updateTradingChartLiveFollowButton();scrollTradingChartToLatest();
  requestAnimationFrame(scrollTradingChartToLatest);
}
globalThis.optionsSwiftLiveFollowEnabled=()=>tvLiveFollow;
globalThis.disableTradingChartLiveFollow=disableTradingChartLiveFollow;
globalThis.enableTradingChartLiveFollow=enableTradingChartLiveFollow;
function fitTradingChart(){disableTradingChartLiveFollow();tvChart?.timeScale().fitContent();tvVolumeChart?.timeScale().fitContent();scheduleFlowCandleLabels();}
function scrollTradingChartToLatest(){
  if(!tvChart||!tvBars.length)return;
  // Reopen at the newest available candle instead of the previously saved/old viewport.
  // Keep enough recent bars visible for context; older history remains available by scrolling left.
  const visibleBars=Math.max(60,Math.min(180,tvTimeframe<=1?120:90));
  const to=tvBars.length-1,from=Math.max(0,to-visibleBars+1);
  const range={from,to};
  tvChart.timeScale().setVisibleLogicalRange(range);
  tvVolumeChart?.timeScale().setVisibleLogicalRange(range);
  scheduleFlowCandleLabels();
}
async function backfillTradingChartToNow(){
  if(CHART_WINDOW_MODE||!API_KEY)return;
  // A chart load may already be running when the detached window announces READY.
  // Wait for that request to finish first; otherwise the forced backfill used to
  // return immediately and the popup reopened on the stale pre-close candle.
  const waitStarted=Date.now();
  while(tvLoading && Date.now()-waitStarted<15000){
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  tvLoadedTf=null;
  await loadTradingChart(true);
  // A fresh/reopened chart starts in live-follow mode. Manual drag/zoom turns it off.
  tvLiveFollow=true;updateTradingChartLiveFollowButton();
  // Position only AFTER the REST history has been applied. Do it again on the next
  // paint frames because the detached canvas can resize after receiving its snapshot.
  scrollTradingChartToLatest();
  requestAnimationFrame(()=>{
    scrollTradingChartToLatest();
    requestAnimationFrame(scrollTradingChartToLatest);
  });
}
function levelFromText(id){const t=document.getElementById(id)?.textContent||"";const m=t.match(/(\d+(?:\.\d+)?)/);return m?+m[1]:null;}
function refreshChartLevels(){if(!tvCandles)return;tvPriceLines.forEach(l=>{try{tvCandles.removePriceLine(l)}catch(_){}});tvPriceLines=[];if(!tvStudies.levels)return;const levels=[[liveWallLevels.callPremium,"CALL PREMIUM","#22c55e",0],[liveWallLevels.putPremium,"PUT PREMIUM","#ef4444",0],[liveWallLevels.callPressure,"CALL PRESSURE","#86efac",2],[liveWallLevels.putPressure,"PUT PRESSURE","#fca5a5",2],[liveWallLevels.callGex,"CALL GEX","#14b8a6",1],[liveWallLevels.putGex,"PUT GEX","#fb7185",1],[levelFromText("gex-flip"),"GAMMA FLIP","#38bdf8",2]];for(const [price,title,color,lineStyle] of levels){if(!Number.isFinite(+price)||+price<=0)continue;tvPriceLines.push(tvCandles.createPriceLine({price:+price,color,lineWidth:title.includes("PREMIUM")?2:1,lineStyle,axisLabelVisible:true,title}));}}

function isChartWindowOpen(){return !CHART_WINDOW_MODE&&!!chartExternalWindow&&!chartExternalWindow.closed;}
function setDetachedChartState(detached){document.querySelector(".tv-shell")?.classList.toggle("chart-detached",detached);}
function openChartWindow(){
  if(CHART_WINDOW_MODE)return;
  if(isChartWindowOpen()){focusChartWindow();scheduleChartWindowSync(true);return;}
  const url=new URL(location.href);url.searchParams.set("chartWindow","1");url.hash="chart";
  chartExternalWindow=window.open(url.toString(),"optionsSwiftChartWindow","width=1550,height=950,resizable=yes,scrollbars=no");
  if(!chartExternalWindow){const st=document.getElementById("tv-chart-status");if(st){st.textContent="Allow this site to open the chart window";st.classList.add("tv-error");}return;}
  setDetachedChartState(true);chartExternalWindow.focus();
  clearInterval(chartWindowCloseTimer);chartWindowCloseTimer=setInterval(()=>{if(!isChartWindowOpen())restoreEmbeddedChart();},600);
  backfillTradingChartToNow().then(()=>scheduleChartWindowSync(true)).catch(()=>scheduleChartWindowSync(true));
}
function focusChartWindow(){if(isChartWindowOpen())chartExternalWindow.focus();else openChartWindow();}
function closeChartWindow(){if(isChartWindowOpen())chartExternalWindow.close();restoreEmbeddedChart();}
function restoreEmbeddedChart(){
  clearInterval(chartWindowCloseTimer);chartWindowCloseTimer=null;
  clearTimeout(chartWindowSyncTimer);chartWindowSyncTimer=null;
  clearTimeout(chartWindowTickTimer);chartWindowTickTimer=null;chartWindowPendingPrice=null;chartWindowPendingTime=null;
  clearTimeout(chartWindowFlowSyncTimer);chartWindowFlowSyncTimer=null;chartWindowFlowSignature="";
  chartExternalWindow=null;setDetachedChartState(false);
  if(!CHART_WINDOW_MODE){initTradingChart();applyTradingChartData(true);updateTradingChartStatus();}
}
function chartWindowLargeOrders(){
  return getChartFlowOrders().map(o=>{const q=flowOrderQuote(o);return{chartFlowId:o.chartFlowId,expiration:o.expiration,ts:o.ts,firstMs:o.firstMs,side:o.side,size:o.size,prem:o.prem,price:o.price,printCount:o.printCount||1,sym:o.sym,strike:o.strike,execution:o.execution,direction:o.direction,orderType:o.orderType,capturedAt:o.capturedAt,liveBid:q?.bid??null,liveAsk:q?.ask??null,liveTs:q?.ts??null};});
}
function chartWindowFlowDigest(orders){
  const levels=Object.values(liveWallLevels).map(v=>Number.isFinite(+v)?+v:"").join(":");
  const rawHead=tapePrints[0],rawDigest=rawHead?`${tapeTsMs(rawHead.ts)}:${rawHead.side}:${rawHead.size}:${tapePrints.length}`:`empty:${tapePrints.length}`;
  return `${chartFlowMinPremium}|ff${flowForceVersion}|${levels}|${rawDigest}|${orders.length}|${orders.slice(0,32).map(o=>`${o.chartFlowId}:${o.prem}:${o.size}:${o.printCount}:${o.capturedAt}`).join("|")}|q${orders.slice(0,400).reduce((a,o)=>a+(o.liveBid||0)*7+(o.liveAsk||0)*13,0).toFixed(2)}`;
}
function sendChartWindowSnapshot(){
  if(!isChartWindowOpen())return;
  const largeOrders=chartWindowLargeOrders();chartWindowFlowSignature=chartWindowFlowDigest(largeOrders);
  postChartWindowMessage(chartExternalWindow,{type:"OPTIONS_SWIFT_CHART_SNAPSHOT",bars:tvBars,largeOrders,candleContractTotals:serializeCandleContractTotals(),flowForce:serializeFlowForce(),flowForceLen,timeframe:tvTimeframe,chartMode:tvChartMode,chartTheme:tvChartTheme,flowMarkMinPremium:chartFlowMinPremium,studies:{...tvStudies},colors:{...tvColors},liveWallLevels:{...liveWallLevels},gammaFlip:levelFromText("gex-flip"),gammaFlipState:{...gammaFlipState},spyPrice,supplyDemandEnabled:tvSupplyDemandEnabled,supplyDemandSignals:tvSupplyDemandSignals,sdGexContext});
}
function scheduleChartWindowSync(immediate=false){
  if(!isChartWindowOpen())return;
  if(immediate){clearTimeout(chartWindowSyncTimer);chartWindowSyncTimer=null;sendChartWindowSnapshot();return;}
  if(chartWindowSyncTimer)return;chartWindowSyncTimer=setTimeout(()=>{chartWindowSyncTimer=null;sendChartWindowSnapshot();},120);
}
function sendChartWindowTick(){
  if(!isChartWindowOpen()||!Number.isFinite(chartWindowPendingPrice))return;
  const price=chartWindowPendingPrice,eventTimestamp=chartWindowPendingTime;chartWindowPendingPrice=null;chartWindowPendingTime=null;
  postChartWindowMessage(chartExternalWindow,{type:"OPTIONS_SWIFT_CHART_TICK",price,spyPrice,eventTimestamp});
}
function scheduleChartWindowTick(price,eventTimestamp=Date.now()){
  const next=Number(price);if(!isChartWindowOpen()||!Number.isFinite(next))return;
  chartWindowPendingPrice=next;chartWindowPendingTime=tapeTsMs(eventTimestamp)||Date.now();if(chartWindowTickTimer)return;
  chartWindowTickTimer=setTimeout(()=>{chartWindowTickTimer=null;sendChartWindowTick();},80);
}
function sendChartWindowFlowSync(force=false){
  if(!isChartWindowOpen())return;
  const largeOrders=chartWindowLargeOrders(),signature=chartWindowFlowDigest(largeOrders);
  if(!force&&signature===chartWindowFlowSignature)return;
  chartWindowFlowSignature=signature;
  postChartWindowMessage(chartExternalWindow,{type:"OPTIONS_SWIFT_CHART_FLOW_SYNC",largeOrders,candleContractTotals:serializeCandleContractTotals(),flowForce:serializeFlowForce(),flowMarkMinPremium:chartFlowMinPremium,liveWallLevels:{...liveWallLevels}});
}
function scheduleChartWindowFlowSync(force=false){
  scheduleChartFlowBroadcast(force);
  if(!isChartWindowOpen())return;
  if(force){clearTimeout(chartWindowFlowSyncTimer);chartWindowFlowSyncTimer=null;sendChartWindowFlowSync(true);return;}
  if(chartWindowFlowSyncTimer)return;
  chartWindowFlowSyncTimer=setTimeout(()=>{chartWindowFlowSyncTimer=null;sendChartWindowFlowSync(false);},300);
}
function postChartWindowMessage(target,message){
  if(DEMO_MODE) message.demo=true;
  target.postMessage(message,location.origin);
}
function sendChartWindowCommand(command,value){if(CHART_WINDOW_MODE&&window.opener&&!window.opener.closed)postChartWindowMessage(window.opener,{type:"OPTIONS_SWIFT_CHART_COMMAND",command,value});}
function receiveChartWindowSnapshot(data){
  lastOpenerFlowSyncAt=Date.now();
  receiveFlowForce(data.flowForce);
  if(FLOW_FORCE_LENGTHS.includes(+data.flowForceLen)){flowForceLen=+data.flowForceLen;const ffSel=document.getElementById("tv-flowforce-len");if(ffSel)ffSel.value=String(flowForceLen);}
  const shouldFit=!tvBars.length||tvTimeframe!==+data.timeframe;
  tvBars=Array.isArray(data.bars)?data.bars:[];tvTimeframe=+data.timeframe||1;tvLoadedTf=tvTimeframe;tvChartMode=data.chartMode==="heikin"?"heikin":"candles";tvChartTheme=data.chartTheme==="white"?"white":"dark";if(data.sdGexContext)sdGexContext=data.sdGexContext;if(data.gammaFlipState)gammaFlipState=data.gammaFlipState;
  if(FLOW_MARK_PREMIUM_LEVELS.has(+data.flowMarkMinPremium))chartFlowMinPremium=+data.flowMarkMinPremium;
  Object.assign(tvStudies,data.studies||{});Object.assign(tvColors,data.colors||{});liveWallLevels=data.liveWallLevels||liveWallLevels;spyPrice=Number(data.spyPrice)||spyPrice;if(typeof data.supplyDemandEnabled==="boolean")tvSupplyDemandEnabled=data.supplyDemandEnabled;if(Array.isArray(data.supplyDemandSignals))tvSupplyDemandSignals=data.supplyDemandSignals.slice(-40);
  chartFlowOrders=(Array.isArray(data.largeOrders)?data.largeOrders:[]).map(normalizeChartFlowOrder).filter(Boolean);chartFlowArchiveLoaded=true;
  chartFlowVersion++;flowVolumeCache=null; // invalidate flow-mark cache so new orders draw immediately
  receiveCandleContractTotals(data.candleContractTotals);
  tapeGroupedCache=[...chartFlowOrders];tapeGroupedCacheAt=Date.now();tapeGroupedDirty=false;tapePrints=[];
  setChartFlowStorageStatus(`● ${chartFlowOrders.length.toLocaleString()} stored $200K+ order${chartFlowOrders.length===1?"":"s"} · synced from dashboard`,"#34d399");
  document.querySelectorAll("[data-tf]").forEach(b=>b.classList.toggle("on",+b.dataset.tf===tvTimeframe));
  document.querySelectorAll("[id^='tv-'][id$='-btn']").forEach(b=>{const name=b.id.slice(3,-4);if(name in tvStudies){b.classList.toggle("on",!!tvStudies[name]);b.setAttribute("aria-pressed",tvStudies[name]?"true":"false");}});
  for(const [name,color] of Object.entries(tvColors)){const input=document.querySelector(`input[data-onchange*="'${name}'"]`);if(input)input.value=color;setStudyColor(name,color,true);}
  const flip=document.getElementById("gex-flip");if(flip&&Number.isFinite(+data.gammaFlip))flip.textContent=String(data.gammaFlip);renderGammaFlipState();
  const lp=document.getElementById("tv-live-price");if(lp)lp.textContent=spyPrice?`$${spyPrice.toFixed(2)}`:"—";
  const flowSelect=document.getElementById("tv-flow-premium-select");if(flowSelect)flowSelect.value=String(chartFlowMinPremium);
  initTradingChart();setChartBackground(tvChartTheme,true);const sdBtn=document.getElementById("tv-sd-btn");if(sdBtn)sdBtn.classList.toggle("on",tvSupplyDemandEnabled);syncTradingChartModeUI();applyTradingChartData(false);
  // Only follow the newest candle when live-follow is enabled; preserve manual pan.
  if(tvLiveFollow){
    scrollTradingChartToLatest();
    requestAnimationFrame(()=>{if(tvLiveFollow)scrollTradingChartToLatest();});
  }
  updateTradingChartStatus();
}
function receiveChartWindowFlowSync(data){
  lastOpenerFlowSyncAt=Date.now();
  receiveFlowForce(data.flowForce);
  if(FLOW_MARK_PREMIUM_LEVELS.has(+data.flowMarkMinPremium))chartFlowMinPremium=+data.flowMarkMinPremium;
  liveWallLevels=data.liveWallLevels||liveWallLevels;
  chartFlowOrders=(Array.isArray(data.largeOrders)?data.largeOrders:[]).map(normalizeChartFlowOrder).filter(Boolean);chartFlowArchiveLoaded=true;
  chartFlowVersion++;flowVolumeCache=null; // invalidate flow-mark cache so new orders draw immediately
  receiveCandleContractTotals(data.candleContractTotals);
  tapeGroupedCache=[...chartFlowOrders];tapeGroupedCacheAt=Date.now();tapeGroupedDirty=false;tapePrints=[];
  setChartFlowStorageStatus(`● ${chartFlowOrders.length.toLocaleString()} stored $200K+ order${chartFlowOrders.length===1?"":"s"} · synced from dashboard`,"#34d399");
  const flowSelect=document.getElementById("tv-flow-premium-select");if(flowSelect)flowSelect.value=String(chartFlowMinPremium);
  refreshFlowVolumeSeries();refreshFlowForceSeries();scheduleFlowCandleLabels();refreshChartLevels();
}
async function handleChartWindowMessage(event){
  if(event.origin!==location.origin)return;
  const data=event.data||{};
  if(Boolean(data.demo)!==DEMO_MODE)return;
  if(CHART_WINDOW_MODE){
    if(event.source!==window.opener)return;
    if(data.type==="OPTIONS_SWIFT_CHART_SNAPSHOT")receiveChartWindowSnapshot(data);
    else if(data.type==="OPTIONS_SWIFT_CHART_TICK"&&Number.isFinite(+data.price)){spyPrice=Number.isFinite(+data.spyPrice)?+data.spyPrice:+data.price;updateTradingChartTick(+data.price,data.eventTimestamp);}
    else if(data.type==="OPTIONS_SWIFT_CHART_FLOW_SYNC")receiveChartWindowFlowSync(data);
    return;
  }
  if(data.type==="OPTIONS_SWIFT_CHART_READY"&&!isChartWindowOpen()&&event.source&&event.source!==window){
    // Dashboard was reloaded while the chart popup stayed open: re-link to it.
    chartExternalWindow=event.source;setDetachedChartState(true);
    clearInterval(chartWindowCloseTimer);chartWindowCloseTimer=setInterval(()=>{if(!isChartWindowOpen())restoreEmbeddedChart();},600);
  }
  if(event.source!==chartExternalWindow)return;
  if(data.type==="OPTIONS_SWIFT_CHART_READY"){await backfillTradingChartToNow();scheduleChartWindowSync(true);return;}
  if(data.type!=="OPTIONS_SWIFT_CHART_COMMAND")return;
  if(data.command==="timeframe"){tvTimeframe=+data.value||1;tvLoadedTf=null;loadTradingChart(true);}
  else if(data.command==="refresh"){tvLoadedTf=null;loadTradingChart(true);}
  else if(data.command==="mode"){setChartMode(data.value);scheduleChartWindowSync(true);}
  else if(data.command==="study"&&data.value?.name in tvStudies){tvStudies[data.value.name]=!!data.value.value;scheduleChartWindowSync(true);}
  else if(data.command==="supplyDemand"){tvSupplyDemandEnabled=!!data.value;refreshSupplyDemandZones();scheduleChartWindowSync(true);}
  else if(data.command==="flowPremium"&&FLOW_MARK_PREMIUM_LEVELS.has(+data.value)){setChartFlowMinPremium(+data.value,true);scheduleChartWindowSync(true);}
  else if(data.command==="flowForceLen"&&FLOW_FORCE_LENGTHS.includes(+data.value)){setFlowForceLength(+data.value,true);scheduleChartWindowSync(true);}
  else if(data.command==="color"&&data.value?.name in tvColors){tvColors[data.value.name]=data.value.color;scheduleChartWindowSync(true);}
  else if(data.command==="background"){setChartBackground(data.value,true);scheduleChartWindowSync(true);}
}
// ── 200K+ CANDLE FLOW BRIDGE ─────────────────────────────────────────────
// postMessage only works while the dashboard still holds the popup reference.
// If the dashboard reloads, or the chart window is restored/reopened on its own,
// that link is gone and the chart got candles but ZERO flow orders. This channel
// delivers $200K+ grouped orders to every chart window regardless of the link.
const CHART_FLOW_CHANNEL_NAME=dataKey("options-swift-chart-flow-v1");
function broadcastChartFlow(force=false){
  if(CHART_WINDOW_MODE||!chartFlowChannel)return;
  const largeOrders=chartWindowLargeOrders(),sig=chartWindowFlowDigest(largeOrders);
  if(!force&&sig===chartFlowBroadcastSig)return;
  chartFlowBroadcastSig=sig;
  try{chartFlowChannel.postMessage({type:"flow",expiration:getSelectedExpiry(),largeOrders,candleContractTotals:serializeCandleContractTotals(),flowForce:serializeFlowForce(),liveWallLevels:{...liveWallLevels},sentAt:Date.now()});}catch(e){console.warn("Chart flow broadcast skipped",e);}
}
function scheduleChartFlowBroadcast(force=false){
  if(CHART_WINDOW_MODE||!chartFlowChannel)return;
  if(force){clearTimeout(chartFlowBroadcastTimer);chartFlowBroadcastTimer=null;broadcastChartFlow(true);return;}
  if(chartFlowBroadcastTimer)return;
  chartFlowBroadcastTimer=setTimeout(()=>{chartFlowBroadcastTimer=null;broadcastChartFlow(false);},400);
}
function receiveBroadcastChartFlow(m){
  // A live opener link is authoritative; use the channel only when it is silent.
  if(Date.now()-lastOpenerFlowSyncAt<5000)return;
  if(isValidExpiry(m.expiration)&&m.expiration!==getSelectedExpiry()){const inp=document.getElementById("expiry-select");if(inp)inp.value=m.expiration;try{localStorage.setItem(EXPIRY_STORAGE_KEY,m.expiration);}catch(_){}}
  receiveFlowForce(m.flowForce);
  if(m.liveWallLevels)liveWallLevels=m.liveWallLevels;
  chartFlowOrders=(Array.isArray(m.largeOrders)?m.largeOrders:[]).map(normalizeChartFlowOrder).filter(Boolean);chartFlowArchiveLoaded=true;
  chartFlowVersion++;flowVolumeCache=null;
  receiveCandleContractTotals(m.candleContractTotals);
  tapeGroupedCache=[...chartFlowOrders];tapeGroupedCacheAt=Date.now();tapeGroupedDirty=false;tapePrints=[];
  setChartFlowStorageStatus(`● ${chartFlowOrders.length.toLocaleString()} stored $200K+ order${chartFlowOrders.length===1?"":"s"} · synced via channel`,"#34d399");
  refreshFlowVolumeSeries();refreshFlowForceSeries();scheduleFlowCandleLabels();refreshChartLevels();
}
function initChartFlowChannel(){
  if(!("BroadcastChannel" in globalThis))return;
  try{chartFlowChannel=new BroadcastChannel(CHART_FLOW_CHANNEL_NAME);}catch(_){chartFlowChannel=null;return;}
  chartFlowChannel.onmessage=e=>{
    const m=e.data||{};
    if(CHART_WINDOW_MODE){
      if(m.type==="flow")receiveBroadcastChartFlow(m);
      else if(m.type==="dashboard-ready"&&window.opener&&!window.opener.closed){
        try{postChartWindowMessage(window.opener,{type:"OPTIONS_SWIFT_CHART_READY"});}catch(_){}
      }
    }else if(m.type==="hello"){
      scheduleChartFlowBroadcast(true);
    }
  };
  if(CHART_WINDOW_MODE){
    chartFlowChannel.postMessage({type:"hello"});
  }else{
    chartFlowChannel.postMessage({type:"dashboard-ready"});
    setInterval(()=>scheduleChartFlowBroadcast(false),3000); // heartbeat; skipped when unchanged
    setTimeout(()=>scheduleChartFlowBroadcast(true),1500);
  }
}
function requestChartFlowFromDashboard(){
  if(CHART_WINDOW_MODE&&chartFlowChannel){try{chartFlowChannel.postMessage({type:"hello"});}catch(_){}}
}
async function recoverStandaloneChartToNow(reason="reopen"){
  if(!CHART_WINDOW_MODE||!API_KEY)return;
  requestChartFlowFromDashboard();
  const hasOpener=!!(window.opener&&!window.opener.closed);
  if(hasOpener)return; // normal detached mode is synchronized by the dashboard
  const st=document.getElementById("tv-chart-status");
  if(st){st.textContent=`Recovering missing 1m candles (${reason})…`;st.classList.remove("tv-error");}
  try{
    tvLoadedTf=null;
    await loadTradingChart(true); // authoritative Massive 1-minute REST history through now
    tvLiveFollow=true;updateTradingChartLiveFollowButton();
    scrollTradingChartToLatest();
    connectSpyWS();               // resume live SPY ticks after REST history is complete
    startSpyPoll();               // REST price fallback
    clearInterval(chartReconcileTimer);
    chartReconcileTimer=setInterval(reconcileFinalizedTradingCandles,60000);
    setTimeout(reconcileFinalizedTradingCandles,12000);
    if(st){st.classList.remove("tv-error");updateTradingChartStatus();}
  }catch(e){
    if(st){st.textContent=`Chart recovery failed: ${e?.message||e}`;st.classList.add("tv-error");}
  }
}
function initChartWindowMode(){
  document.body.classList.add("chart-window-mode");document.getElementById("main")?.classList.add("on");document.getElementById("tc-chart")?.classList.add("on");
  window.addEventListener("message",handleChartWindowMessage);
  if(window.opener&&!window.opener.closed){
    postChartWindowMessage(window.opener,{type:"OPTIONS_SWIFT_CHART_READY"});
  }else if(API_KEY){
    // A restored/reopened popup has no opener. Make it self-sufficient instead of
    // leaving it frozen on the last candle from the previous browser session.
    recoverStandaloneChartToNow("window reopened");
  }else{
    const st=document.getElementById("tv-chart-status");if(st){st.textContent="API key required to recover missing candles";st.classList.add("tv-error");}
  }
  // Browsers throttle/suspend background tabs. Every return to the chart performs
  // an authoritative REST catch-up first, then live WebSocket continuation.
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)recoverStandaloneChartToNow("tab resumed");});
  window.addEventListener("focus",()=>recoverStandaloneChartToNow("window focused"));
  window.addEventListener("online",()=>recoverStandaloneChartToNow("network restored"));
}

function paintStrikeVolumeChart(){
  if(!chartStrike)return;
  const visible=!document.hidden&&document.getElementById("tc-imbalance")?.classList.contains("on");
  if(!visible){strikeChartNeedsPaint=true;return;}
  chartStrike.resize();
  chartStrike.update("none");
  strikeChartNeedsPaint=false;
}

function renderCharts(calls,puts){
  // The main price chart is powered by real Massive aggregate candles.
  // Keep the call-versus-put strike-volume chart on the Imbalance page.
  const co={responsive:true,maintainAspectRatio:false,animation:false,responsiveAnimationDuration:0,plugins:{legend:{labels:{color:"#b8cad9",font:{family:"Courier New",size:11}}}},
    scales:{x:{ticks:{color:"#9fb4c8",font:{family:"Courier New",size:11,weight:"600"}},grid:{color:"#1a2840"}},
            y:{ticks:{color:"#9fb4c8",font:{family:"Courier New",size:11,weight:"600"}},grid:{color:"#1a2840"}}}};
  // call vs put volume by strike
  const byS={};
  calls.forEach(c=>{const s=c.details?.strike_price;if(!s)return;if(!byS[s])byS[s]={s,cv:0,pv:0};byS[s].cv+=c.day?.volume??0;});
  puts.forEach(c=>{const s=c.details?.strike_price;if(!s)return;if(!byS[s])byS[s]={s,cv:0,pv:0};byS[s].pv+=c.day?.volume??0;});
  const top=Object.values(byS).sort((a,b)=>b.cv+b.pv-a.cv-a.pv).slice(0,16).sort((a,b)=>a.s-b.s);
  const labels=top.map(r=>"$"+r.s),callValues=top.map(r=>r.cv),putValues=top.map(r=>r.pv);
  const signature=JSON.stringify([labels,callValues,putValues]);
  if(chartStrike){
    if(signature===strikeChartSignature)return;
    chartStrike.data.labels=labels;
    chartStrike.data.datasets[0].data=callValues;
    chartStrike.data.datasets[1].data=putValues;
    strikeChartSignature=signature;
    paintStrikeVolumeChart();
    return;
  }
  const canvas=document.getElementById("strike-c");
  if(!canvas||typeof Chart!=="function")return;
  chartStrike=new Chart(canvas.getContext("2d"),{type:"bar",
    data:{labels,datasets:[
      {label:"calls",data:callValues,backgroundColor:"#34d399cc",borderRadius:2},
      {label:"puts",data:putValues,backgroundColor:"#f87171cc",borderRadius:2}
    ]},
    options:{...co,scales:{x:{...co.scales.x,ticks:{...co.scales.x.ticks,color:"#fff"}},y:{...co.scales.y,ticks:{...co.scales.y.ticks,callback:v=>v>=1e3?`${(v/1e3).toFixed(0)}K`:v}}}}});
  strikeChartSignature=signature;
}

// ─── server connection gate ───────────────────────────────────────────────────
function showGate(){
  document.getElementById("key-gate").style.display="flex";
  document.getElementById("main").classList.remove("on");
  document.getElementById("chg-key-btn").style.display="none";
}
function hideGate(){
  document.getElementById("key-gate").style.display="none";
  document.getElementById("main").classList.add("on");
  document.getElementById("chg-key-btn").style.display="none";
}

async function tryConnect(){
  const errEl=document.getElementById("kerr"); errEl.style.display="none";
  const btn=document.getElementById("kbtn"); btn.textContent="CONNECTING…"; btn.disabled=true;
  try{
    API_KEY="server-managed"; MASSIVE_KEY="server-managed";
    hideGate();
    connectSpyWS();
    await fetchAll();
    if(autoRef) arTimer=setInterval(fetchAll,3000);
  }catch(e){errEl.textContent="⚠ "+e.message;errEl.style.display="block";showGate();}
  btn.textContent="RETRY"; btn.disabled=false;
}

// ─── UI controls ──────────────────────────────────────────────────────────────
function switchTab(btn,name){
  document.querySelectorAll(".tc").forEach(e=>e.classList.remove("on"));
  document.getElementById("tc-"+name).classList.add("on");
  document.querySelectorAll(".tabs .btn:not(#ar-btn)").forEach(b=>b.classList.remove("on"));
  btn.classList.add("on");
  if(name==="imbalance")requestAnimationFrame(paintStrikeVolumeChart);
  if(name==="chart"&&!isChartWindowOpen()) setTimeout(()=>{initTradingChart();loadTradingChart(false);scheduleFlowCandleLabels();},30);
}
function setCt(v){
  resetTapePage();
  ctFilter=v;["all","call","put"].forEach(x=>{const e=document.getElementById("ct-"+x);if(e)e.classList.toggle("on",x===v);});renderFlowTape();
}
function setSrt(v){
  resetTapePage();
  sortField=v;
  [["sv","time"],["sp","premium"],["ss","size"],["sw","whale"]].forEach(([id,val])=>{
    const e=document.getElementById(id);if(e)e.classList.toggle("on",val===v);
  });
  renderFlowTape();
}
function setTapeViewMode(value){
  resetTapePage();
  tapeViewMode=value==="raw"?"raw":"grouped";
  localStorage.setItem("tape_view_mode",tapeViewMode);
  const select=document.getElementById("tape-view-mode");
  if(select) select.value=tapeViewMode;
  renderFlowTape();
}

function setTapePremium(value){
  resetTapePage();
  const custom=document.getElementById("tape-premium-custom");
  if(value==="custom"){
    if(custom){custom.style.display="inline-block";custom.focus();}
    const saved=+(localStorage.getItem("tape_premium_custom")||0);
    tapePremiumMin=saved;
  }else{
    if(custom) custom.style.display="none";
    tapePremiumMin=Math.max(0,Number(value)||0);
  }
  localStorage.setItem("tape_premium_min",String(tapePremiumMin));
  renderFlowTape();
}
let tapePremiumInputTimer=null;
function setTapePremiumCustom(value){
  resetTapePage();
  tapePremiumMin=Math.max(0,Number(value)||0);
  localStorage.setItem("tape_premium_custom",String(tapePremiumMin));
  localStorage.setItem("tape_premium_min",String(tapePremiumMin));
  clearTimeout(tapePremiumInputTimer);
  tapePremiumInputTimer=setTimeout(renderFlowTape,250);
}
function initTapePremiumFilter(){
  const mode=document.getElementById("tape-view-mode");
  if(mode) mode.value=tapeViewMode;
  const select=document.getElementById("tape-premium-filter");
  const custom=document.getElementById("tape-premium-custom");
  if(!select) return;
  const presets=[0,50000,100000,200000,300000,500000,1000000];
  if(presets.includes(tapePremiumMin)){
    select.value=String(tapePremiumMin);
    if(custom) custom.style.display="none";
  }else if(tapePremiumMin>0){
    select.value="custom";
    if(custom){custom.style.display="inline-block";custom.value=String(tapePremiumMin);}
  }else select.value="0";
}
function toggleAR(){
  autoRef=!autoRef;const btn=document.getElementById("ar-btn");
  btn.textContent=autoRef?"● LIVE":"○ paused"; btn.classList.toggle("on",autoRef);
  clearInterval(arTimer);
  if(autoRef&&API_KEY){fetchAll();arTimer=setInterval(fetchAll,3000);}
}
function setStatus(t){document.getElementById("status-txt").textContent=t;}
function showErr(m){const e=document.getElementById("errbox");e.textContent="⚠ "+m;e.style.display="block";}

// ═════════════════════════════════════════════════════════════════════════════
// ── MASSIVE.COM OPTIONS WEBSOCKET (real-time trade stream) ───────────────────
// ═════════════════════════════════════════════════════════════════════════════
// Node streams sanitized option trades and NBBO quotes to this page over SSE.

// Build OCC ticker: O:SPY + YYMMDD + C/P + strike*1000 zero-padded to 8
function occTicker(expYMD, type, strike){
  if(!expYMD || !type || strike==null) return null;
  const d = expYMD.replace(/-/g,"").slice(2); // 2025-12-19 → 251219
  const t = type === "call" ? "C" : "P";
  const s = Math.round(strike * 1000).toString().padStart(8, "0");
  return `O:SPY${d}${t}${s}`;
}

// Reverse: parse OCC ticker into fields
function parseOCC(sym){
  const m = /^O:([A-Z]+)(\d{6})([CP])(\d{8})$/.exec(sym||"");
  if(!m) return null;
  return {
    underlying: m[1],
    expiration: `20${m[2].slice(0,2)}-${m[2].slice(2,4)}-${m[2].slice(4,6)}`,
    type: m[3] === "C" ? "call" : "put",
    strike: +m[4] / 1000
  };
}

function updateOptWsBadge(text, bg, color, border){
  const b = document.getElementById("opt-ws-badge");
  if(!b) return;
  if(!MASSIVE_KEY){ b.style.display = "none"; return; }
  b.style.display = "inline-block";
  b.textContent = text;
  b.style.background = bg;
  b.style.color = color;
  b.style.border = "1px solid " + border;
}

function connectMassiveWS(){ connectRealtimeStream(); }

function disconnectMassiveWS(){
  massiveAlive=false;
  massiveSubs.clear();
  optionQuoteMap.clear();
  massiveQuoteCount=0;
  closeRealtimeStream();
  updateOptWsBadge("OPT STREAM OFF", "rgba(167,139,250,.14)", "#a78bfa", "rgba(167,139,250,.3)");
}

function unsubscribeAllMassiveContracts(){
  massiveSubs.clear();
  optionQuoteMap.clear();
  reconnectRealtimeStream();
}

// Node owns and bounds the actual provider subscriptions.
function syncMassiveSubs(){ connectRealtimeStream(); }

function normalizeOptionWsTs(raw){
  // Massive options WebSocket field `t` is Unix milliseconds. tapeTsMs also
  // migrates records saved by older builds in seconds, microseconds, or ns.
  const ts=tapeTsMs(raw??Date.now());
  return Number.isFinite(ts)&&ts>0?Math.round(ts):Date.now();
}

function handleMassiveQuote(msg){
  const parsed=parseOCC(msg.sym);
  if(!parsed || parsed.expiration!==getSelectedExpiry()) return;
  const bid = +(msg.bp ?? 0);
  const ask = +(msg.ap ?? 0);
  if(bid < 0 || ask <= 0 || ask < bid) return;
  const q = {
    bid, ask,
    bidSize:+(msg.bs??0),
    askSize:+(msg.as??0),
    ts:normalizeOptionWsTs(msg.t)
  };
  const history = optionQuoteMap.get(msg.sym) || [];
  history.push(q);
  history.sort((a,b)=>a.ts-b.ts);
  optionQuoteMap.set(msg.sym,history.slice(-30));
  massiveQuoteCount++;
  // Quotes arrive far more often than trades. Batch live MARK/P&L refreshes so both
  // Flow Tape panels update continuously without forcing a layout on every quote.
  if(!pressureQuoteRenderTimer && document.getElementById("tc-flow")?.classList.contains("on")){
    pressureQuoteRenderTimer=setTimeout(()=>{
      pressureQuoteRenderTimer=null;
      if(document.getElementById("tc-flow")?.classList.contains("on")){
        renderPressureTape(true);
        renderFlowTape();
      }
    },500);
  }
}

function classifyOrderPressure(sym,type,price,tradeTs,conditions){
  const conds = (Array.isArray(conditions)?conditions:[]).map(Number).filter(Number.isFinite);
  if(conds.some(c=>CANCELED_OPTION_CONDITIONS.has(c))) return {skip:true};

  const isLate = conds.some(c=>LATE_OPTION_CONDITIONS.has(c));
  const isMultiLeg = conds.some(c=>MULTILEG_OPTION_CONDITIONS.has(c));
  const isISO = conds.includes(219);
  const history = optionQuoteMap.get(sym) || [];
  const quote = [...history].reverse().find(q=>q.ts<=tradeTs);

  if(isMultiLeg) return {direction:"UNCLEAR",execution:"MULTI-LEG",quality:"MULTI-LEG",bid:quote?.bid,ask:quote?.ask};
  if(isLate) return {direction:"UNCLEAR",execution:"LATE PRINT",quality:"LATE",bid:quote?.bid,ask:quote?.ask};
  if(!quote) return {direction:"UNCLEAR",execution:"NO NBBO",quality:"NO LIVE NBBO",bid:null,ask:null};

  const quoteAgeMs = tradeTs-quote.ts;
  if(quoteAgeMs>30000) return {direction:"UNCLEAR",execution:"STALE NBBO",quality:"STALE QUOTE",bid:quote.bid,ask:quote.ask};

  const spread = Math.max(0,quote.ask-quote.bid);
  const tolerance = Math.max(0.01,spread*0.08);
  let execution = "MID / UNCLEAR";
  if(price >= quote.ask-tolerance) execution = "ASK BUY";
  else if(price <= quote.bid+tolerance) execution = "BID SELL";

  let direction = "UNCLEAR";
  if(execution==="ASK BUY") direction = type==="call"?"BULLISH":"BEARISH";
  else if(execution==="BID SELL") direction = type==="call"?"BEARISH":"BULLISH";

  return {
    direction,execution,
    quality:isISO?"ISO":"LIVE NBBO",
    bid:quote.bid,ask:quote.ask
  };
}

// Handle incoming options trade event
function handleMassiveTrade(msg){
  const parsed = parseOCC(msg.sym);
  if(!parsed || parsed.expiration!==getSelectedExpiry()) return;
  const { strike, type } = parsed;
  const price = +(msg.p ?? 0);
  const size  = +(msg.s ?? msg.q ?? 1);
  if(price <= 0) return;
  const prem  = price * size * 100;
  const ts = normalizeOptionWsTs(msg.t ?? msg.sip_timestamp);
  const conditions = Array.isArray(msg.c) ? msg.c : [];

  // Massive's sequence is unique per contract. Include it so separate prints
  // sharing one millisecond are preserved instead of being collapsed.
  const exchange = msg.x ?? msg.exchange ?? null;
  const tradeKey = `${msg.sym}:${exchange??"no-exchange"}:${msg.q??"no-seq"}:${ts}:${price}:${size}`;
  if(seenOptionTradeKeys.has(tradeKey)) return;
  seenOptionTradeKeys.add(tradeKey);
  seenOptionTradeQueue.push(tradeKey);
  if(seenOptionTradeQueue.length>5000){
    const old = seenOptionTradeQueue.shift();
    seenOptionTradeKeys.delete(old);
  }

  // Enrich with IV/delta from latest chain snapshot if we have it
  const c = chain.find(x => x.details?.strike_price === strike && x.details?.contract_type === type);

  const cls = classifyOrderPressure(msg.sym,type,price,ts,conditions);
  lastOptionTradeTs=Date.now();
  if(!cls.skip){
    recordCandleContracts(ts,type,size,prem);
    flowForceRecord(ts,prem,c?.greeks?.delta,cls.direction,"live");
  }
  tapePrints.unshift({
    sym: msg.sym,
    ts, side: type, strike, price, size, prem,
    iv:    c?.implied_volatility,
    delta: c?.greeks?.delta,
    conditions,
    execution: cls.skip ? "UNCLEAR" : cls.execution,
    direction: cls.skip ? "UNCLEAR" : cls.direction,
    bid: cls.skip ? null : cls.bid,
    ask: cls.skip ? null : cls.ask,
    exchange,
    isNew: true,
    source: "ws"
  });
  tapePrints = tapePrints.slice(0, TAPE_RAW_MAX);
  tapeGroupedDirty=true;
  scheduleTapePersist();
  scheduleChartFlowArchive();

  if(!cls.skip){
    addPressurePrint({
      id:tradeKey,sym:msg.sym,ts,expiration:parsed.expiration,side:type,strike,price,size,prem,conditions,
      direction:cls.direction,
      execution:cls.execution,
      quality:cls.quality,
      bid:cls.bid,
      ask:cls.ask
    },{broadcast:true,persist:true});
  }
  massiveTradeCount++;
  scheduleTapeRender();
}

// Throttle renders: bursts of ticks shouldn't trigger 100 layouts/sec
function scheduleTapeRender(){
  if(tapeRenderTimer) return;
  tapeRenderTimer = setTimeout(() => {
    tapeRenderTimer = null;
    // Only re-render if the flow tape tab is visible (cheap guard)
    if(document.getElementById("tc-flow")?.classList.contains("on")){
      renderFlowTape();
    } else {
      // still update the print count even if tab hidden
      const rct = document.getElementById("rct");
      if(rct) rct.textContent = tapePrints.length + " prints";
    }
    renderPressureTape();
    updatePremiumWallDisplays();
    // Refresh the chart directly from the new streaming print. Persistence runs
    // separately and must never delay a live label or flow-volume bar.
    if(tvChart || isChartWindowOpen()){
      refreshFlowVolumeSeries();
      scheduleFlowCandleLabels();
    }
  }, 100);
}

// ── WS range filter UI ────────────────────────────────────────────────────────
function setWsRange(v){
  const n = Math.min(200,Math.max(0,+v||0));
  wsRangeDollars = n;
  localStorage.setItem("ws_range_dollars", String(n));
  const inp = document.getElementById("ws-range-input");
  const allBtn = document.getElementById("ws-range-all");
  if(n === 0){
    if(inp) inp.value = "";
    if(allBtn) allBtn.classList.add("on");
  } else {
    if(inp && +inp.value !== n) inp.value = n;
    if(allBtn) allBtn.classList.remove("on");
  }
  reconnectRealtimeStream();
}

// ── WS debug console ──────────────────────────────────────────────────────────
function toggleWsDebug(){
  wsDebugOn = !wsDebugOn;
  const panel = document.getElementById("ws-debug-panel");
  const btn   = document.getElementById("ws-dbg-btn");
  if(panel) panel.style.display = wsDebugOn ? "block" : "none";
  if(btn)   btn.classList.toggle("on", wsDebugOn);
  if(wsDebugOn) renderWsDebug();
}
function clearWsDebug(){
  wsDebugLog = [];
  renderWsDebug();
}
function logWsDebug(msgs){
  const now = `${formatMarketTime(new Date())} ${marketZoneName(new Date())}`;
  msgs.forEach(m => {
    wsDebugLog.unshift({ t: now, m });
  });
  wsDebugLog = wsDebugLog.slice(0, 20);
  renderWsDebug();
}
function renderWsDebug(){
  if(!wsDebugOn) return;
  const el = document.getElementById("ws-debug-log");
  if(!el) return;
  el.replaceChildren();
  if(!wsDebugLog.length){
    const empty=document.createElement("div");empty.style.cssText="color:var(--dim);padding:8px 0";
    empty.textContent="No sanitized frames received yet. Connect to see live messages.";el.appendChild(empty);return;
  }
  for(const {t,m} of wsDebugLog){
    const row=document.createElement("div");row.style.cssText="padding:2px 0;border-bottom:1px solid rgba(26,40,64,.4)";
    const time=document.createElement("span");time.style.color="#4a6080";time.textContent=t;
    const body=document.createElement("span");body.textContent=` ${JSON.stringify(m)}`;
    row.append(time,body);el.appendChild(row);
  }
}

// ─── boot ─────────────────────────────────────────────────────────────────────

// ── SPY price updater (shared by WS and REST poll) ────────────────────────────
function applySpyPrice(newP, source, eventTimestamp=Date.now()){
  if(!newP || newP <= 0) return;
  const prev = spyPrice;
  spyPrice = newP;
  const el = document.getElementById("spy-v"); if(!el) return;
  el.textContent = newP.toFixed(2);
  if(prev && newP !== prev){
    el.style.color = newP > prev ? "var(--green)" : "var(--red)";
    setTimeout(()=>{ el.style.color="var(--bright)"; }, 600);
  } else { el.style.color = "var(--bright)"; }
  if(spyPrevClose){
    const chg = ((newP - spyPrevClose)/spyPrevClose*100).toFixed(2);
    const ce = document.getElementById("spy-c");
    ce.textContent = `${+chg>=0?"▲":"▼"} ${Math.abs(chg)}%`;
    ce.style.color = +chg>=0 ? "var(--green)" : "var(--red)";
  }
  const srcEl = document.getElementById("spy-src");
  if(srcEl){
    if(source === "demo" && DEMO_MODE){
      srcEl.textContent = "synthetic stock feed";
      srcEl.style.color = "var(--accent)";
    } else if(source === "ws"){
      srcEl.textContent = "⚡ massive ws live";
      srcEl.style.color = "var(--green)";
    } else if(source === "rest"){
      srcEl.textContent = "⚡ massive REST";
      srcEl.style.color = "var(--accent)";
    } else if(source === "options"){
      // Derived from options chain underlying_asset.price — works with any options plan
      srcEl.textContent = "⚡ options chain (derived)";
      srcEl.style.color = "var(--accent)";
    } else if(source === "eod"){
      srcEl.textContent = "⚠ prev-close EOD";
      srcEl.style.color = "var(--amber)";
    }
  }
  updateTradingChartTick(newP,eventTimestamp);
}

// Reject isolated bad/late stock prints before they can permanently stretch a wick.
// A move outside fresh NBBO or far from the last accepted price must repeat before use.
function validatedSpyTradePrice(rawPrice,ts=Date.now()){
  const price=Number(rawPrice);
  if(!Number.isFinite(price)||price<=0)return null;
  const reference=Number(spyPrice);
  const nbboFresh=Number.isFinite(spyNbbo.bid)&&Number.isFinite(spyNbbo.ask)&&spyNbbo.ask>=spyNbbo.bid&&ts-spyNbbo.ts<4000;
  let suspicious=false;
  if(nbboFresh){
    const spread=Math.max(.01,spyNbbo.ask-spyNbbo.bid);
    const buffer=Math.max(.06,spread*2,((spyNbbo.bid+spyNbbo.ask)/2)*.00012);
    suspicious=price<spyNbbo.bid-buffer||price>spyNbbo.ask+buffer;
  }
  if(Number.isFinite(reference)&&reference>0){
    const jumpLimit=Math.max(.35,reference*.00075);
    if(Math.abs(price-reference)>jumpLimit)suspicious=true;
  }
  if(!suspicious){spyOutlierCandidate=null;return price;}

  const confirmTolerance=Math.max(.08,price*.00015);
  const repeated=spyOutlierCandidate&&ts-spyOutlierCandidate.ts<=1800&&Math.abs(price-spyOutlierCandidate.price)<=confirmTolerance;
  if(repeated){spyOutlierCandidate=null;return price;}
  spyOutlierCandidate={price,ts};
  rejectedSpyTicks++;
  return null;
}

// ── Node SSE — the browser never connects to the market-data provider directly ──
let serverEvents=null,serverStreamUrl="";

function parseServerEvent(event){
  try{return JSON.parse(event.data);}catch(_){return null;}
}

function closeRealtimeStream(){
  if(serverEvents){try{serverEvents.close();}catch(_){} serverEvents=null;}
  serverStreamUrl=""; spyWS=null; massiveWS=null; wsAlive=false; massiveAlive=false;
  stopWsFreshnessWatch();
}

function reconnectRealtimeStream(){
  closeRealtimeStream();
  setTimeout(connectRealtimeStream,0);
}

function connectRealtimeStream(){
  if(!API_KEY)return;
  const expiry=getSelectedExpiry();
  const params=new URLSearchParams({expiry,range:String(wsRangeDollars)});
  const url=`/api/v1/stream?${params}`;
  if(serverEvents&&serverStreamUrl===url&&serverEvents.readyState!==EventSource.CLOSED)return;
  closeRealtimeStream();
  serverStreamUrl=url;
  const setSrc=(txt,col)=>{const el=document.getElementById("spy-src");if(el){el.textContent=txt;el.style.color=col;}};
  setSrc("connecting secure stream…","var(--dim)");
  const stream=DEMO_MODE?openDemoStream(expiry,wsRangeDollars):new EventSource(url,{withCredentials:true});
  serverEvents=stream;spyWS=stream;massiveWS=stream;
  stream.addEventListener("open",()=>{wsAlive=true;if(DEMO_MODE){setSrc("synthetic stock feed","var(--accent)");return;}setSrc("⚡ node stream connected","var(--green)");startWsFreshnessWatch();});
  stream.addEventListener("ready",()=>{wsAlive=true;});
  stream.addEventListener("stock_quote",event=>{
    const data=parseServerEvent(event);if(!data)return;
    const bid=Number(data.bid),ask=Number(data.ask);
    if(Number.isFinite(bid)&&Number.isFinite(ask)&&bid>0&&ask>=bid)spyNbbo={bid,ask,ts:Date.now()};
  });
  stream.addEventListener("stock_tick",event=>{
    const data=parseServerEvent(event);if(!data)return;
    lastSpyTradeTs=Date.now();wsRealtimeConfirmed=true;
    const accepted=validatedSpyTradePrice(data.price,lastSpyTradeTs);
    if(accepted!=null)applySpyPrice(+accepted.toFixed(2),data.source||"ws",data.timestamp);
  });
  stream.addEventListener("option_trade",event=>{const data=parseServerEvent(event);if(data)handleMassiveTrade(data);});
  stream.addEventListener("option_quote_batch",event=>{
    const rows=parseServerEvent(event);if(!Array.isArray(rows))return;
    if(wsDebugOn)logWsDebug(rows.slice(0,20));
    rows.forEach(handleMassiveQuote);
  });
  stream.addEventListener("feed_status",event=>{
    const data=parseServerEvent(event);if(!data)return;
    massiveAlive=DEMO_MODE||data.options==="live"||data.options==="degraded";
    wsAlive=data.stocks==="live"||stream.readyState===EventSource.OPEN;
    if(DEMO_MODE)updateOptWsBadge("MOCK OPTIONS STREAM","rgba(167,139,250,.14)","#a78bfa","rgba(167,139,250,.3)");
    else if(massiveAlive)updateOptWsBadge("⚡ OPT STREAM LIVE","rgba(52,211,153,.14)","#34d399","rgba(52,211,153,.35)");
    else if(data.options==="auth-failed"||data.options==="missing-key")updateOptWsBadge("OPT STREAM UNAVAILABLE","rgba(248,113,113,.12)","#f87171","rgba(248,113,113,.3)");
    else updateOptWsBadge("⟳ OPT STREAM CONNECTING","rgba(251,191,36,.14)","#fbbf24","rgba(251,191,36,.3)");
  });
  stream.addEventListener("resync",()=>fetchAll());
  stream.addEventListener("error",()=>{
    wsAlive=false;massiveAlive=false;setSrc("⟳ stream reconnecting…","var(--amber)");
    updateOptWsBadge("⟳ OPT STREAM RECONNECT","rgba(251,191,36,.14)","#fbbf24","rgba(251,191,36,.3)");
  });
}

function connectSpyWS(){connectRealtimeStream();}
function disconnectSpyWS(){closeRealtimeStream();}

// ── Entitlement watchdog: warn if auth succeeds but no trades arrive during market hours ────
let lastSpyTradeTs   = 0;
let wsRealtimeConfirmed = false;
let wsFreshTimer     = null;
function isMarketHours(){
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US",{timeZone:"America/New_York"}));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if(day === 0 || day === 6) return false;
  const mins = et.getHours()*60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30 to 16:00 ET
}
function startWsFreshnessWatch(){
  stopWsFreshnessWatch();
  lastSpyTradeTs = Date.now();
  wsRealtimeConfirmed = false;
  wsFreshTimer = setInterval(() => {
    if(!wsAlive) return;
    if(wsRealtimeConfirmed) return; // once confirmed, stop warning
    const gap = (Date.now() - lastSpyTradeTs) / 1000;
    if(isMarketHours() && gap > 60){
      // Auth succeeded but no SPY trades in a full minute during market hours — almost certainly a plan issue
      const s = document.getElementById("spy-src");
      if(s){
        s.textContent = "⚠ ws quiet — key may lack real-time stocks";
        s.style.color = "var(--amber)";
      }
    }
  }, 10000);
}
function stopWsFreshnessWatch(){
  if(wsFreshTimer){ clearInterval(wsFreshTimer); wsFreshTimer=null; }
}

// REST refreshes arrive through fetchAll(); Node centralizes and caches them.
let spyPollTimer = null;
async function pollSpyPrice(){return fetchAll();}
function startSpyPoll(){clearInterval(spyPollTimer);}
function stopSpyPoll(){ clearInterval(spyPollTimer); }

setChartFlowMinPremium(chartFlowMinPremium,true);
if(DEMO_MODE){
  initSimOI(simPrice0);
  document.getElementById("sim-bar").style.display="flex";
  document.querySelector(".tv-demo-label").hidden=false;
}
const demoButton=document.getElementById("demo-toggle");
demoButton.textContent=DEMO_MODE?"Demo: ON":"Demo: OFF";
demoButton.setAttribute("aria-pressed",String(DEMO_MODE));
syncTradingChartModeUI();
initChartFlowChannel();
if(CHART_WINDOW_MODE){
  initChartWindowMode();
}else{
  window.addEventListener("message",handleChartWindowMessage);
  initExpirySelector();
  initPressureContinuity();
  loadTape();
  loadFlowForce();
  loadCandleContractTotals();
  startTapeRetentionWatch();
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){expireFlowTape(true);paintStrikeVolumeChart();}});
  window.addEventListener("focus",()=>expireFlowTape(true));
  initChartFlowArchive();
  clearInterval(chartReconcileTimer);
  chartReconcileTimer=setInterval(reconcileFinalizedTradingCandles,60000);
  setTimeout(reconcileFinalizedTradingCandles,15000);

  if(API_KEY){
    hideGate();
    // Initialize WS range UI to stored value
    const rangeInp = document.getElementById("ws-range-input");
    const rangeAll = document.getElementById("ws-range-all");
    if(rangeInp){
      if(wsRangeDollars === 0){ rangeInp.value = ""; if(rangeAll) rangeAll.classList.add("on"); }
      else { rangeInp.value = wsRangeDollars; }
    }
    fetchAll();                                    // full chain on load
    connectSpyWS();                                // real-time SPY price via WS
    if(MASSIVE_KEY) connectMassiveWS();            // same Node SSE stream, idempotent
    arTimer=setInterval(fetchAll,3000);             // cached server bootstrap refresh
  }
  const initialTab=location.hash.slice(1);
  const tabButton=[...document.querySelectorAll(".tab-switch-btn")].find(button=>button.dataset.onclick.includes("'"+initialTab+"'"));
  if(tabButton) switchTab(tabButton,initialTab);
  // else: key gate shown by default (display:flex set in CSS)

  document.addEventListener("DOMContentLoaded",()=>{
    initTapePremiumFilter();
    const status=document.getElementById("tape-status-filter"); if(status) status.value=tapeStatusFilter;
    renderFlowTape();
  });
  window.addEventListener("pagehide",()=>{clearInterval(chartReconcileTimer);persistTape();persistChartFlowArchive();persistFlowForce();persistCandleContractTotals();});
  window.addEventListener("beforeunload",persistTape);
}

// Keep the GEX Ratio interval menu synchronized with the saved bucket interval.
document.addEventListener("DOMContentLoaded",()=>{
  const sel=document.getElementById("gex-ratio-interval");
  if(sel) sel.value=String(GEX_RATIO_BUCKET_MS);
});

// ── Premium panel pop-out window ──
// A real <a target="_blank"> link (set below) opens this same app in a
// second live window, pinned to the Premium tab. Using a genuine link
// instead of window.open() avoids popup-blocker issues in Safari/Firefox.
// The new window independently fetches its own data (same as the main
// window) so it stays fully live even after the opener is closed.
const PREMIUM_POPOUT_MODE = new URLSearchParams(location.search).get("popout")==="premium";
let premiumExternalWindow=null;
function premiumPopoutUrl(){
  const params=new URLSearchParams(location.search);
  params.set("popout","premium");
  const url=new URL(location.href);
  url.search=params.toString();
  url.hash="premium";
  return url.toString();
}
function isPremiumWindowOpen(){return !PREMIUM_POPOUT_MODE&&!!premiumExternalWindow&&!premiumExternalWindow.closed;}
function openPremiumWindow(){
  if(PREMIUM_POPOUT_MODE)return;
  try{
    if(isPremiumWindowOpen()){premiumExternalWindow.focus();return;}
    premiumExternalWindow=window.open(premiumPopoutUrl(),"optionsSwiftPremiumWindow","width=1550,height=950,resizable=yes,scrollbars=yes");
    if(!premiumExternalWindow){
      alert("Pop-up blocked. Allow pop-ups for this site, then click PREMIUM again.");
      return;
    }
    premiumExternalWindow.focus();
  }catch(err){
    alert("Couldn't open the pop-out window: "+(err&&err.message?err.message:err));
  }
}
document.addEventListener("DOMContentLoaded",()=>{
  const link=document.getElementById("premium-popout-link");
  if(link&&!PREMIUM_POPOUT_MODE) link.href=premiumPopoutUrl();
  if(!PREMIUM_POPOUT_MODE)return;
  document.body.classList.add("premium-window-mode");
  const btn=document.querySelector('.tabs .btn[data-onclick*="premium"]');
  if(btn) switchTab(btn,"premium");
});


