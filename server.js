/**
 * RANGER BPR Forex Signal Bot
 * Deployable on Render, configurable via web UI
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

// =============================================================================
// CONFIGURATION - All adjustable via web UI, persisted in memory
// =============================================================================

let SETTINGS = {
  // Pairs to monitor
  pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USDCAD', 'USDCHF', 'NZD/USD'],
  
  // Timeframes (we fetch 5min, build higher internally)
  primaryTf: '5min',           // Entry confirmation timeframe
  structureTf: '15min',        // For swing/FVG detection (built from 5min)
  
  // API & Polling
  twelveDataKey: process.env.TWELVE_DATA_API_KEY || '',
  pollIntervalMinutes: 15,     // Safe for 800/day with 7 pairs
  staggerMs: 500,            // 0.5s between pair requests (7 pairs = 3.5s, under 8/min)
  
  // Swing detection
  swingLookback: 5,            // Bars each side for swing confirmation
  maxSwingAge: 50,             // How many bars back to look for sweeps
  
  // FVG detection
  maxFvgAge: 30,               // How old can a FVG be to get disrespected
  recencyWindow: 20,           // BPR must form within this many bars after sweep
  minSweepPips: 2.0,           // Minimum sweep beyond swing
  minDisrespectPips: 1.0,      // Must trade through FVG by this much
  
  // Risk management
  maxPipRisk: 50.0,            // Hard cap on stop distance
  minPipRisk: 3.0,             // Minimum realistic stop
  sanitySlPct: 0.05,           // 5% max SL as % of price
  sanityTpPct: 0.15,           // 15% max TP as % of price
  riskReward: 3.0,             // Fixed 1:3 R:R
  
  // Outcome tracking
  maxBarsToResolve: 100,       // How many bars to wait for TP/SL
  pendingExpiryBars: 200,      // Expire pending setups after this many bars
  
  // Display
  dashboardPort: process.env.PORT || 3000
};

// =============================================================================
// STATE
// =============================================================================

const state = {
  candles: {},           // { 'EURUSD_5min': [ {open, high, low, close, timestamp} ] }
  setups: [],            // All detected setups with outcome tracking
  lastPoll: null,
  nextPoll: null,
  apiCallsToday: 0,
  apiCallsThisMinute: [],
  isRunning: false,
  wsClients: new Set()
};

// =============================================================================
// DATA FETCHING WITH RATE LIMIT PROTECTION
// =============================================================================

function parsePair(pair) {
  // Twelve Data format: EUR/USD or EURUSD → EUR/USD
  return pair.includes('/') ? pair : pair.slice(0,3) + '/' + pair.slice(3);
}

function cleanPair(pair) {
  return pair.replace('/', '');
}

async function fetchCandles(pair, interval, outputsize = 500) {
  const symbol = parsePair(pair);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${SETTINGS.twelveDataKey}`;
  
  // Rate limit tracking
  const now = Date.now();
  state.apiCallsThisMinute = state.apiCallsThisMinute.filter(t => now - t < 60000);
  
  if (state.apiCallsThisMinute.length >= 8) {
    throw new Error('Rate limit: 8 requests/minute exceeded');
  }
  if (state.apiCallsToday >= 800) {
    throw new Error('Daily limit: 800 requests exceeded');
  }
  
  try {
    const res = await fetch(url);
    state.apiCallsThisMinute.push(now);
    state.apiCallsToday++;
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    if (data.status === 'error') {
      throw new Error(data.message || 'API error');
    }
    
    // Twelve Data returns newest first, reverse to chronological
    const values = (data.values || []).reverse();
    return values.map(v => ({
      timestamp: new Date(v.datetime),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close)
    }));
  } catch (err) {
    console.error(`Fetch error for ${pair}:`, err.message);
    throw err;
  }
}

// =============================================================================
// TECHNICAL ANALYSIS ENGINE (Translated from tested Python)
// =============================================================================

function detectSwings(candles, lookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    // Must be strictly higher/lower than immediate neighbors
    if (isHigh && candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high) {
      swings.push({ price: candles[i].high, idx: i, isHigh: true, timestamp: candles[i].timestamp });
    }
    if (isLow && candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low) {
      swings.push({ price: candles[i].low, idx: i, isHigh: false, timestamp: candles[i].timestamp });
    }
  }
  return swings;
}

function detectFVGs(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i-2], c3 = candles[i];
    // Bullish FVG: c1.high < c3.low
    if (c1.high < c3.low) {
      fvgs.push({ top: c3.low, bottom: c1.high, direction: 'LONG', startIdx: i-2, endIdx: i, timestamp: c3.timestamp });
    }
    // Bearish FVG: c1.low > c3.high
    if (c1.low > c3.high) {
      fvgs.push({ top: c1.low, bottom: c3.high, direction: 'SHORT', startIdx: i-2, endIdx: i, timestamp: c3.timestamp });
    }
  }
  return fvgs;
}

function isLiquiditySweep(candles, idx, swing, minSweepPips) {
  const sweep = minSweepPips / 10000;
  if (swing.isHigh) {
    return candles[idx].high > swing.price + sweep;
  }
  return candles[idx].low < swing.price - sweep;
}

function isFVGDisrespected(candles, fvg, afterIdx, minDisrespectPips) {
  const disrespect = minDisrespectPips / 10000;
  if (afterIdx >= candles.length) return false;
  for (let i = afterIdx; i < Math.min(afterIdx + 30, candles.length); i++) {
    if (fvg.direction === 'LONG') {
      if (candles[i].low < fvg.bottom - disrespect) return true;
    } else {
      if (candles[i].high > fvg.top + disrespect) return true;
    }
  }
  return false;
}

function fvgOverlaps(a, b) {
  return !(a.top < b.bottom || b.top < a.bottom);
}

function findRangerSetups(candles, pair) {
  const setups = [];
  const swings = detectSwings(candles, SETTINGS.swingLookback);
  const fvgs = detectFVGs(candles);
  
  const fvgsByEnd = {};
  fvgs.forEach(f => {
    if (!fvgsByEnd[f.endIdx]) fvgsByEnd[f.endIdx] = [];
    fvgsByEnd[f.endIdx].push(f);
  });
  
  const foundBPRs = new Set();
  
  for (let i = SETTINGS.swingLookback + 5; i < candles.length; i++) {
    const recentSwings = swings.filter(s => s.idx < i && (i - s.idx) <= SETTINGS.maxSwingAge);
    
    for (const swing of recentSwings) {
      if (!isLiquiditySweep(candles, i, swing, SETTINGS.minSweepPips)) continue;
      
      const setupDir = swing.isHigh ? 'SHORT' : 'LONG';
      
      const candidateFVGs = fvgs.filter(f => 
        f.endIdx < i && 
        f.direction !== setupDir && 
        (i - f.endIdx) <= SETTINGS.maxFvgAge
      );
      
      for (const oppFVG of candidateFVGs) {
        if (!isFVGDisrespected(candles, oppFVG, i, SETTINGS.minDisrespectPips)) continue;
        
        for (let j = i; j < Math.min(i + SETTINGS.recencyWindow, candles.length); j++) {
          if (!fvgsByEnd[j]) continue;
          
          for (const newFVG of fvgsByEnd[j]) {
            if (newFVG.direction !== setupDir) continue;
            if (!fvgOverlaps(newFVG, oppFVG)) continue;
            
            const overlapTop = Math.min(newFVG.top, oppFVG.top);
            const overlapBottom = Math.max(newFVG.bottom, oppFVG.bottom);
            if (overlapTop - overlapBottom < 0.0001) continue;
            
            const bprKey = `${newFVG.top.toFixed(5)}_${newFVG.bottom.toFixed(5)}`;
            if (foundBPRs.has(bprKey)) continue;
            
            for (let k = j; k < Math.min(j + 10, candles.length); k++) {
              if (!fvgsByEnd[k]) continue;
              
              for (const entryFVG of fvgsByEnd[k]) {
                if (entryFVG.direction !== setupDir) continue;
                if (!fvgOverlaps(entryFVG, newFVG)) continue;
                
                const eTop = Math.min(entryFVG.top, newFVG.top);
                const eBot = Math.max(entryFVG.bottom, newFVG.bottom);
                if (eTop - eBot < 0.0001) continue;
                
                let entryPrice, stopLoss, takeProfit, risk;
                if (setupDir === 'LONG') {
                  entryPrice = entryFVG.top;
                  stopLoss = swing.price - (SETTINGS.minSweepPips / 10000);
                  risk = entryPrice - stopLoss;
                  takeProfit = entryPrice + (risk * SETTINGS.riskReward);
                } else {
                  entryPrice = entryFVG.bottom;
                  stopLoss = swing.price + (SETTINGS.minSweepPips / 10000);
                  risk = stopLoss - entryPrice;
                  takeProfit = entryPrice - (risk * SETTINGS.riskReward);
                }
                
                const priceRef = candles[k].close;
                const slPct = Math.abs(entryPrice - stopLoss) / priceRef;
                const tpPct = Math.abs(takeProfit - entryPrice) / priceRef;
                const riskPips = risk * 10000;
                
                if (slPct > SETTINGS.sanitySlPct || tpPct > SETTINGS.sanityTpPct) continue;
                if (riskPips > SETTINGS.maxPipRisk || riskPips < SETTINGS.minPipRisk) continue;
                if (risk <= 0) continue;
                
                setups.push({
                  id: Math.random().toString(36).substr(2, 8).toUpperCase(),
                  pair: cleanPair(pair),
                  direction: setupDir,
                  entryPrice: Math.round(entryPrice * 100000) / 100000,
                  stopLoss: Math.round(stopLoss * 100000) / 100000,
                  takeProfit: Math.round(takeProfit * 100000) / 100000,
                  riskPips: Math.round(riskPips * 10) / 10,
                  rewardPips: Math.round(riskPips * SETTINGS.riskReward * 10) / 10,
                  rr: SETTINGS.riskReward,
                  swingPrice: Math.round(swing.price * 100000) / 100000,
                  swingIdx: swing.idx,
                  sweepIdx: i,
                  entryIdx: k,
                  detectedAt: new Date().toISOString(),
                  status: 'PENDING',
                  resolvedAt: null,
                  outcome: null,
                  maxFavorablePips: 0,
                  maxAdversePips: 0,
                  barsSinceEntry: 0
                });
                
                foundBPRs.add(bprKey);
                break;
              }
              if (foundBPRs.has(bprKey)) break;
            }
            if (foundBPRs.has(bprKey)) break;
          }
        }
      }
    }
  }
  
  return setups;
}

// =============================================================================
// OUTCOME TRACKING
// =============================================================================

function updateSetupOutcomes(pair, newCandles) {
  const pairKey = cleanPair(pair);
  
  state.setups.forEach(setup => {
    if (setup.pair !== pairKey) return;
    if (setup.status !== 'PENDING') return;
    
    // Find candles after entry
    const entryCandles = newCandles.filter(c => new Date(c.timestamp) > new Date(setup.detectedAt));
    if (entryCandles.length === 0) return;
    
    setup.barsSinceEntry = entryCandles.length;
    
    for (const candle of entryCandles) {
      const high = candle.high;
      const low = candle.low;
      
      if (setup.direction === 'LONG') {
        // Check TP
        if (high >= setup.takeProfit) {
          setup.status = 'WIN';
          setup.resolvedAt = new Date().toISOString();
          setup.outcome = `+${setup.rewardPips.toFixed(1)} pips`;
          break;
        }
        // Check SL
        if (low <= setup.stopLoss) {
          setup.status = 'LOSS';
          setup.resolvedAt = new Date().toISOString();
          setup.outcome = `-${setup.riskPips.toFixed(1)} pips`;
          break;
        }
        // Track excursion
        const pnlPips = (candle.close - setup.entryPrice) * 10000;
        setup.maxFavorablePips = Math.max(setup.maxFavorablePips, pnlPips);
        setup.maxAdversePips = Math.min(setup.maxAdversePips, pnlPips);
      } else {
        // SHORT
        if (low <= setup.takeProfit) {
          setup.status = 'WIN';
          setup.resolvedAt = new Date().toISOString();
          setup.outcome = `+${setup.rewardPips.toFixed(1)} pips`;
          break;
        }
        if (high >= setup.stopLoss) {
          setup.status = 'LOSS';
          setup.resolvedAt = new Date().toISOString();
          setup.outcome = `-${setup.riskPips.toFixed(1)} pips`;
          break;
        }
        const pnlPips = (setup.entryPrice - candle.close) * 10000;
        setup.maxFavorablePips = Math.max(setup.maxFavorablePips, pnlPips);
        setup.maxAdversePips = Math.min(setup.maxAdversePips, pnlPips);
      }
    }
    
    // Expire old pending setups
    if (setup.status === 'PENDING' && setup.barsSinceEntry > SETTINGS.pendingExpiryBars) {
      setup.status = 'EXPIRED';
      setup.resolvedAt = new Date().toISOString();
      setup.outcome = 'Expired';
    }
  });
}

function getSetupCurrentStatus(setup, latestPrice) {
  if (setup.status !== 'PENDING' || !latestPrice) return setup.status;
  
  let pnlPips;
  if (setup.direction === 'LONG') {
    pnlPips = (latestPrice - setup.entryPrice) * 10000;
  } else {
    pnlPips = (setup.entryPrice - latestPrice) * 10000;
  }
  
  if (pnlPips > 0) return 'WINNING';
  if (pnlPips < 0) return 'LOSING';
  return 'PENDING';
}

// =============================================================================
// MAIN POLLING LOOP
// =============================================================================

async function pollPair(pair, delayMs) {
  await new Promise(r => setTimeout(r, delayMs));
  
  try {
    const candles = await fetchCandles(pair, SETTINGS.primaryTf, 500);
    const key = `${cleanPair(pair)}_${SETTINGS.primaryTf}`;
    const oldCandles = state.candles[key] || [];
    state.candles[key] = candles;
    
    // Update outcomes for existing setups with new data
    if (oldCandles.length > 0) {
      updateSetupOutcomes(pair, candles);
    }
    
    // Find new setups
    const newSetups = findRangerSetups(candles, pair);
    
    // Only add setups we haven't seen (by unique signature)
    newSetups.forEach(ns => {
      const sig = `${ns.pair}_${ns.entryPrice}_${ns.direction}_${ns.swingPrice}`;
      const exists = state.setups.some(s => 
        s.pair === ns.pair && 
        Math.abs(s.entryPrice - ns.entryPrice) < 0.0001 &&
        s.direction === ns.direction
      );
      if (!exists) {
        state.setups.unshift(ns); // Newest first
      }
    });
    
    console.log(`[${new Date().toISOString()}] ${pair}: ${candles.length} candles, ${newSetups.length} new setups`);
    return { pair, candles: candles.length, newSetups: newSetups.length };
  } catch (err) {
    console.error(`Poll failed for ${pair}:`, err.message);
    return { pair, error: err.message };
  }
}

async function runPoll() {
  if (!SETTINGS.isRunning) return;
  
  console.log(`\n=== POLL CYCLE START ===`);
  state.lastPoll = new Date().toISOString();
  
  // Staggered requests to avoid rate limit crash
  const results = await Promise.all(
    SETTINGS.pairs.map((pair, i) => pollPair(pair, i * SETTINGS.staggerMs))
  );
  
  const nextPollTime = new Date(Date.now() + SETTINGS.pollIntervalMinutes * 60000);
  state.nextPoll = nextPollTime.toISOString();
  
  broadcast({ type: 'pollComplete', results, nextPoll: state.nextPoll });
  
  // Schedule next poll
  setTimeout(runPoll, SETTINGS.pollIntervalMinutes * 60000);
}

// =============================================================================
// WEBSOCKET & API
// =============================================================================

function broadcast(msg) {
  const data = JSON.stringify(msg);
  state.wsClients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// GET /api/status - Current state
app.get('/api/status', (req, res) => {
  const latestPrices = {};
  SETTINGS.pairs.forEach(p => {
    const key = `${cleanPair(p)}_${SETTINGS.primaryTf}`;
    const c = state.candles[key];
    if (c && c.length > 0) latestPrices[cleanPair(p)] = c[c.length-1].close;
  });
  
  // Enrich setups with current status
  const enrichedSetups = state.setups.map(s => ({
    ...s,
    currentStatus: getSetupCurrentStatus(s, latestPrices[s.pair])
  }));
  
  res.json({
    isRunning: SETTINGS.isRunning,
    lastPoll: state.lastPoll,
    nextPoll: state.nextPoll,
    apiCallsToday: state.apiCallsToday,
    apiCallsThisMinute: state.apiCallsThisMinute.length,
    pollIntervalMinutes: SETTINGS.pollIntervalMinutes,
    pairs: SETTINGS.pairs,
    latestPrices,
    setups: enrichedSetups.slice(0, 100), // Limit payload
    stats: calculateStats(enrichedSetups)
  });
});

function calculateStats(setups) {
  const resolved = setups.filter(s => s.status === 'WIN' || s.status === 'LOSS');
  const wins = resolved.filter(s => s.status === 'WIN').length;
  const losses = resolved.filter(s => s.status === 'LOSS').length;
  const pending = setups.filter(s => s.status === 'PENDING').length;
  const winningNow = setups.filter(s => s.currentStatus === 'WINNING').length;
  const losingNow = setups.filter(s => s.currentStatus === 'LOSING').length;
  
  const totalPips = resolved.reduce((sum, s) => {
    return sum + (s.status === 'WIN' ? s.rewardPips : -s.riskPips);
  }, 0);
  
  return {
    totalSetups: setups.length,
    wins, losses, pending,
    winRate: resolved.length > 0 ? (wins / resolved.length * 100).toFixed(1) : '0.0',
    totalPips: totalPips.toFixed(1),
    winningNow,
    losingNow,
    avgRisk: resolved.length > 0 ? (resolved.reduce((s, x) => s + x.riskPips, 0) / resolved.length).toFixed(1) : '0'
  };
}

// POST /api/settings - Update configuration
app.post('/api/settings', (req, res) => {
  const updates = req.body;
  
  // Validate and apply
  if (updates.pairs && Array.isArray(updates.pairs)) SETTINGS.pairs = updates.pairs;
  if (updates.pollIntervalMinutes !== undefined) {
    const mins = parseInt(updates.pollIntervalMinutes);
    // Enforce rate limit math
    const maxPairs = SETTINGS.pairs.length || 1;
    const minInterval = Math.ceil((maxPairs * 60) / 8); // Minimum to stay under 8/min
    const safeForDaily = Math.ceil((maxPairs * 24 * 60) / 800); // Minimum for 800/day
    SETTINGS.pollIntervalMinutes = Math.max(mins, minInterval, safeForDaily, 1);
  }
  if (updates.twelveDataKey) SETTINGS.twelveDataKey = updates.twelveDataKey;
  if (updates.swingLookback !== undefined) SETTINGS.swingLookback = parseInt(updates.swingLookback);
  if (updates.maxSwingAge !== undefined) SETTINGS.maxSwingAge = parseInt(updates.maxSwingAge);
  if (updates.maxFvgAge !== undefined) SETTINGS.maxFvgAge = parseInt(updates.maxFvgAge);
  if (updates.recencyWindow !== undefined) SETTINGS.recencyWindow = parseInt(updates.recencyWindow);
  if (updates.minSweepPips !== undefined) SETTINGS.minSweepPips = parseFloat(updates.minSweepPips);
  if (updates.minDisrespectPips !== undefined) SETTINGS.minDisrespectPips = parseFloat(updates.minDisrespectPips);
  if (updates.maxPipRisk !== undefined) SETTINGS.maxPipRisk = parseFloat(updates.maxPipRisk);
  if (updates.minPipRisk !== undefined) SETTINGS.minPipRisk = parseFloat(updates.minPipRisk);
  if (updates.riskReward !== undefined) SETTINGS.riskReward = parseFloat(updates.riskReward);
  
  broadcast({ type: 'settingsUpdated', settings: getPublicSettings() });
  res.json({ success: true, settings: getPublicSettings() });
});
// POST /api/control - Start/stop
app.post('/api/control', (req, res) => {
  const { action } = req.body;
  if (action === 'start') {
    if (!SETTINGS.twelveDataKey) {
      return res.status(400).json({ error: 'Twelve Data API key required' });
    }
    SETTINGS.isRunning = true;
    runPoll();
  } else if (action === 'stop') {
    SETTINGS.isRunning = false;
  }
  res.json({ success: true, isRunning: SETTINGS.isRunning });
});
// GET /api/settings - Current settings
app.get('/api/settings', (req, res) => {
  res.json(getPublicSettings());
});

function getPublicSettings() {
  return {
    pairs: SETTINGS.pairs,
    pollIntervalMinutes: SETTINGS.pollIntervalMinutes,
    staggerMs: SETTINGS.staggerMs,
    swingLookback: SETTINGS.swingLookback,
    maxSwingAge: SETTINGS.maxSwingAge,
    maxFvgAge: SETTINGS.maxFvgAge,
    recencyWindow: SETTINGS.recencyWindow,
    minSweepPips: SETTINGS.minSweepPips,
    minDisrespectPips: SETTINGS.minDisrespectPips,
    maxPipRisk: SETTINGS.maxPipRisk,
    minPipRisk: SETTINGS.minPipRisk,
    riskReward: SETTINGS.riskReward,
    isRunning: SETTINGS.isRunning
  };
}
// DELETE /api/setups/:id - Remove a setup
app.delete('/api/setups/:id', (req, res) => {
  state.setups = state.setups.filter(s => s.id !== req.params.id);
  res.json({ success: true });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  state.wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', settings: getPublicSettings() }));
  
  ws.on('close', () => state.wsClients.delete(ws));
});

const PORT = SETTINGS.dashboardPort;
server.listen(PORT, () => {
  console.log(`RANGER BPR Bot running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Rate limit: 8/min, 800/day | ${SETTINGS.pairs.length} pairs | ${SETTINGS.pollIntervalMinutes}min interval`);
  console.log(`API math: ${SETTINGS.pairs.length} pairs × ${Math.floor(60/SETTINGS.pollIntervalMinutes)}/hr × 24hr = ${SETTINGS.pairs.length * Math.floor(60/SETTINGS.pollIntervalMinutes) * 24} requests/day (limit: 800)`);
});
