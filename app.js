/* ============================================================
   REPLAYDESK — prop evaluation simulator
   bar-replay engine + order matching + trailing drawdown rules
   ============================================================ */
'use strict';

/* ---------------- instrument specs ---------------- */
const SPECS = {                                   // round = "psych level" spacing for the sim book
  NQ:  { name:'NQ',  tick:0.25, pv:20,   base:21500, dec:2, round:25 },
  MNQ: { name:'MNQ', tick:0.25, pv:2,    base:21500, dec:2, round:25 },
  ES:  { name:'ES',  tick:0.25, pv:50,   base:6050,  dec:2, round:10 },
  MES: { name:'MES', tick:0.25, pv:5,    base:6050,  dec:2, round:10 },
  CL:  { name:'CL',  tick:0.01, pv:1000, base:74,    dec:2, round:0.5 },
  GC:  { name:'GC',  tick:0.10, pv:100,  base:2650,  dec:1, round:10 },
  BTC: { name:'BTCUSDT', tick:0.10, pv:1, base:65000, dec:1, round:500, binance:'BTCUSDT' },
  ETH: { name:'ETHUSDT', tick:0.01, pv:1, base:3200,  dec:2, round:25,  binance:'ETHUSDT' },
};

const PRESETS = {
  topstep50:  { balance:50000,  target:3000, maxDD:2000, dll:1000, ddMode:'intraday', dllAction:'fail', maxCts:5,  lock:true, minDays:2, consis:50 },
  topstep100: { balance:100000, target:6000, maxDD:3000, dll:2000, ddMode:'intraday', dllAction:'fail', maxCts:10, lock:true, minDays:2, consis:50 },
  topstep150: { balance:150000, target:9000, maxDD:4500, dll:3000, ddMode:'intraday', dllAction:'fail', maxCts:15, lock:true, minDays:2, consis:50 },
  lucid50:    { balance:50000,  target:3000, maxDD:2000, dll:0,    ddMode:'eod',      dllAction:'fail', maxCts:5,  lock:true, minDays:1, consis:0 },
  lucid100:   { balance:100000, target:6000, maxDD:3500, dll:0,    ddMode:'eod',      dllAction:'fail', maxCts:10, lock:true, minDays:1, consis:0 },
};

/* ---------------- utils ---------------- */
const $ = id => document.getElementById(id);
const fmt$ = (v, sign=false) => (sign && v>0?'+':'') + (v<0?'-':'') + '$' + Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});
const fmt$2 = v => (v<0?'-':'') + '$' + Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtPx = p => p.toFixed(SPEC().dec);

const _nyFmt = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const _offCache = new Map();
function nyOffset(tSec){                 // seconds to add to UTC to get NY wall-clock
  const k = Math.floor(tSec/3600);
  if (_offCache.has(k)) return _offCache.get(k);
  const parts = {};
  for (const p of _nyFmt.formatToParts(new Date(tSec*1000))) parts[p.type]=p.value;
  const hr = parts.hour==='24' ? 0 : +parts.hour;
  const wall = Date.UTC(+parts.year, +parts.month-1, +parts.day, hr, +parts.minute, +parts.second)/1000;
  const off = wall - tSec;
  _offCache.set(k, off);
  return off;
}
function dayKey(tSec){                   // CME-style trading day: rolls at 5pm NY (6pm session open belongs to next day)
  const s = tSec + nyOffset(tSec) + 7*3600;
  const d = new Date(s*1000);
  return d.getUTCFullYear()*10000 + (d.getUTCMonth()+1)*100 + d.getUTCDate();
}
function nyClock(tSec){
  const d = new Date((tSec + nyOffset(tSec))*1000);
  const p = n => String(n).padStart(2,'0');
  const days=['SUN','MON','TUE','WED','THU','FRI','SAT'];
  return `${days[d.getUTCDay()]} ${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} NY`;
}
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

let _toastT = null;
function toast(msg, cls=''){
  const el = $('toast');
  el.textContent = msg; el.className = 'toast ' + cls;
  clearTimeout(_toastT);
  _toastT = setTimeout(()=> el.classList.add('hidden'), 2600);
}

/* ---------------- global state ---------------- */
let CFG = null;          // account + instrument config
let SPEC_ = SPECS.NQ;
const SPEC = () => SPEC_;

const S = {              // replay state
  bars: [], idx: 0, sub: 0, price: 0, prevPrice: 0,
  playing: false, speed: 1, tf: 300, acc: 0, timer: null,
  curCandle: null, markers: [],
};

let acct = null;
let pos = { qty:0, avg:0 };
let orders = [];
let nextOrdId = 1;
let openTrade = null;
let chart=null, series=null, volSeries=null, deltaSeries=null, cvdSeries=null;
let lineEntry=null, lineSL=null, lineTP=null;

/* ============================================================
   DATA SOURCES
   ============================================================ */
function genDemo(seed, spec){
  const rnd = mulberry32(seed*7919+1);
  const randn = () => { let u=0,v=0; while(!u)u=rnd(); while(!v)v=rnd(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
  const bars = [];
  let t = Date.UTC(2025,4,5)/1000;                      // Mon May 5 2025 00:00 UTC
  let px = spec.base;
  let drift = 0;
  const end = t + 14*86400;
  while (t < end){
    const dow = new Date(t*1000).getUTCDay();
    if (dow===0 || dow===6){ t += 86400; continue; }    // skip weekends
    const utcH = new Date(t*1000).getUTCHours() + new Date(t*1000).getUTCMinutes()/60;
    // vol shape: hottest 13:30–20:00 UTC (NY cash session)
    let volMul = 0.45;
    if (utcH>=13.5 && utcH<20) volMul = 1.6;
    else if (utcH>=7 && utcH<13.5) volMul = 0.9;
    if (rnd() < 0.002) drift = (rnd()-0.5) * spec.base*0.0002;    // gentle regime shift
    drift *= 0.996;
    const sd = spec.base*0.00033*volMul;
    const c = px + drift + randn()*sd;
    const o = px;
    const wick = Math.abs(randn())*sd*0.7;
    const rt = v => Math.round(v/spec.tick)*spec.tick;
    bars.push({ t, o:rt(o), h:rt(Math.max(o,c)+wick), l:rt(Math.min(o,c)-wick), c:rt(c), v: Math.round(50+rnd()*900*volMul) });
    px = c;
    t += 60;
  }
  return bars;
}

const BINANCE_HOSTS = ['https://api.binance.com', 'https://api.binance.us'];  // .com is geo-blocked in the US
async function fetchBinance(symbol, startMs, days, onProgress){
  const endMs = Math.min(startMs + days*86400000, Date.now());
  let host = null;
  for (const h of BINANCE_HOSTS){
    try{
      const probe = await fetch(`${h}/api/v3/klines?symbol=${symbol}&interval=1m&limit=1`);
      if (probe.ok){ host = h; break; }
    }catch(e){ /* try next host */ }
  }
  if (!host) throw new Error('Could not reach Binance (.com or .us) — check connection, or use Import File instead.');
  const bars = [];
  let cur = startMs;
  const total = Math.max(1, Math.ceil((endMs-startMs)/60000/1000));
  let req = 0;
  while (cur < endMs){
    const url = `${host}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${cur}&endTime=${endMs}&limit=1000`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Binance HTTP '+r.status);
    const rows = await r.json();
    if (!rows.length) break;
    for (const k of rows) bars.push({ t:Math.floor(k[0]/1000), o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] });
    cur = rows[rows.length-1][0] + 60000;
    req++;
    if (onProgress) onProgress(Math.min(99, Math.round(req/total*100)));
    if (rows.length < 1000) break;
  }
  return bars;
}

function parseFile(name, text){
  const bars = [];
  const pushRow = (t,o,h,l,c,v) => {
    if (!isFinite(t)||!isFinite(o)||!isFinite(h)||!isFinite(l)||!isFinite(c)) return;
    if (t > 1e12) t = Math.floor(t/1000);               // ms → s
    bars.push({ t:Math.floor(t), o,h,l,c, v: isFinite(v)?v:0 });
  };
  if (/\.json$/i.test(name) || text.trim().startsWith('[') || text.trim().startsWith('{')){
    let j = JSON.parse(text);
    if (!Array.isArray(j)) j = j.bars || j.data || [];
    for (const r of j){
      if (Array.isArray(r)) pushRow(+r[0], +r[1], +r[2], +r[3], +r[4], +r[5]);
      else pushRow(+(r.t ?? r.time ?? Date.parse(r.time)/1000), +(r.o ?? r.open), +(r.h ?? r.high), +(r.l ?? r.low), +(r.c ?? r.close), +(r.v ?? r.volume));
    }
  } else {
    const lines = text.split(/\r?\n/).filter(l=>l.trim());
    let cols = { t:0,o:1,h:2,l:3,c:4,v:5 };
    let start = 0;
    const head = lines[0].toLowerCase();
    if (/[a-z]/.test(head)){
      const h = head.split(',').map(s=>s.trim().replace(/"/g,''));
      const find = (...names) => { for (const n of names){ const i=h.indexOf(n); if(i>=0) return i; } return -1; };
      cols = { t:find('time','timestamp','date','datetime'), o:find('open','o'), h:find('high','h'), l:find('low','l'), c:find('close','c','last'), v:find('volume','vol','v') };
      if (cols.t<0||cols.o<0) throw new Error('CSV header not recognized — need time,open,high,low,close');
      start = 1;
    }
    for (let i=start;i<lines.length;i++){
      const f = lines[i].split(',').map(s=>s.trim().replace(/"/g,''));
      let t = +f[cols.t];
      if (!isFinite(t)) t = Date.parse(f[cols.t])/1000;
      pushRow(t, +f[cols.o], +f[cols.h], +f[cols.l], +f[cols.c], cols.v>=0?+f[cols.v]:0);
    }
  }
  bars.sort((a,b)=>a.t-b.t);
  // dedupe
  const out=[]; let last=-1;
  for (const b of bars){ if (b.t!==last){ out.push(b); last=b.t; } }
  if (out.length < 200) throw new Error('Parsed only '+out.length+' bars — need 1-minute data, at least a few hours of it.');
  return out;
}

// Thin feeds (binance.us especially) omit zero-trade minutes entirely, which leaves
// holes in the candle stream. Fill short gaps with flat bars at the previous close;
// long gaps (session breaks, weekends) stay as real gaps.
function normalizeBars(bars){
  const out = [bars[0]];
  for (let i=1;i<bars.length;i++){
    const prev = out[out.length-1], b = bars[i];
    const gap = b.t - prev.t;
    if (gap > 60 && gap <= 30*60){
      for (let t=prev.t+60; t<b.t; t+=60) out.push({ t, o:prev.c, h:prev.c, l:prev.c, c:prev.c, v:0 });
    }
    out.push(b);
  }
  return out;
}

/* ============================================================
   CHART
   ============================================================ */
function initChart(){
  const el = $('chart');
  el.innerHTML = '';
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background:{ type:'solid', color:'#07090d' }, textColor:'#6b7688', fontFamily:"'IBM Plex Mono', monospace", fontSize:11 },
    grid: { vertLines:{ color:'#10151d' }, horzLines:{ color:'#10151d' } },
    rightPriceScale: { borderColor:'#1b2330' },
    timeScale: { borderColor:'#1b2330', timeVisible:true, secondsVisible:false, rightOffset:8, barSpacing:7 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal,
      vertLine:{ color:'#3d4657', labelBackgroundColor:'#2a3547' },
      horzLine:{ color:'#3d4657', labelBackgroundColor:'#2a3547' } },
  });
  series = chart.addCandlestickSeries({
    upColor:'#00d68f', downColor:'#ff4d5e', borderUpColor:'#00d68f', borderDownColor:'#ff4d5e',
    wickUpColor:'#00b578', wickDownColor:'#d63d4c',
    priceFormat:{ type:'price', precision:SPEC().dec, minMove:SPEC().tick },
  });
  volSeries = chart.addHistogramSeries({ priceScaleId:'vol', priceFormat:{type:'volume'}, lastValueVisible:false, priceLineVisible:false });
  chart.priceScale('vol').applyOptions({ scaleMargins:{ top:0.88, bottom:0 } });
  deltaSeries = chart.addHistogramSeries({ priceScaleId:'flow', lastValueVisible:false, priceLineVisible:false });
  chart.priceScale('flow').applyOptions({ scaleMargins:{ top:0.74, bottom:0.15 } });
  cvdSeries = chart.addLineSeries({ priceScaleId:'cvd', color:'#4da3ff', lineWidth:1, lastValueVisible:false, priceLineVisible:false, crosshairMarkerVisible:false });
  chart.priceScale('cvd').applyOptions({ scaleMargins:{ top:0.56, bottom:0.32 } });
  chart.timeScale().subscribeVisibleTimeRangeChange(()=>{ if (VIEWS.map || VIEWS.foot) queueBookmap(); });
  // click chart → prefill resting-order price (drag/pan is ignored)
  const wrap = $('chartWrap');
  let _cd = null;
  wrap.onpointerdown = e => { _cd = { x:e.clientX, y:e.clientY, t:performance.now() }; };
  wrap.onpointerup = e => {
    if (!_cd) return;
    const moved = Math.hypot(e.clientX-_cd.x, e.clientY-_cd.y);
    const held = performance.now() - _cd.t;
    _cd = null;
    if (moved > 5 || held > 400) return;                   // that was a pan, not a click
    const rect = wrap.getBoundingClientRect();
    if (e.clientY > rect.bottom - 30 || e.clientX > rect.right - 62) return;   // axis areas
    const px = series.coordinateToPrice(e.clientY - rect.top);
    if (px === null || !isFinite(px)) return;
    $('lmtPrice').value = Math.round(px/SPEC().tick)*SPEC().tick;
    toast(`Order price set: ${fmtPx(+$('lmtPrice').value)} — BUY/SEL LMT/STP to place`);
  };
}

// Intrabar price path: open → first wick → second wick → close, each leg
// interpolated so playback ticks smoothly (13 points/bar) — pure interpolation,
// so order-fill crossings are identical to the 4-point path.
function barPath(b){
  if (b.h === b.l) return [b.o, b.c];
  const legs = b.c >= b.o ? [b.o,b.l,b.h,b.c] : [b.o,b.h,b.l,b.c];
  const pts = [legs[0]];
  for (let i=0;i<3;i++){
    const a=legs[i], z=legs[i+1];
    for (let k=1;k<=4;k++) pts.push(a+(z-a)*k/4);
  }
  return pts;
}

function aggPush(agg, t, o, h, l, c){
  const bt = t - (t % S.tf);
  const last = agg[agg.length-1];
  if (last && last.rawT === bt){
    last.high=Math.max(last.high,h); last.low=Math.min(last.low,l); last.close=c;
  } else {
    agg.push({ rawT:bt, time:bt+nyOffset(bt), open:o, high:h, low:l, close:c });
  }
}

function rebuildChart(){
  FOOT_CACHE.clear();
  ensureFlow(S.idx-1);
  const agg = [];
  const volArr = [], dArr = [], cvdArr = [];
  let curT = null, vSum = 0, dSum = 0;
  const flushFlow = () => {
    if (curT === null) return;
    const cand = agg[agg.length-1];
    const up = cand ? cand.close >= cand.open : true;
    const dt = curT + nyOffset(curT);
    volArr.push({ time:dt, value:vSum, color: up?'rgba(0,214,143,.4)':'rgba(255,77,94,.4)' });
    dArr.push({ time:dt, value:dSum, color: dSum>=0?'rgba(0,214,143,.7)':'rgba(255,77,94,.7)' });
    cvdArr.push({ time:dt, value:FLOW.cvd[Math.min(lastI,FLOW.lastIdx)]||0 });
  };
  let lastI = 0;
  for (let i=0;i<S.idx;i++){
    const b = S.bars[i];
    const bt = b.t - (b.t % S.tf);
    if (bt !== curT){ flushFlow(); curT = bt; vSum = 0; dSum = 0; }
    vSum += b.v; dSum += FLOW.delta[i]||0; lastI = i;
    aggPush(agg, b.t, b.o, b.h, b.l, b.c);
  }
  flushFlow();
  if (S.sub > 0 && S.idx < S.bars.length){
    const b = S.bars[S.idx];
    const pts = barPath(b).slice(0, S.sub);
    aggPush(agg, b.t, pts[0], Math.max(...pts), Math.min(...pts), pts[pts.length-1]);
  }
  series.setData(agg.map(c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close})));
  volSeries.setData(volArr);
  deltaSeries.setData(dArr);
  cvdSeries.setData(cvdArr);
  // seed incremental flow accumulators so live updates continue the last bucket
  S.fcT = curT; S.fcV = vSum; S.fcD = dSum;
  S.chartAgg = agg;
  S.curCandle = agg.length ? agg[agg.length-1] : null;
  applyMarkers();
  chart.timeScale().scrollToRealTime();
  queueBookmap();
}

// per-completed-base-bar updates for volume / delta / CVD
function flowChartUpdate(i){
  const b = S.bars[i];
  const bt = b.t - (b.t % S.tf);
  if (S.fcT !== bt){ S.fcT = bt; S.fcV = 0; S.fcD = 0; }
  S.fcV += b.v; S.fcD += FLOW.delta[i]||0;
  const dt = bt + nyOffset(bt);
  const cand = S.curCandle && S.curCandle.rawT === bt ? S.curCandle : null;
  const up = cand ? cand.close >= cand.open : b.c >= b.o;
  volSeries.update({ time:dt, value:S.fcV, color: up?'rgba(0,214,143,.4)':'rgba(255,77,94,.4)' });
  deltaSeries.update({ time:dt, value:S.fcD, color: S.fcD>=0?'rgba(0,214,143,.7)':'rgba(255,77,94,.7)' });
  cvdSeries.update({ time:dt, value:FLOW.cvd[i]||0 });
}

function chartTick(p, t){
  const bt = t - (t % S.tf);
  let c = S.curCandle;
  if (!c || c.rawT !== bt){
    c = { rawT:bt, time:bt+nyOffset(bt), open:p, high:p, low:p, close:p };
    S.curCandle = c;
    if (S.chartAgg) S.chartAgg.push(c);
  } else {
    c.high=Math.max(c.high,p); c.low=Math.min(c.low,p); c.close=p;
  }
  series.update({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close });
}

function addMarker(side, px, t, tag){
  S.markers.push({ rawT:t, side, px, tag });
  if (S.markers.length > 400) S.markers.shift();
  applyMarkers();
}
function applyMarkers(){
  series.setMarkers(S.markers.map(m=>{
    const bt = m.rawT - (m.rawT % S.tf);
    return {
      time: bt + nyOffset(bt),
      position: m.side>0 ? 'belowBar' : 'aboveBar',
      color: m.side>0 ? '#00d68f' : '#ff4d5e',
      shape: m.side>0 ? 'arrowUp' : 'arrowDown',
      text: (m.tag==='sl'?'SL ':m.tag==='tp'?'TP ':'') + fmtPx(m.px),
      size: 1,
    };
  }));
}

function refreshPriceLines(){
  if (lineEntry){ series.removePriceLine(lineEntry); lineEntry=null; }
  if (lineSL){ series.removePriceLine(lineSL); lineSL=null; }
  if (lineTP){ series.removePriceLine(lineTP); lineTP=null; }
  if (pos.qty !== 0){
    lineEntry = series.createPriceLine({ price:pos.avg, color:'#ffb000', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, title:'ENTRY '+(pos.qty>0?'+':'')+pos.qty });
  }
  for (const o of orders){
    if (o.tag==='sl' && !lineSL) lineSL = series.createPriceLine({ price:o.price, color:'#ff4d5e', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, title:'SL' });
    if (o.tag==='tp' && !lineTP) lineTP = series.createPriceLine({ price:o.price, color:'#00d68f', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, title:'TP' });
  }
}

/* ============================================================
   ORDER FLOW + BOOK SIM (deterministic, past-data only)
   Delta/CVD are derived from real bar volume; the liquidity book
   is synthetic but seeded at trailing swing highs/lows and round
   numbers, so it correlates with structure without peeking ahead.
   ============================================================ */
const VIEWS = { vol:true, flow:true, map:false, foot:false, lvls:false, snd:true };

/* ---------- fill sounds ---------- */
let _ac = null;
function beep(freq, dur=0.07, gain=0.05){
  if (!VIEWS.snd) return;
  try{
    _ac = _ac || new (window.AudioContext||window.webkitAudioContext)();
    if (_ac.state === 'suspended') _ac.resume();
    const o = _ac.createOscillator(), g = _ac.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, _ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, _ac.currentTime + dur);
    o.connect(g); g.connect(_ac.destination);
    o.start(); o.stop(_ac.currentTime + dur);
  }catch(e){}
}
const FLOW = { walls:[], snaps:[], delta:[], cvd:[], pivH:[], pivL:[], lastIdx:-1, tape:[] };

function flowReset(){
  FLOW.walls=[]; FLOW.snaps=[]; FLOW.delta=[]; FLOW.cvd=[];
  FLOW.pivH=[]; FLOW.pivL=[]; FLOW.lastIdx=-1; FLOW.tape=[];
}

function simFlowBar(i){
  const b = S.bars[i], sp = SPEC();
  const rnd = mulberry32(((i+1)*2654435761) % 2147483647);
  // volume delta approximation from close location in range
  const rng = (b.h-b.l) || sp.tick;
  const buyV = b.v*((b.c-b.l)/rng), sellV = b.v*((b.h-b.c)/rng);
  const d = buyV - sellV;              // keep fractional — crypto volume is in coins, not contracts
  FLOW.delta[i] = d;
  FLOW.cvd[i] = (i>0 ? (FLOW.cvd[i-1]||0) : 0) + d;
  // 3-bar fractal pivots (center bar i-3, fully in the past)
  if (i >= 6){
    const m = S.bars[i-3];
    let isH=true, isL=true;
    for (let k=i-6;k<=i;k++){
      if (k===i-3) continue;
      if (S.bars[k].h >= m.h) isH=false;
      if (S.bars[k].l <= m.l) isL=false;
    }
    if (isH){ FLOW.pivH.push(m.h); if (FLOW.pivH.length>12) FLOW.pivH.shift(); }
    if (isL){ FLOW.pivL.push(m.l); if (FLOW.pivL.length>12) FLOW.pivL.shift(); }
  }
  // evolve resting liquidity walls
  for (const w of FLOW.walls){
    w.ttl--;
    w.s *= 0.985 + rnd()*0.035;
    if (Math.abs(b.c - w.p) <= 4*sp.tick && rnd() < 0.05) w.ttl = 0;   // pulled as price approaches (spoof)
  }
  FLOW.walls = FLOW.walls.filter(w => w.ttl>0 && w.s>25);
  if (FLOW.walls.length < 18 && rnd() < 0.35){
    let p;
    const r = rnd();
    if (r < 0.3 && FLOW.pivH.length) p = FLOW.pivH[Math.floor(rnd()*FLOW.pivH.length)];
    else if (r < 0.6 && FLOW.pivL.length) p = FLOW.pivL[Math.floor(rnd()*FLOW.pivL.length)];
    else p = Math.round((b.c + (rnd()-0.5)*sp.round*5) / sp.round) * sp.round;
    p = Math.round(p/sp.tick)*sp.tick;
    if (Math.abs(p-b.c) <= sp.round*6 && Math.abs(p-b.c) > 2*sp.tick)
      FLOW.walls.push({ p, s: 80 + Math.pow(rnd(),2)*650, ttl: 60 + Math.floor(rnd()*420) });
  }
  FLOW.snaps[i] = FLOW.walls.map(w => [w.p, Math.round(w.s)]);
  FLOW.lastIdx = i;
}
function ensureFlow(upto){
  upto = Math.min(upto, S.bars.length-1);
  for (let i=FLOW.lastIdx+1; i<=upto; i++) simFlowBar(i);
}

function tapePrints(p, prev, i, sub){
  const rnd = mulberry32(i*131 + sub*7 + 3);
  const n = rnd() < 0.6 ? 1 : 2;
  for (let k=0;k<n;k++){
    const up = p > prev || (p===prev && rnd()<0.5);
    const size = Math.max(1, Math.round(Math.pow(rnd(),3)*60));
    FLOW.tape.unshift({ p, s:size, up: rnd()<0.82 ? up : !up });
  }
  if (FLOW.tape.length > 30) FLOW.tape.length = 30;
}

/* ---------- ICT levels: prior day H/L + midnight open ---------- */
function levelsReset(){
  S.levels = { curHi:-Infinity, curLo:Infinity, pdh:null, pdl:null, mid:null, nyDate:null, dirty:false };
}
function trackLevels(b){
  const L = S.levels;
  L.curHi = Math.max(L.curHi, b.h);
  L.curLo = Math.min(L.curLo, b.l);
  const d = new Date((b.t + nyOffset(b.t))*1000);
  const nyd = d.getUTCFullYear()*10000 + d.getUTCMonth()*100 + d.getUTCDate();
  if (L.nyDate !== nyd){ L.nyDate = nyd; L.mid = b.o; L.dirty = true; }   // first bar of the NY calendar day = midnight open
}
function rolloverLevels(){
  const L = S.levels;
  if (L.curHi > -Infinity){ L.pdh = L.curHi; L.pdl = L.curLo; }
  L.curHi = -Infinity; L.curLo = Infinity; L.dirty = true;
}
function warmLevels(){
  levelsReset();
  if (!S.bars.length || S.idx===0) return;
  let day = dayKey(S.bars[0].t);
  for (let i=0;i<S.idx;i++){
    const b = S.bars[i];
    const dk = dayKey(b.t);
    if (dk !== day){ day = dk; rolloverLevels(); }
    trackLevels(b);
  }
}
let lineLvls = [];
function refreshLevelLines(){
  for (const l of lineLvls) series.removePriceLine(l);
  lineLvls = [];
  S.levels.dirty = false;
  if (!VIEWS.lvls) return;
  const L = S.levels, LS = LightweightCharts.LineStyle;
  const mk = (price,color,title) => lineLvls.push(series.createPriceLine({price,color,lineWidth:1,lineStyle:LS.LargeDashed,title,axisLabelVisible:true}));
  if (L.pdh !== null) mk(L.pdh, 'rgba(0,214,143,.7)', 'PDH');
  if (L.pdl !== null) mk(L.pdl, 'rgba(255,77,94,.7)', 'PDL');
  if (L.mid !== null) mk(L.mid, 'rgba(77,163,255,.7)', '00:00');
}

/* ---------- liquidation price line ---------- */
let lineLiq = null;
function updateLiqLine(){
  if (pos.qty === 0 || acct.status==='failed'){
    if (lineLiq){ series.removePriceLine(lineLiq); lineLiq = null; }
    return;
  }
  const lp = pos.avg + (acct.mll - acct.balance)/(pos.qty*SPEC().pv);
  if (!lineLiq) lineLiq = series.createPriceLine({ price:lp, color:'#ff4d5e', lineWidth:2, lineStyle:LightweightCharts.LineStyle.SparseDotted, title:'⚠ LIQ', axisLabelVisible:true });
  else lineLiq.applyOptions({ price: lp });
}

/* ---------- footprint (buy/sell volume by price level per bucket) ----------
   Volume is distributed along each base bar's 13-point path — the same path
   the order-fill engine walks — split buy/sell by tick direction. */
const FOOT_CACHE = new Map();
function bucketFootprint(bt){
  const key = S.tf + ':' + bt;
  if (FOOT_CACHE.has(key)) return FOOT_CACHE.get(key);
  const endT = bt + S.tf;
  const tk = SPEC().tick;
  let i0 = idxOfTime(bt);
  if (S.bars[i0] && S.bars[i0].t < bt) i0++;
  let hi = -Infinity, lo = Infinity, iEnd = i0;
  for (let i=i0; i<S.idx && S.bars[i].t < endT; i++){ hi = Math.max(hi, S.bars[i].h); lo = Math.min(lo, S.bars[i].l); iEnd = i+1; }
  if (hi === -Infinity) return null;
  const bin = Math.max(tk, Math.round((hi-lo)/10/tk)*tk || tk);
  const map = new Map();
  for (let k=i0; k<iEnd; k++){
    const b = S.bars[k], pts = barPath(b), vSeg = b.v/Math.max(1, pts.length-1);
    for (let s=1; s<pts.length; s++){
      const lvl = Math.floor((pts[s]-lo)/bin);
      const cur = map.get(lvl) || { buy:0, sell:0 };
      if (pts[s] > pts[s-1]) cur.buy += vSeg;
      else if (pts[s] < pts[s-1]) cur.sell += vSeg;
      else { cur.buy += vSeg/2; cur.sell += vSeg/2; }
      map.set(lvl, cur);
    }
  }
  const res = { bin, levels: [...map.entries()].map(([lvl,v])=>({ p: lo+lvl*bin+bin/2, buy:v.buy, sell:v.sell })) };
  if (iEnd < S.idx) FOOT_CACHE.set(key, res);   // bucket closed → safe to cache
  return res;
}

/* ---------- bookmap heatmap overlay ---------- */
function idxOfTime(t){
  let lo=0, hi=S.bars.length-1;
  while (lo<hi){ const m=(lo+hi+1)>>1; if (S.bars[m].t<=t) lo=m; else hi=m-1; }
  return lo;
}
let _bmQueued = false;
function queueBookmap(){ if (_bmQueued) return; _bmQueued=true; requestAnimationFrame(()=>{ _bmQueued=false; drawBookmap(); }); }
function drawBookmap(){
  const cv = $('bmCanvas'), wrap = $('chartWrap');
  if (!cv || !chart) return;
  const dpr = window.devicePixelRatio||1;
  cv.width = wrap.clientWidth*dpr; cv.height = wrap.clientHeight*dpr;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0,0,cv.width,cv.height);
  if ((!VIEWS.map && !VIEWS.foot) || !S.chartAgg || !S.chartAgg.length) return;
  ensureFlow(S.idx-1);
  const ts = chart.timeScale();
  // derive bar spacing from real candle coordinates (options().barSpacing lags the actual zoom)
  let bs = 7;
  for (let i=S.chartAgg.length-1; i>0; i--){
    const x1 = ts.timeToCoordinate(S.chartAgg[i].time);
    const x0 = ts.timeToCoordinate(S.chartAgg[i-1].time);
    if (x1 !== null && x0 !== null && x1 > x0){ bs = x1 - x0; break; }
  }
  const maxT = S.bars[Math.max(0, Math.min(S.idx, S.bars.length-1))].t;
  if (VIEWS.map){
    for (const c of S.chartAgg){
      const x = ts.timeToCoordinate(c.time);
      if (x === null || x === undefined) continue;
      const lastT = Math.min(c.rawT + S.tf - 60, maxT);
      const bi = Math.min(idxOfTime(lastT), FLOW.lastIdx);
      const snap = FLOW.snaps[bi];
      if (!snap) continue;
      for (const [p,s] of snap){
        const y = series.priceToCoordinate(p);
        if (y === null || y === undefined) continue;
        const a = Math.min(0.5, s/900 + 0.06);
        ctx.fillStyle = `rgba(255,176,0,${a.toFixed(3)})`;
        ctx.fillRect((x-bs/2)*dpr, (y-1.5)*dpr, bs*dpr, 3*dpr);
      }
    }
  }
  if (VIEWS.foot && bs >= 22){                                    // needs zoom to be readable
    const fmtVol = v => v>=100 ? Math.round(v) : v>=10 ? v.toFixed(0) : v.toFixed(1);
    ctx.textAlign = 'center';
    ctx.font = `${9*dpr}px 'IBM Plex Mono', monospace`;
    for (const c of S.chartAgg){
      const x = ts.timeToCoordinate(c.time);
      if (x === null || x === undefined) continue;
      const fp = bucketFootprint(c.rawT);
      if (!fp) continue;
      for (const lv of fp.levels){
        const yT = series.priceToCoordinate(lv.p + fp.bin/2);
        const yB = series.priceToCoordinate(lv.p - fp.bin/2);
        if (yT === null || yB === null) continue;
        const tot = lv.buy + lv.sell;
        if (!tot) continue;
        const imb = (lv.buy - lv.sell)/tot;
        const a = Math.min(0.42, 0.1 + Math.abs(imb)*0.38);
        ctx.fillStyle = imb >= 0 ? `rgba(0,214,143,${a.toFixed(3)})` : `rgba(255,77,94,${a.toFixed(3)})`;
        const h = Math.max(1, (yB-yT)-1);
        ctx.fillRect((x-bs/2+1)*dpr, yT*dpr, (bs-2)*dpr, h*dpr);
        if (bs >= 58 && h >= 9){
          ctx.fillStyle = 'rgba(215,221,232,.9)';
          ctx.fillText(`${fmtVol(lv.sell)}×${fmtVol(lv.buy)}`, x*dpr, (yT+(yB-yT)/2+3.2)*dpr);
        }
      }
    }
  }
}

/* ---------- click-tradeable DOM + tape panel ---------- */
function domDepth(p){
  const tk = SPEC().tick;
  const ti = Math.round(p/tk);
  const rnd = mulberry32(((ti*40503) ^ ((S.idx>>3)*97)) >>> 0);   // stable per tick, drifts slowly with time
  let sz = 8 + Math.floor(rnd()*55);
  for (const w of FLOW.walls) if (Math.abs(w.p - p) < tk/2) sz += Math.round(w.s);
  return sz;
}
function renderDOM(){
  const tk = SPEC().tick;
  const mid = Math.round(S.price/tk)*tk;
  const N = 7;
  let html = '<div class="dom-head"><span>BUY</span><span>PRICE</span><span>SELL</span></div>';
  for (let i=N;i>=-N;i--){
    const p = +(mid + i*tk).toFixed(8);
    const above = i > 0, below = i < 0;
    const sz = domDepth(p);
    const w = Math.min(100, sz/4);
    const wo = orders.filter(o=>Math.abs(o.price-p) < tk/2);
    const badges = wo.map(o=>`<i class="dom-wo ${o.side>0?'b':'s'}" data-oid="${o.id}" title="click to cancel">${o.side>0?'B':'S'}${o.qty}</i>`).join('');
    html += `<div class="dom-row${i===0?' mid':''}">`
      + `<span class="dom-cell bid" data-px="${p}" title="buy ${fmtPx(p)}">${below?`<i style="width:${w}%"></i><b>${sz}</b>`:''}</span>`
      + `<span class="dom-px">${fmtPx(p)}${badges}</span>`
      + `<span class="dom-cell ask" data-px="${p}" title="sell ${fmtPx(p)}">${above?`<i style="width:${w}%"></i><b>${sz}</b>`:''}</span></div>`;
  }
  $('ladder').innerHTML = html;
}
function renderFlowPanel(){
  renderDOM();
  $('tape').innerHTML = FLOW.tape.slice(0,12).map(pr =>
    `<div class="trow ${pr.up?'up':'dn'}${pr.s>=25?' big':''}"><span>${fmtPx(pr.p)}</span><span>${pr.s}</span></div>`).join('');
  const li = Math.max(0, Math.min(S.idx-1, FLOW.lastIdx));
  const d = FLOW.delta[li]||0, cv = FLOW.cvd[li]||0;
  const fN = v => Math.abs(v) >= 100000 ? (v/1000).toFixed(0)+'k' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  $('cvdBadge').innerHTML = `Δ<b style="color:${d>=0?'var(--green)':'var(--red)'}">${d>=0?'+':''}${fN(d)}</b> · CVD <b style="color:${cv>=0?'var(--green)':'var(--red)'}">${fN(cv)}</b>`;
}

function applyViews(){
  if (volSeries) volSeries.applyOptions({ visible: VIEWS.vol });
  if (deltaSeries) deltaSeries.applyOptions({ visible: VIEWS.flow });
  if (cvdSeries) cvdSeries.applyOptions({ visible: VIEWS.flow });
  $('flowPanel').classList.toggle('hidden', !VIEWS.flow);
  document.querySelectorAll('#viewGroup button').forEach(b=>b.classList.toggle('active', !!VIEWS[b.dataset.view]));
  refreshLevelLines();
  queueBookmap();
  if (VIEWS.flow) renderFlowPanel();
}

/* ============================================================
   ORDERS & POSITION
   ============================================================ */
function equity(){ return acct.balance + (pos.qty!==0 ? (S.price-pos.avg)*pos.qty*SPEC().pv : 0); }

function placeMarket(side, qty, tag='entry'){
  if (!canTrade(side, qty, tag)) return false;
  const px = S.price + side * (CFG.slip||0) * SPEC().tick;   // market orders pay the slippage
  applyFill(side, qty, px, curTime(), tag);
  return px;
}

function placeOrder(side, qty, price, tag='entry', ocoWith=null){
  const type = inferType(side, price, tag);
  const o = { id:nextOrdId++, side, qty, price, type, tag, oco:ocoWith };
  orders.push(o);
  return o;
}
function inferType(side, price, tag){
  if (tag==='sl') return 'stop';
  if (tag==='tp') return 'limit';
  return side>0 ? (price <= S.price ? 'limit':'stop') : (price >= S.price ? 'limit':'stop');
}

function parseHM(s){ const m = /^(\d{1,2}):(\d{2})$/.exec(s||''); return m ? (+m[1])*60 + (+m[2]) : null; }
function inWindow(t){
  if (!CFG.sessOn) return true;
  const a = parseHM(CFG.sessStart), b = parseHM(CFG.sessEnd);
  if (a === null || b === null) return true;
  const d = new Date((t + nyOffset(t))*1000);
  const m = d.getUTCHours()*60 + d.getUTCMinutes();
  return a <= b ? (m >= a && m < b) : (m >= a || m < b);   // handles overnight windows
}

function canTrade(side, qty, tag){
  if (acct.status==='failed'){ toast('Account failed — reset to trade again','err'); return false; }
  if (tag==='entry' && acct.dayLocked){ toast('Daily loss limit hit — locked until next session','err'); return false; }
  if (tag==='entry' && !inWindow(curTime())){ toast(`Outside your trade window (${CFG.sessStart}–${CFG.sessEnd} NY)`,'err'); return false; }
  if (tag==='entry'){
    const projected = Math.abs(pos.qty + side*qty);
    if (projected > CFG.maxCts && Math.abs(pos.qty+side*qty) > Math.abs(pos.qty)){
      toast(`Max ${CFG.maxCts} contracts — order rejected`,'err'); return false;
    }
  }
  return true;
}

function curTime(){
  const i = Math.min(S.idx, S.bars.length-1);
  return S.bars[i].t;
}

function applyFill(side, qty, px, t, tag){
  const fee = qty * CFG.comm;
  acct.balance -= fee;
  if (pos.qty === 0 || Math.sign(pos.qty) === side){
    // open / add
    const newQty = Math.abs(pos.qty) + qty;
    pos.avg = (pos.avg*Math.abs(pos.qty) + px*qty) / newQty;
    pos.qty += side*qty;
    if (!openTrade) openTrade = { attempt:acct.attempt, side, qtyMax:qty, entry:px, entryT:t, realized:0, fees:fee };
    else { openTrade.qtyMax = Math.max(openTrade.qtyMax, Math.abs(pos.qty)); openTrade.entry = pos.avg; openTrade.fees += fee; }
  } else {
    // reduce / flip
    const closeQty = Math.min(qty, Math.abs(pos.qty));
    const pnl = (px - pos.avg) * Math.sign(pos.qty) * closeQty * SPEC().pv;
    acct.balance += pnl;
    if (openTrade){ openTrade.realized += pnl; openTrade.fees += fee; }
    pos.qty += side*closeQty;
    if (pos.qty === 0){
      closeTrade(px, t);
      pos.avg = 0;
      orders = orders.filter(o=>o.tag!=='sl'&&o.tag!=='tp');
    }
    const rem = qty - closeQty;
    if (rem > 0){
      pos.qty = side*rem; pos.avg = px;
      openTrade = { attempt:acct.attempt, side, qtyMax:rem, entry:px, entryT:t, realized:0, fees:0 };
    }
  }
  addMarker(side, px, t, tag);
  beep(tag==='sl' ? 300 : tag==='tp' ? 880 : 560);
  refreshPriceLines();
  renderOrders();
  markDirty();
}

function closeTrade(px, t){
  if (!openTrade) return;
  openTrade.exit = px;
  openTrade.exitT = t;
  acct.trades.push(openTrade);
  openTrade = null;
  renderTrades();
  saveState();
}

// SL/TP inputs are interpreted per the UNIT selector: ticks, points, or absolute price
function bracketPrices(side, entryPx){
  const sp = SPEC();
  const u = $('brUnit').value;
  const slv = +$('slTicks').value || 0;
  const tpv = +$('tpTicks').value || 0;
  let slPx = null, tpPx = null;
  if (u === 'x'){
    if (slv > 0) slPx = slv;
    if (tpv > 0) tpPx = tpv;
    if (slPx !== null && (slPx - entryPx)*side >= 0){ toast('SL price is on the wrong side of entry — not placed','err'); slPx = null; }
    if (tpPx !== null && (tpPx - entryPx)*side <= 0){ toast('TP price is on the wrong side of entry — not placed','err'); tpPx = null; }
  } else {
    const mult = u === 'p' ? 1 : sp.tick;
    if (slv > 0) slPx = entryPx - side*slv*mult;
    if (tpv > 0) tpPx = entryPx + side*tpv*mult;
  }
  const rt = v => v === null ? null : Math.round(v/sp.tick)*sp.tick;
  return { slPx: rt(slPx), tpPx: rt(tpPx) };
}

function attachBrackets(side, qty, entryPx){
  const { slPx, tpPx } = bracketPrices(side, entryPx);
  let slO=null, tpO=null;
  if (slPx !== null) slO = placeOrder(-side, qty, slPx, 'sl');
  if (tpPx !== null) tpO = placeOrder(-side, qty, tpPx, 'tp');
  if (slO && tpO){ slO.oco = tpO.id; tpO.oco = slO.id; }
  if (openTrade && !openTrade.risk && slPx !== null)
    openTrade.risk = Math.abs(entryPx - slPx) * qty * SPEC().pv;   // planned $ risk, exported to Ledger
  refreshPriceLines();
  renderOrders();
}

function processOrders(prev, p, t){
  let guard = 0;
  while (guard++ < 30){
    let best=null, bestPx=0, bestDist=Infinity;
    for (const o of orders){
      const px = triggerPx(o, prev, p);
      if (px===null) continue;
      const d = Math.abs(px - prev);
      if (d < bestDist){ best=o; bestPx=px; bestDist=d; }
    }
    if (!best) break;
    orders = orders.filter(x => x !== best);                       // remove the filled order
    if ((best.tag==='sl' || best.tag==='tp') && best.oco)
      orders = orders.filter(x => x.id !== best.oco);              // cancel OCO sibling
    if (best.type==='stop') bestPx += best.side * (CFG.slip||0) * SPEC().tick;   // stops fill through, limits don't
    if (best.tag==='sl' || best.tag==='tp'){
      // reduce-only
      if (pos.qty===0 || Math.sign(pos.qty)===best.side) continue;
      const q = Math.min(best.qty, Math.abs(pos.qty));
      applyFill(best.side, q, bestPx, t, best.tag);
    } else {
      if (!canTrade(best.side, best.qty, 'entry')) continue;
      applyFill(best.side, best.qty, bestPx, t, 'entry');
      attachBrackets(best.side, best.qty, bestPx);
    }
  }
}

function triggerPx(o, prev, p){
  const up = p >= prev;
  if (o.type==='limit'){
    if (o.side>0){ if (prev<=o.price) return prev; if (!up && p<=o.price) return o.price; }
    else { if (prev>=o.price) return prev; if (up && p>=o.price) return o.price; }
  } else {
    if (o.side>0){ if (prev>=o.price) return prev; if (up && p>=o.price) return o.price; }
    else { if (prev<=o.price) return prev; if (!up && p<=o.price) return o.price; }
  }
  return null;
}

function flattenAll(reasonTag){
  orders = [];
  if (pos.qty !== 0){
    applyFill(pos.qty>0?-1:1, Math.abs(pos.qty), S.price, curTime(), reasonTag||'entry');
  }
  refreshPriceLines();
  renderOrders();
}

/* ============================================================
   ACCOUNT / RULES ENGINE
   ============================================================ */
function initAccount(){
  acct = {
    balance: CFG.balance,
    status: 'active',
    attempt: 1,
    day: null,
    dayStartEq: CFG.balance,
    dayLocked: false,
    eqHigh: CFG.balance,
    mll: CFG.balance - CFG.maxDD,
    trades: [],
    eqSeries: [],
    passedShown: false,
  };
}

function resetAccount(){
  const trades = acct.trades;
  const att = acct.attempt + 1;
  pos = { qty:0, avg:0 }; orders=[]; openTrade=null;
  initAccount();
  acct.trades = trades;
  acct.attempt = att;
  acct.day = S.bars[Math.min(S.idx,S.bars.length-1)] ? dayKey(curTime()) : null;
  $('banner').classList.add('hidden');
  refreshPriceLines(); renderOrders(); renderTrades(); markDirty();
  toast('Account reset — attempt #'+att, 'ok');
  saveState();
}

function computeMLL(){
  let mll = acct.eqHigh - CFG.maxDD;
  if (CFG.ddMode==='static') mll = CFG.balance - CFG.maxDD;
  if (CFG.lock && mll > CFG.balance) mll = CFG.balance;
  acct.mll = mll;
}

function onDayRollover(t){
  const eq = equity();
  if (CFG.ddMode==='eod'){
    acct.eqHigh = Math.max(acct.eqHigh, eq);
    computeMLL();
  }
  acct.dayStartEq = eq;
  acct.dayLocked = false;
  acct.day = dayKey(t);
}

function checkRules(){
  if (acct.status==='failed') return;
  const eq = equity();
  if (CFG.ddMode==='intraday'){
    if (eq > acct.eqHigh){ acct.eqHigh = eq; computeMLL(); }
  }
  if (eq <= acct.mll){
    failAccount(`Equity hit ${fmt$(eq)} — through the trailing liquidation level of ${fmt$(acct.mll)}. The trailing drawdown counts unrealized profit too: it climbed every time your open trade ran up.`);
    return;
  }
  if (CFG.dll > 0){
    const dayPnl = eq - acct.dayStartEq;
    if (dayPnl <= -CFG.dll){
      if (CFG.dllAction==='fail'){
        failAccount(`Daily loss hit ${fmt$(dayPnl)} against a ${fmt$(CFG.dll)} daily loss limit.`);
      } else if (!acct.dayLocked){
        acct.dayLocked = true;
        S.playing && togglePlay();
        flattenAll();
        toast('DAILY LOSS LIMIT — flattened and locked until next session','err');
      }
      return;
    }
  }
  if (!acct.passedShown && acct.balance >= CFG.balance + CFG.target && pos.qty===0){
    const gate = passGate();
    if (gate.ok){
      acct.passedShown = true;
      acct.status = 'passed';
      showBanner('pass', 'EVALUATION PASSED',
        `Realized balance ${fmt$(acct.balance)} — target of ${fmt$(CFG.balance+CFG.target)} cleared in ${acct.trades.filter(tr=>tr.attempt===acct.attempt).length} trades, all gates met. Keep replaying or reset for another run.`);
    } else {
      const note = gate.reasons.join(' · ');
      if (acct.gateNote !== note){
        acct.gateNote = note;
        toast('Target hit, but not passed yet — ' + note, '');
      }
    }
  }
}

// real combines don't pass you on dollars alone
function passGate(){
  const list = acct.trades.filter(t=>t.attempt===acct.attempt);
  const byDay = {}; let tot = 0;
  for (const t of list){ const d = dayKey(t.exitT); const n = t.realized - t.fees; byDay[d] = (byDay[d]||0) + n; tot += n; }
  const days = Object.keys(byDay).length;
  const best = days ? Math.max(...Object.values(byDay)) : 0;
  const reasons = [];
  if ((CFG.minDays||0) > 0 && days < CFG.minDays) reasons.push(`need ${CFG.minDays} trading days (have ${days})`);
  if ((CFG.consis||0) > 0 && tot > 0 && best/tot*100 > CFG.consis) reasons.push(`best day is ${Math.round(best/tot*100)}% of profit (max ${CFG.consis}%)`);
  return { ok: reasons.length === 0, reasons };
}

function failAccount(msg){
  if (S.playing) togglePlay();
  flattenAll();
  acct.status = 'failed';
  showBanner('fail', 'ACCOUNT LIQUIDATED', msg);
  markDirty(); saveState();
}

function showBanner(cls, title, msg){
  $('bannerTitle').textContent = title;
  $('bannerTitle').className = cls;
  $('bannerMsg').textContent = msg;
  $('banner').classList.remove('hidden');
}

/* ============================================================
   REPLAY ENGINE
   ============================================================ */
function advanceSub(){
  if (S.idx >= S.bars.length){
    if (S.playing) togglePlay();
    toast('End of data — start a new session for more','');
    return false;
  }
  const bar = S.bars[S.idx];
  if (S.sub === 0){
    const dk = dayKey(bar.t);
    if (acct.day === null) acct.day = dk;
    else if (dk !== acct.day){ onDayRollover(bar.t); rolloverLevels(); }
    // session-window discipline: flatten when the window closes
    if (CFG.sessOn && CFG.sessFlat && pos.qty !== 0 && !inWindow(bar.t)){
      flattenAll('exit');
      toast('Trade window closed — flattened','');
    }
  }
  const path = barPath(bar);
  const p = path[S.sub];
  const prev = S.price || p;
  S.prevPrice = prev;
  S.price = p;
  processOrders(prev, p, bar.t);
  if (!S.ffwd) chartTick(p, bar.t);
  if (VIEWS.flow && !S.ffwd) tapePrints(p, prev, S.idx, S.sub);
  checkRules();
  S.sub++;
  if (S.sub >= path.length){
    S.sub = 0;
    simFlowBar(S.idx);
    if (!S.ffwd) flowChartUpdate(S.idx);
    trackLevels(bar);
    S.idx++;
    acct.eqSeries.push(Math.round(equity()));
    if (acct.eqSeries.length > 20000) acct.eqSeries = acct.eqSeries.filter((_,i)=>i%2===0);
  }
  return true;
}

// jump to the next session open — orders, rules and day rollovers all still process
function skipToNextOpen(){
  if (S.playing) togglePlay();
  const targetMin = CFG.sessOn ? (parseHM(CFG.sessStart) ?? 570) : 570;   // default 09:30 NY
  const calDate = t => { const d = new Date((t + nyOffset(t))*1000); return d.getUTCFullYear()*10000 + (d.getUTCMonth()+1)*100 + d.getUTCDate(); };
  const t0 = curTime();
  const d0 = new Date((t0 + nyOffset(t0))*1000);
  const m0 = d0.getUTCHours()*60 + d0.getUTCMinutes();
  const startCal = calDate(t0);
  const sameDayOk = m0 < targetMin;                 // still before today's open → stop at today's
  S.ffwd = true;
  let advanced = 0, guard = 0;
  while (guard++ < 80000 && S.idx < S.bars.length){
    const t = S.bars[S.idx].t;
    if (advanced > 0 && S.sub === 0){
      const d = new Date((t + nyOffset(t))*1000);
      const m = d.getUTCHours()*60 + d.getUTCMinutes();
      if (m >= targetMin && m < targetMin + 5 && (sameDayOk || calDate(t) !== startCal)) break;
    }
    if (!advanceSub()) break;
    advanced++;
  }
  S.ffwd = false;
  rebuildChart();
  renderNow();
  toast('Skipped to ' + nyClock(curTime()));
}

function stepBar(){
  const target = S.idx + (S.sub===0 ? 1 : 0);
  let guard = 0;
  while ((S.idx < target || S.sub !== 0) && guard++ < 20){ if(!advanceSub()) break; }
  markDirty(); renderNow();
}

function togglePlay(){
  S.playing = !S.playing;
  const b = $('btnPlay');
  b.textContent = S.playing ? '❚❚ PAUSE' : '▶ PLAY';
  b.classList.toggle('playing', S.playing);
  if (S.playing){
    S.acc = 0;
    let lastT = performance.now();
    S.timer = setInterval(()=>{
      const now = performance.now();
      S.acc += (now-lastT)/1000 * S.speed * 13;  // sub-steps owed (13 path points/bar)
      lastT = now;
      let n = Math.min(400, Math.floor(S.acc));
      S.acc -= n;
      while (n-- > 0){ if (!advanceSub()) break; }
      markDirty();
    }, 50);
  } else {
    clearInterval(S.timer); S.timer=null;
    renderNow();
  }
}

/* ============================================================
   RENDERING
   ============================================================ */
let _dirty = false, _lastRender = 0;
function markDirty(){ _dirty = true; }
setInterval(()=>{ if (_dirty && performance.now()-_lastRender > 90){ renderNow(); } }, 60);

function renderNow(){
  _dirty = false; _lastRender = performance.now();
  const eq = equity();
  const dayPnl = eq - acct.dayStartEq;
  const toMLL = eq - acct.mll;

  $('tEquity').textContent = fmt$(eq);
  $('tEquity').style.color = eq >= CFG.balance ? 'var(--green)' : 'var(--red)';
  $('tDayPnl').textContent = fmt$(dayPnl, true);
  $('tDayPnl').style.color = dayPnl >= 0 ? 'var(--green)' : 'var(--red)';
  $('tToMLL').textContent = fmt$(toMLL);
  $('tToMLL').style.color = toMLL < CFG.maxDD*0.3 ? 'var(--red)' : toMLL < CFG.maxDD*0.6 ? 'var(--amber)' : 'var(--ink)';
  const prog = Math.max(0, Math.min(1, (acct.balance - CFG.balance)/CFG.target));
  $('tTarget').textContent = Math.round(prog*100)+'%';

  const st = $('acctStatus');
  st.textContent = acct.status==='failed' ? 'FAILED' : acct.status==='passed' ? 'PASSED ✓' : acct.dayLocked ? 'DAY LOCKED' : 'ACTIVE';
  st.className = 'acct-status' + (acct.status==='failed' ? ' failed' : acct.status==='passed' ? ' passed' : '');

  if (S.bars.length){
    const inW = inWindow(curTime());
    $('clock').textContent = nyClock(curTime()) + (CFG.sessOn ? (inW ? ' · WINDOW OPEN' : ' · WINDOW CLOSED') : '');
    $('clock').style.color = CFG.sessOn && !inW ? 'var(--amber)' : '';
    $('barCounter').textContent = `${S.idx.toLocaleString()} / ${S.bars.length.toLocaleString()}`;
    $('replayProgressFill').style.width = (S.idx/S.bars.length*100)+'%';
  }
  updateLiqLine();
  if (VIEWS.flow) renderFlowPanel();
  if (VIEWS.map || VIEWS.foot) queueBookmap();
  if (VIEWS.lvls && S.levels && S.levels.dirty) refreshLevelLines();
  $('buyPx').textContent = fmtPx(S.price);
  $('sellPx').textContent = fmtPx(S.price);

  // position card
  const pc = $('posCard');
  if (pos.qty === 0){
    pc.className = 'pos-flat'; pc.textContent = 'FLAT';
    $('btnClose').disabled = true; $('btnReverse').disabled = true;
  } else {
    const upnl = (S.price-pos.avg)*pos.qty*SPEC().pv;
    const rMult = openTrade && openTrade.risk > 0 ? ` (${(upnl/openTrade.risk).toFixed(1)}R)` : '';
    pc.className = 'pos-live';
    pc.innerHTML = `
      <div class="pos-line"><span class="k">SIDE / QTY</span><span class="${pos.qty>0?'pos-qty-long':'pos-qty-short'}">${pos.qty>0?'LONG':'SHORT'} ${Math.abs(pos.qty)}</span></div>
      <div class="pos-line"><span class="k">AVG ENTRY</span><span>${fmtPx(pos.avg)}</span></div>
      <div class="pos-line"><span class="k">OPEN P&L</span><span style="color:${upnl>=0?'var(--green)':'var(--red)'};font-weight:700">${fmt$2(upnl)}${rMult}</span></div>`;
    $('btnClose').disabled = false; $('btnReverse').disabled = false;
  }

  // rules meters
  const realized = acct.balance - CFG.balance;
  $('ruleTargetTxt').textContent = `${fmt$(Math.max(0,realized))} / ${fmt$(CFG.target)}`;
  $('meterTarget').style.width = (prog*100)+'%';

  const ddRoom = Math.max(0, toMLL);
  const ddPct = Math.max(0, Math.min(1, ddRoom/CFG.maxDD));
  $('ruleMLLTxt').textContent = fmt$(ddRoom)+' room';
  const mf = $('meterMLL');
  mf.style.width = (ddPct*100)+'%';
  mf.className = 'fill dd' + (ddPct<0.3?' hot':ddPct<0.6?' warn':'');
  $('mllLevelTxt').textContent = `liquidates at ${fmt$(acct.mll)} · ${CFG.ddMode==='intraday'?'intraday trail':CFG.ddMode==='eod'?'EOD trail':'static'}${CFG.lock&&acct.mll>=CFG.balance?' · LOCKED at start bal':''}`;

  if (CFG.dll > 0){
    const dllRoom = Math.max(0, CFG.dll + Math.min(0, dayPnl));
    const dllPct = dllRoom/CFG.dll;
    $('ruleDLLTxt').textContent = fmt$(dllRoom)+' room';
    const df = $('meterDLL');
    df.style.width = (dllPct*100)+'%';
    df.className = 'fill dd' + (dllPct<0.3?' hot':dllPct<0.6?' warn':'');
  }
  $('attemptTxt').textContent = `ATTEMPT #${acct.attempt} · ${SPEC().name} · $${CFG.comm}/side`;

  updateRiskLine();
}

function bracketDists(){   // SL / TP distance from entry, in price terms
  const sp = SPEC();
  const u = $('brUnit').value;
  const slv = +$('slTicks').value || 0;
  const tpv = +$('tpTicks').value || 0;
  if (u === 'x') return {
    sl: slv > 0 ? Math.abs(S.price - slv) : 0,
    tp: tpv > 0 ? Math.abs(tpv - S.price) : 0,
  };
  const mult = u === 'p' ? 1 : sp.tick;
  return { sl: slv*mult, tp: tpv*mult };
}
function updateRiskLine(){
  const q = Math.max(1, +$('qty').value|0);
  const { sl, tp } = bracketDists();
  const pv = SPEC().pv;
  const tickVal = SPEC().tick * pv;
  $('riskLine').textContent = `RISK ${sl?fmt$(sl*q*pv):'—'} / REWARD ${tp?fmt$(tp*q*pv):'—'}  ·  tick = ${fmt$2(tickVal)}`;
}

function renderOrders(){
  const tb = $('ordersBody');
  tb.innerHTML = '';
  $('ordersEmpty').classList.toggle('hidden', orders.length>0);
  for (const o of orders){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="${o.side>0?'side-b':'side-s'}">${o.side>0?'BUY':'SELL'}</td>
      <td>${o.type.toUpperCase()}</td><td>${o.qty}</td><td>${fmtPx(o.price)}</td>
      <td>${o.tag.toUpperCase()}</td>
      <td><button class="cancel-x" data-oid="${o.id}">✕</button></td>`;
    tb.appendChild(tr);
  }
}

function renderTrades(){
  const tb = $('tradesBody');
  tb.innerHTML = '';
  const list = acct.trades;
  $('tradesEmpty').classList.toggle('hidden', list.length>0);
  const fmtT = t => { const d=new Date((t+nyOffset(t))*1000); return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`; };
  for (let i=list.length-1;i>=0;i--){
    const t = list[i];
    const net = t.realized - t.fees;
    const dur = Math.round((t.exitT-t.entryT)/60);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i+1}${t.attempt>1?` <span style="color:var(--ink-faint)">a${t.attempt}</span>`:''}</td>
      <td class="${t.side>0?'side-b':'side-s'}">${t.side>0?'LONG':'SHORT'}</td>
      <td>${t.qtyMax}</td><td>${fmtPx(t.entry)}</td><td>${fmtPx(t.exit)}</td>
      <td>${fmtT(t.entryT)}</td><td>${dur}m</td>
      <td class="${net>=0?'pnl-pos':'pnl-neg'}">${fmt$2(net)}</td>`;
    tb.appendChild(tr);
  }
}

function renderStats(){
  const list = acct.trades.filter(t=>t.attempt===acct.attempt);
  const g = $('statsGrid');
  const nets = list.map(t=>t.realized-t.fees);
  const wins = nets.filter(n=>n>0), losses = nets.filter(n=>n<=0);
  const gw = wins.reduce((a,b)=>a+b,0), gl = Math.abs(losses.reduce((a,b)=>a+b,0));
  const pf = gl>0 ? (gw/gl) : (gw>0?Infinity:0);
  const exp = nets.length ? nets.reduce((a,b)=>a+b,0)/nets.length : 0;
  // daily pnl for consistency
  const byDay = {};
  for (const t of list){ const d = dayKey(t.exitT); byDay[d]=(byDay[d]||0)+(t.realized-t.fees); }
  const dayVals = Object.values(byDay);
  const totalNet = nets.reduce((a,b)=>a+b,0);
  const bestDay = dayVals.length?Math.max(...dayVals):0;
  const consistency = totalNet>0 && bestDay>0 ? (bestDay/totalNet*100) : 0;
  // avg R (trades with a planned risk), max equity drawdown, worst loss streak
  const rTrades = list.filter(t=>t.risk>0);
  const avgR = rTrades.length ? rTrades.reduce((a,t)=>a+(t.realized-t.fees)/t.risk,0)/rTrades.length : null;
  let maxDD = 0, peak = -Infinity;
  for (const e of acct.eqSeries){ if (e>peak) peak=e; maxDD = Math.max(maxDD, peak-e); }
  let lossStreak = 0, curStreak = 0;
  for (const n of nets){ curStreak = n < 0 ? curStreak+1 : 0; lossStreak = Math.max(lossStreak, curStreak); }
  const card = (k,v,color) => `<div class="stat-card"><div class="k">${k}</div><div class="v" style="${color?`color:${color}`:''}">${v}</div></div>`;
  g.innerHTML =
    card('NET P&L (attempt)', fmt$(totalNet,true), totalNet>=0?'var(--green)':'var(--red)') +
    card('TRADES', list.length) +
    card('WIN RATE', nets.length?Math.round(wins.length/nets.length*100)+'%':'—') +
    card('PROFIT FACTOR', pf===Infinity?'∞':pf.toFixed(2)) +
    card('AVG WIN', wins.length?fmt$(gw/wins.length):'—','var(--green)') +
    card('AVG LOSS', losses.length?fmt$(gl/losses.length):'—','var(--red)') +
    card('EXPECTANCY/TRADE', fmt$(exp,true)) +
    card('AVG R', avgR===null?'—':avgR.toFixed(2)+'R', avgR>0?'var(--green)':avgR===null?'':'var(--red)') +
    card('MAX EQUITY DD', fmt$(maxDD), maxDD>CFG.maxDD*0.7?'var(--red)':'') +
    card('WORST LOSS STREAK', lossStreak||'—') +
    card('FEES PAID', fmt$(list.reduce((a,t)=>a+t.fees,0))) +
    card('BEST DAY % OF NET', totalNet>0?Math.round(consistency)+'%':'—', CFG.consis>0&&consistency>CFG.consis?'var(--amber)':'') +
    card('TRADING DAYS', dayVals.length + ((CFG.minDays||0)>0?` / ${CFG.minDays} min`:''));
  drawEqCurve();
}

/* ---------- session report card: discipline, not just P&L ---------- */
function renderReport(){
  const list = acct.trades.filter(t=>t.attempt===acct.attempt);
  const el = $('reportBody');
  if (!list.length){ el.innerHTML = '<div class="empty">no closed trades this attempt — the report card grades your discipline once you trade</div>'; return; }
  const budget = Math.max(0, +$('riskBudget').value || 0);
  const flagged = list.map((t, i) => {
    const net = t.realized - t.fees;
    const flags = [];
    if (!t.risk) flags.push({ k:'NO STOP', why:'entered without a stop attached' });
    if (CFG.sessOn && !inWindow(t.entryT)) flags.push({ k:'OUT OF WINDOW', why:`entry outside ${CFG.sessStart}–${CFG.sessEnd} NY` });
    if (t.risk && budget > 0 && t.risk > budget*1.25) flags.push({ k:'OVERSIZED', why:`planned ${fmt$(t.risk)} vs ${fmt$(budget)} budget` });
    const prev = list[i-1];
    if (prev && (prev.realized - prev.fees) < 0 && t.entryT - prev.exitT <= 300 && t.entryT >= prev.exitT)
      flags.push({ k:'REVENGE?', why:`re-entered ${Math.max(1,Math.round((t.entryT-prev.exitT)/60))}m after a loss` });
    const planRef = t.risk || budget;
    if (planRef > 0 && net < -planRef*1.5) flags.push({ k:'PAST PLAN', why:`lost ${fmt$(-net)} vs ${fmt$(planRef)} planned` });
    return { t, net, flags };
  });
  // score: start at 100, each flag type costs points
  const COST = { 'NO STOP':6, 'OUT OF WINDOW':8, 'OVERSIZED':4, 'REVENGE?':5, 'PAST PLAN':6 };
  let score = 100;
  const counts = {};
  for (const f of flagged) for (const fl of f.flags){ score -= COST[fl.k]; counts[fl.k] = (counts[fl.k]||0)+1; }
  score = Math.max(0, score);
  const grade = score>=90?'A':score>=80?'B':score>=70?'C':score>=60?'D':'F';
  const gradeColor = score>=80?'var(--green)':score>=60?'var(--amber)':'var(--red)';
  const clean = flagged.filter(f=>!f.flags.length).length;
  const withStop = list.filter(t=>t.risk).length;
  const summary = Object.entries(counts).map(([k,n])=>`<span class="rep-count">${k} ×${n}</span>`).join('') || '<span class="rep-count clean">NO VIOLATIONS</span>';
  const rows = flagged.map((f,i)=>{
    const fl = f.flags.map(x=>`<span class="rep-flag" title="${x.why}">${x.k}</span>`).join('') || '<span class="rep-ok">✓ clean</span>';
    const d = new Date((f.t.entryT+nyOffset(f.t.entryT))*1000);
    const tm = `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    return `<tr><td>${i+1}</td><td>${tm}</td><td class="${f.t.side>0?'side-b':'side-s'}">${f.t.side>0?'L':'S'}${f.t.qtyMax}</td>
      <td class="${f.net>=0?'pnl-pos':'pnl-neg'}">${fmt$2(f.net)}</td><td>${f.t.risk?fmt$(f.t.risk):'—'}</td><td>${fl}</td></tr>`;
  }).join('');
  el.innerHTML = `
    <div class="rep-head">
      <div class="rep-grade" style="color:${gradeColor}">${grade}</div>
      <div class="rep-meta">
        <div>DISCIPLINE SCORE <b>${score}/100</b> · attempt #${acct.attempt}</div>
        <div>${clean}/${list.length} clean trades · ${withStop}/${list.length} with a stop</div>
        <div class="rep-counts">${summary}</div>
      </div>
    </div>
    <table class="tbl"><thead><tr><th>#</th><th>ENTRY (NY)</th><th>POS</th><th>NET</th><th>PLANNED RISK</th><th>FLAGS (hover for why)</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint tiny" style="padding:8px 10px">Same trap every time: the P&L looks like a market problem, the flags say it's a process problem. Grade the process.</p>`;
}

function drawEqCurve(){
  const cv = $('eqCurve');
  const w = cv.width = cv.clientWidth * (window.devicePixelRatio||1);
  const h = cv.height = 90 * (window.devicePixelRatio||1);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0,0,w,h);
  const s = acct.eqSeries;
  if (s.length < 2) return;
  const min = Math.min(...s), max = Math.max(...s);
  const rng = (max-min)||1;
  // start-balance baseline
  const yBase = h - ((CFG.balance-min)/rng)*(h-8) - 4;
  ctx.strokeStyle = 'rgba(255,176,0,.35)'; ctx.setLineDash([4,4]); ctx.beginPath();
  ctx.moveTo(0,yBase); ctx.lineTo(w,yBase); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = '#00d68f'; ctx.lineWidth = 1.5*(window.devicePixelRatio||1);
  ctx.beginPath();
  for (let i=0;i<s.length;i++){
    const x = i/(s.length-1)*w;
    const y = h - ((s[i]-min)/rng)*(h-8) - 4;
    i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  }
  ctx.stroke();
}

/* ============================================================
   PERSISTENCE
   ============================================================ */
const LS_KEY = 'replaydesk_v1';
function saveState(){
  try{
    const data = { cfg:CFG, acct:{...acct, eqSeries:acct.eqSeries.slice(-4000)}, replay:{idx:S.idx, sub:S.sub, tf:S.tf}, markers:S.markers.slice(-400),
      views:{...VIEWS}, open:{ pos:{...pos}, orders:orders.map(o=>({...o})), openTrade: openTrade?{...openTrade}:null, nextOrdId },
      bars:S.bars.map(b=>[b.t,b.o,b.h,b.l,b.c,b.v]) };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  }catch(e){ /* quota — drop bars */
    try{
      const data = { cfg:CFG, acct:{...acct, eqSeries:[]}, replay:{idx:S.idx,sub:S.sub,tf:S.tf}, markers:[], bars:null };
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    }catch(e2){}
  }
}
function loadSaved(){
  try{ return JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){ return null; }
}

/* ============================================================
   SESSION BOOT
   ============================================================ */
function startSession(cfg, bars, resume){
  CFG = cfg;
  SPEC_ = SPECS[cfg.instrument];
  S.bars = normalizeBars(bars);
  S.markers = resume?.markers || [];
  S.tf = resume?.replay?.tf || 300;
  S.playing && togglePlay();
  pos = { qty:0, avg:0 }; orders = []; openTrade = null;

  if (resume){
    acct = resume.acct;
    S.idx = Math.min(resume.replay.idx, S.bars.length-1);
    S.sub = 0;
    if (resume.views) Object.assign(VIEWS, resume.views);
    if (resume.open){                        // restore open position + working orders
      pos = resume.open.pos || { qty:0, avg:0 };
      orders = resume.open.orders || [];
      openTrade = resume.open.openTrade || null;
      nextOrdId = resume.open.nextOrdId || 1;
    }
  } else {
    initAccount();
    S.idx = Math.max(60, Math.floor(S.bars.length * cfg.startPos));
    S.sub = 0;
  }
  S.price = S.bars[Math.max(0,S.idx-1)].c;
  acct.day = dayKey(S.bars[Math.min(S.idx,S.bars.length-1)].t);

  $('setupModal').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('symChip').textContent = SPEC().name;
  document.querySelectorAll('#tfGroup button').forEach(b=>b.classList.toggle('active', +b.dataset.tf===S.tf));

  flowReset();
  ensureFlow(S.idx-1);
  warmLevels();
  initChart();
  rebuildChart();
  applyViews();
  refreshPriceLines();
  renderOrders(); renderTrades(); renderNow();
  saveState();
  toast(resume ? 'Session restored — press SPACE to continue' : 'Evaluation live. SPACE = play/pause, → = step one bar', 'ok');
}

/* ============================================================
   UI WIRING
   ============================================================ */
function wireSetup(){
  // preset autofill
  $('cfgPreset').addEventListener('change', e=>{
    const p = PRESETS[e.target.value];
    if (!p) return;
    $('cfgBalance').value=p.balance; $('cfgTarget').value=p.target; $('cfgMaxDD').value=p.maxDD;
    $('cfgDLL').value=p.dll; $('cfgDDMode').value=p.ddMode; $('cfgDLLAction').value=p.dllAction;
    $('cfgMaxCts').value=p.maxCts; $('cfgDDLock').checked=p.lock;
    $('cfgMinDays').value=p.minDays; $('cfgConsis').value=p.consis;
  });
  // source tabs
  let src = 'demo';
  document.querySelectorAll('.src-tab').forEach(b=>b.addEventListener('click',()=>{
    src = b.dataset.src;
    document.querySelectorAll('.src-tab').forEach(x=>x.classList.toggle('active',x===b));
    document.querySelectorAll('.src-pane').forEach(p=>p.classList.add('hidden'));
    $('srcPane-'+src).classList.remove('hidden');
  }));
  // default binance date = 8 days ago
  const d = new Date(Date.now()-8*86400000);
  $('cfgBnStart').value = d.toISOString().slice(0,10);

  let fileBars = null;
  $('cfgFile').addEventListener('change', async e=>{
    const f = e.target.files[0];
    if (!f) return;
    try{
      fileBars = parseFile(f.name, await f.text());
      $('fileStatus').textContent = `✓ ${fileBars.length.toLocaleString()} bars · ${nyClock(fileBars[0].t)} → ${nyClock(fileBars[fileBars.length-1].t)}`;
      $('fileStatus').style.color = 'var(--green)';
    }catch(err){
      fileBars = null;
      $('fileStatus').textContent = '✕ ' + err.message;
      $('fileStatus').style.color = 'var(--red)';
    }
  });

  // resume chip
  const saved = loadSaved();
  if (saved && saved.bars && saved.acct){
    const btn = document.createElement('button');
    btn.className = 'resume-chip';
    btn.innerHTML = `RESUME LAST SESSION — ${saved.cfg.instrument} · attempt #${saved.acct.attempt} · ${fmt$(saved.acct.balance)}`;
    btn.addEventListener('click', ()=>{
      const bars = saved.bars.map(r=>({t:r[0],o:r[1],h:r[2],l:r[3],c:r[4],v:r[5]}));
      startSession(saved.cfg, bars, saved);
    });
    $('resumeSlot').appendChild(btn);
  }

  $('btnLaunch').addEventListener('click', async ()=>{
    const err = $('setupError'); err.classList.add('hidden');
    const btn = $('btnLaunch');
    const cfg = {
      balance:+$('cfgBalance').value, target:+$('cfgTarget').value, maxDD:+$('cfgMaxDD').value,
      dll:+$('cfgDLL').value, ddMode:$('cfgDDMode').value, dllAction:$('cfgDLLAction').value,
      maxCts:Math.max(1,+$('cfgMaxCts').value), comm:+$('cfgComm').value, lock:$('cfgDDLock').checked,
      instrument:$('cfgInstrument').value, startPos:+$('cfgStartPos').value, src,
      sessOn:$('cfgSessOn').checked, sessFlat:$('cfgSessFlat').checked,
      sessStart:$('cfgSessStart').value||'09:30', sessEnd:$('cfgSessEnd').value||'11:00',
      minDays:Math.max(0,+$('cfgMinDays').value|0), consis:Math.max(0,+$('cfgConsis').value|0),
      slip:Math.max(0,+$('cfgSlip').value|0),
    };
    if (!(cfg.balance>0 && cfg.target>0 && cfg.maxDD>0)){ err.textContent='Balance, target and max drawdown must be positive.'; err.classList.remove('hidden'); return; }
    try{
      btn.disabled = true;
      let bars;
      if (src==='demo'){
        btn.textContent = 'GENERATING…';
        bars = genDemo(+$('cfgSeed').value||7, SPECS[cfg.instrument]);
      } else if (src==='binance'){
        const spec = SPECS[cfg.instrument];
        const sym = spec.binance || 'BTCUSDT';
        if (!spec.binance){ cfg.instrument='BTC'; toast('Binance source → instrument switched to BTCUSDT'); }
        const startMs = new Date($('cfgBnStart').value+'T00:00:00Z').getTime();
        const days = Math.max(1, Math.min(30, +$('cfgBnDays').value||7));
        bars = await fetchBinance(sym, startMs, days, p=>{ btn.textContent = `FETCHING ${p}%…`; });
        if (!bars || bars.length<200) throw new Error('Binance returned too little data for that range.');
      } else {
        if (!fileBars) throw new Error('Pick a data file first.');
        bars = fileBars;
      }
      localStorage.removeItem(LS_KEY);
      startSession(cfg, bars, null);
    }catch(e2){
      err.textContent = e2.message; err.classList.remove('hidden');
    }finally{
      btn.disabled = false; btn.textContent = 'INITIALIZE EVALUATION →';
    }
  });
}

function wireApp(){
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnStep').addEventListener('click', stepBar);
  $('btnSkip').addEventListener('click', skipToNextOpen);
  document.querySelectorAll('#speedGroup button').forEach(b=>b.addEventListener('click',()=>{
    S.speed = +b.dataset.spd;
    document.querySelectorAll('#speedGroup button').forEach(x=>x.classList.toggle('active',x===b));
  }));
  document.querySelectorAll('#tfGroup button').forEach(b=>b.addEventListener('click',()=>{
    S.tf = +b.dataset.tf;
    document.querySelectorAll('#tfGroup button').forEach(x=>x.classList.toggle('active',x===b));
    rebuildChart();
  }));

  document.querySelectorAll('#viewGroup button').forEach(b=>b.addEventListener('click',()=>{
    VIEWS[b.dataset.view] = !VIEWS[b.dataset.view];
    applyViews();
    saveState();
  }));

  $('qtyPlus').addEventListener('click',()=>{ $('qty').value = (+$('qty').value|0)+1; updateRiskLine(); });
  $('qtyMinus').addEventListener('click',()=>{ $('qty').value = Math.max(1,(+$('qty').value|0)-1); updateRiskLine(); });
  ['qty','slTicks','tpTicks','riskBudget'].forEach(id=>$(id).addEventListener('input', updateRiskLine));

  $('brUnit').addEventListener('change', ()=>{
    const u = $('brUnit').value;
    const lbl = u==='t' ? 'ticks' : u==='p' ? 'pts' : 'price';
    document.querySelectorAll('.unitLbl').forEach(el=>el.textContent = lbl);
    const sp = SPEC();
    if (u==='t'){ $('slTicks').value = 40; $('tpTicks').value = 80; }
    else if (u==='p'){ $('slTicks').value = 40*sp.tick; $('tpTicks').value = 80*sp.tick; }
    else { $('slTicks').value = ''; $('tpTicks').value = ''; }
    updateRiskLine();
  });

  $('btnAutoQty').addEventListener('click', ()=>{
    const budget = Math.max(1, +$('riskBudget').value || 0);
    const { sl } = bracketDists();
    if (!(sl > 0)){ toast('Set an SL first — auto-size needs a stop distance','err'); return; }
    const perCt = sl * SPEC().pv;
    const q = Math.max(1, Math.floor(budget / perCt));
    if (q > CFG.maxCts){ $('qty').value = CFG.maxCts; toast(`Capped at max ${CFG.maxCts} contracts (risk math wanted ${q})`,''); }
    else $('qty').value = q;
    updateRiskLine();
    toast(`Sized ${$('qty').value} @ ${fmt$(perCt)}/contract risk`);
  });

  const marketEntry = side => {
    const q = Math.max(1, +$('qty').value|0);
    const px = placeMarket(side, q);
    if (px !== false) attachBrackets(side, q, px);
  };
  $('btnBuy').addEventListener('click', ()=>marketEntry(1));
  $('btnSell').addEventListener('click', ()=>marketEntry(-1));

  const restingEntry = side => {
    const px = +$('lmtPrice').value;
    if (!(px>0)){ toast('Enter a price for the resting order','err'); return; }
    const q = Math.max(1, +$('qty').value|0);
    if (!canTrade(side, q, 'entry')) return;
    placeOrder(side, q, Math.round(px/SPEC().tick)*SPEC().tick, 'entry');
    renderOrders(); markDirty();
    toast(`${side>0?'BUY':'SELL'} ${q} resting @ ${fmtPx(px)}`);
  };
  $('btnLmtBuy').addEventListener('click', ()=>restingEntry(1));
  $('btnLmtSell').addEventListener('click', ()=>restingEntry(-1));

  $('btnClose').addEventListener('click', ()=>{ if(pos.qty!==0) placeMarket(pos.qty>0?-1:1, Math.abs(pos.qty), 'exit'); orders=orders.filter(o=>o.tag==='entry'); refreshPriceLines(); renderOrders(); });
  $('btnReverse').addEventListener('click', ()=>{
    if (pos.qty===0) return;
    const orig = Math.abs(pos.qty);
    const side = pos.qty>0?-1:1;
    orders = orders.filter(o=>o.tag==='entry');    // drop old brackets
    const px = placeMarket(side, orig*2, 'entry');
    if (px !== false) attachBrackets(side, orig, px);
  });
  $('btnFlatten').addEventListener('click', ()=>{ flattenAll('exit'); toast('Flat. All orders cancelled.'); });

  // DOM ladder click-trading: left column buys, right column sells; badges cancel
  $('ladder').addEventListener('click', e=>{
    const woEl = e.target.closest('.dom-wo');
    if (woEl){
      const id = +woEl.dataset.oid;
      const o = orders.find(x=>x.id===id);
      orders = orders.filter(x=>x.id!==id);
      if (o?.oco) orders = orders.filter(x=>x.id!==o.oco);
      refreshPriceLines(); renderOrders(); renderFlowPanel();
      toast('Order cancelled');
      return;
    }
    const cell = e.target.closest('.dom-cell');
    if (!cell) return;
    const side = cell.classList.contains('bid') ? 1 : -1;
    const px = +cell.dataset.px;
    const q = Math.max(1, +$('qty').value|0);
    if (Math.abs(px - S.price) < SPEC().tick*0.75){          // clicking at market = market order
      const fp = placeMarket(side, q);
      if (fp !== false) attachBrackets(side, q, fp);
    } else {
      if (!canTrade(side, q, 'entry')) return;
      const o = placeOrder(side, q, px, 'entry');
      renderOrders(); renderFlowPanel(); markDirty();
      toast(`${side>0?'BUY':'SELL'} ${q} ${o.type.toUpperCase()} @ ${fmtPx(px)}`);
    }
  });

  $('ordersBody').addEventListener('click', e=>{
    const id = +e.target.dataset?.oid;
    if (!id) return;
    const o = orders.find(x=>x.id===id);
    orders = orders.filter(x=>x.id!==id);
    if (o?.oco) orders = orders.filter(x=>x.id!==o.oco);
    refreshPriceLines(); renderOrders();
  });

  document.querySelectorAll('#btabs button').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('#btabs button').forEach(x=>x.classList.toggle('active',x===b));
    document.querySelectorAll('.tabpane').forEach(p=>p.classList.add('hidden'));
    $('tab-'+b.dataset.tab).classList.remove('hidden');
    if (b.dataset.tab==='stats') renderStats();
    if (b.dataset.tab==='report') renderReport();
  }));

  $('btnExport').addEventListener('click', ()=>{
    const rows = [['attempt','side','qty','entry','exit','entry_time_utc','exit_time_utc','gross_pnl','fees','net_pnl']];
    for (const t of acct.trades){
      rows.push([t.attempt, t.side>0?'LONG':'SHORT', t.qtyMax, t.entry, t.exit,
        new Date(t.entryT*1000).toISOString(), new Date(t.exitT*1000).toISOString(),
        t.realized.toFixed(2), t.fees.toFixed(2), (t.realized-t.fees).toFixed(2)]);
    }
    const blob = new Blob([rows.map(r=>r.join(',')).join('\n')], {type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'replaydesk_trades.csv';
    a.click();
  });

  $('btnLedger').addEventListener('click', ()=>{
    if (!acct.trades.length){ toast('No closed trades to export yet','err'); return; }
    const nyDate = t => { const d = new Date((t+nyOffset(t))*1000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; };
    const inst = SPEC().name.replace('USDT','');
    const out = acct.trades.map((t,i)=>({
      id: 'rd' + t.entryT + '_' + i,
      date: nyDate(t.exitT),
      instrument: inst,
      direction: t.side>0 ? 'Long' : 'Short',
      setup: '', grade: '',
      pnl: +(t.realized - t.fees).toFixed(2),
      risk: t.risk ? +t.risk.toFixed(2) : 0,
      emotion: '', conviction: 0, followedPlan: false, inKillzone: false,
      notes: `REPLAYDESK sim (attempt ${t.attempt}): ${t.qtyMax} ${inst} ${fmtPx(t.entry)} → ${fmtPx(t.exit)}, ${Math.round((t.exitT-t.entryT)/60)}m hold`,
    }));
    const blob = new Blob([JSON.stringify(out,null,1)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'replaydesk_for_ledger.json';
    a.click();
    toast('Saved — in Ledger hit Import and pick this file. Heads-up: import REPLACES Ledger\'s trade list.','ok');
  });

  $('btnResetAcct').addEventListener('click', resetAccount);
  $('btnBannerClose').addEventListener('click', ()=>$('banner').classList.add('hidden'));
  $('btnNewSession').addEventListener('click', ()=>{
    if (S.playing) togglePlay();
    saveState();
    location.reload();
  });

  document.addEventListener('keydown', e=>{
    if (['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if ($('app').classList.contains('hidden')) return;
    if (e.code==='Space'){ e.preventDefault(); togglePlay(); }
    else if (e.code==='ArrowRight'){ e.preventDefault(); stepBar(); }
    else if (e.code==='KeyB'){ $('btnBuy').click(); }
    else if (e.code==='KeyS'){ $('btnSell').click(); }
    else if (e.code==='KeyC'){ if (!$('btnClose').disabled) $('btnClose').click(); }
    else if (e.code==='KeyF'){ $('btnFlatten').click(); }
  });

  setInterval(()=>{ if (CFG) saveState(); }, 15000);
}

wireSetup();
wireApp();
