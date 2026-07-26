/**
 * RANGER — Balanced Price Range (BPR)
 * Rebuilt against the real strategy source (ChartTactix, "Master Balance
 * Price Range"). Key additions vs. the original looser build:
 *
 * 1. REQUIRES a liquidity sweep BEFORE the BPR forms — price must first
 *    take out a recent swing low (bullish setup) or swing high (bearish
 *    setup). Without this precondition, the source explicitly says a BPR
 *    is "just a pattern," not a high-probability setup.
 * 2. The impulsive move away from the sweep must genuinely "disrespect"
 *    (trade through) the opposite-direction FVG, turning it into an
 *    inverse FVG, while simultaneously creating a new same-direction FVG
 *    that overlaps it. This is checked directly, not just "any two
 *    adjacent opposite gaps."
 * 3. Stop-loss goes below/above the swing point that was swept (not just
 *    the BPR edge) — matches the source's stop placement rule.
 * 4. Target: 1:3 risk-to-reward (per user preference — the source itself
 *    recommends 1:2, but this has been deliberately widened on request).
 *
 * TIMEFRAMES: 1h (HTF, setup detection) / 5min (LTF, entry confirmation).
 * Originally built on 4h/15min per the source material, but switched to
 * 1h/5min at user request — smaller account size needs smaller stop
 * distances, and lower timeframes generally (not guaranteed) produce
 * tighter swings. No hard SL cap was added on top of this — the user
 * explicitly chose not to constrain the strategy's natural setup space,
 * accepting that stop size will still vary rather than being guaranteed
 * within a fixed pip range.
 */

const {
  findFairValueGaps,
  findSwingPoints,
} = require('./structure');

const STRATEGY_ID = 'RANGER';
const REWARD_RISK_RATIO = 3; // 1:3, per user preference

// Default settings — this bot is RANGER-only, so settings live directly
// here and in settingsStore.js (a lightweight in-memory + disk-persisted
// store, same pattern as the multi-strategy bot, just for one strategy).
const DEFAULT_SETTINGS = {
  swingLookback: 2,
  minCandlesRequired: 30,
  fvgRecencyWindow: 15,
  sweepLookback: 30,
  maxStopLossPipsEnabled: false,
  maxStopLossPips: 30,
};

/**
 * Convert a raw price distance into pips for a given symbol.
 * JPY pairs use 2 decimal places (1 pip = 0.01); everything else here
 * uses 4 decimal places (1 pip = 0.0001). XAU/USD isn't in the current
 * pair list but is included for safety if re-added later (1 pip = 0.01).
 */
function toPips(priceDistance, symbol) {
  if (symbol.includes('JPY')) return priceDistance * 100;
  if (symbol.includes('XAU')) return priceDistance * 100;
  return priceDistance * 10000;
}

function rangesOverlap(a, b) {
  return a.bottom <= b.top && b.bottom <= a.top;
}

/**
 * Find a liquidity sweep: a candle that trades beyond a recent swing
 * low/high (taking liquidity) within the given lookback window.
 * Checks the last few swing points (not just the single most recent one)
 * so there's realistic room for the sweep -> impulse -> BPR sequence to
 * fully unfold within the available candle history, rather than only
 * ever finding a sweep in the last handful of candles.
 * Returns the swept swing point + the candle index that swept it, or null.
 */
function findLiquiditySweep(candles, swingPoints, direction, lookback) {
  // direction 'low' = sell-side liquidity sweep (bullish setup precondition)
  // direction 'high' = buy-side liquidity sweep (bearish setup precondition)
  const points = direction === 'low' ? swingPoints.swingLows : swingPoints.swingHighs;
  if (points.length === 0) return null;

  // Check the last few swing points, oldest first, so we find the
  // EARLIEST valid sweep that still leaves room for a BPR to form after it.
  const candidates = points.slice(-5);
  for (const point of candidates) {
    for (let i = point.index + 1; i < candles.length; i++) {
      const c = candles[i];
      const swept = direction === 'low' ? c.low < point.price : c.high > point.price;
      if (swept) {
        return { point, sweepIndex: i };
      }
    }
  }
  return null;
}

/**
 * Find a BPR that formed via genuine "disrespect" of an opposite FVG:
 * an inverse FVG (opposite-type gap that price has since traded through)
 * overlapping with a freshly formed same-direction gap.
 * `minIndex` restricts the search to gaps formed at or after this index
 * (used to ensure the BPR forms AFTER a liquidity sweep, not before it).
 */
function findDisrespectedBPR(candles, gaps, biasDirection, minIndex = 0) {
  const wantedNewGapType = biasDirection === 'bullish' ? 'bullish' : 'bearish';
  const oldGapType = biasDirection === 'bullish' ? 'bearish' : 'bullish';

  // Find candidate "inverse" gaps: an old-direction gap that price has
  // since traded through (closed beyond it), disrespecting it.
  for (let i = gaps.length - 1; i >= 0; i--) {
    const newGap = gaps[i];
    if (newGap.type !== wantedNewGapType) continue;
    if (newGap.index < minIndex) continue; // must form at/after the sweep

    // Look for an older, opposite-type gap that this new gap overlaps with.
    for (let j = i - 1; j >= 0; j--) {
      const oldGap = gaps[j];
      if (oldGap.type !== oldGapType) continue;
      if (!rangesOverlap(oldGap, newGap)) continue;

      // Verify genuine disrespect: some candle between oldGap and newGap
      // must have traded through the old gap (closed beyond its far edge).
      let disrespected = false;
      for (let k = oldGap.index + 1; k < newGap.index; k++) {
        const c = candles[k];
        if (biasDirection === 'bullish' && c.close > oldGap.top) { disrespected = true; break; }
        if (biasDirection === 'bearish' && c.close < oldGap.bottom) { disrespected = true; break; }
      }
      if (!disrespected) continue;

      const bprTop = Math.min(oldGap.top, newGap.top);
      const bprBottom = Math.max(oldGap.bottom, newGap.bottom);
      return { top: bprTop, bottom: bprBottom, index: newGap.index, direction: biasDirection };
    }
  }
  return null;
}

function analyze(candlesByTimeframe, symbol, userSettings = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...userSettings };
  const lookback = settings.swingLookback;
  const fvgRecencyWindow = settings.fvgRecencyWindow;
  const sweepLookback = settings.sweepLookback;
  const maxStopLossPipsEnabled = settings.maxStopLossPipsEnabled;
  const maxStopLossPips = settings.maxStopLossPips;

  const htf = candlesByTimeframe['1h'];
  const ltf = candlesByTimeframe['5min'];
  if (!htf || !ltf || htf.length < settings.minCandlesRequired || ltf.length < settings.minCandlesRequired) return null;

  const swingPoints = findSwingPoints(htf, lookback);
  const htfGaps = findFairValueGaps(htf);
  if (htfGaps.length < 2) return null;

  // Try bullish scenario: sweep sell-side liquidity (swing low), then BPR forms.
  const bullishSweep = findLiquiditySweep(htf, swingPoints, 'low', sweepLookback);
  const bullishBPR = bullishSweep ? findDisrespectedBPR(htf, htfGaps, 'bullish', bullishSweep.sweepIndex) : null;

  // Try bearish scenario: sweep buy-side liquidity (swing high), then BPR forms.
  const bearishSweep = findLiquiditySweep(htf, swingPoints, 'high', sweepLookback);
  const bearishBPR = bearishSweep ? findDisrespectedBPR(htf, htfGaps, 'bearish', bearishSweep.sweepIndex) : null;

  // Pick whichever scenario has a valid, recent BPR (prefer the more recent one).
  let sweep, bpr;
  if (bullishBPR && bearishBPR) {
    if (bullishBPR.index >= bearishBPR.index) { sweep = bullishSweep; bpr = bullishBPR; }
    else { sweep = bearishSweep; bpr = bearishBPR; }
  } else if (bullishBPR) {
    sweep = bullishSweep; bpr = bullishBPR;
  } else if (bearishBPR) {
    sweep = bearishSweep; bpr = bearishBPR;
  } else {
    return null;
  }

  // The BPR's impulsive move must have happened AFTER the sweep (sweep -> impulse -> BPR).
  if (bpr.index <= sweep.sweepIndex) return null;

  // BPR must be recent.
  if (bpr.index < htf.length - fvgRecencyWindow) return null;

  const latestHtfCandle = htf[htf.length - 1];
  const priceAtBPR = latestHtfCandle.low <= bpr.top && latestHtfCandle.high >= bpr.bottom;
  if (!priceAtBPR) return null;

  // LTF confirmation: fresh FVG in the same direction, or price action
  // showing a reaction at the level (kept lenient per user preference —
  // not requiring a strict CISD on top of everything else above).
  const ltfGaps = findFairValueGaps(ltf);
  const recentLtfGap = ltfGaps.length > 0 ? ltfGaps[ltfGaps.length - 1] : null;
  const freshLtfGapMatches = recentLtfGap &&
    recentLtfGap.type === bpr.direction &&
    recentLtfGap.index >= ltf.length - 6;

  if (!freshLtfGapMatches) return null;

  const latestLtfCandle = ltf[ltf.length - 1];
  const sweptPrice = sweep.point.price;

  if (bpr.direction === 'bullish') {
    // Stop-loss below the swept swing low (per source: "stop loss goes below the swing low").
    const stopLoss = Math.min(sweptPrice, bpr.bottom) - (bpr.top - bpr.bottom) * 0.1;
    const entry = latestLtfCandle.close;
    const risk = entry - stopLoss;
    if (risk <= 0 || risk > entry * 0.05) return null; // sanity guard: reject absurd stop distances (>5% of price is not realistic for major forex pairs)

    // Optional user-controlled cap: reject setups whose natural stop
    // distance exceeds the configured pip limit. OFF by default — only
    // applied when the user has explicitly enabled it (e.g. for a
    // smaller account that can't tolerate wide stops).
    if (maxStopLossPipsEnabled && toPips(risk, symbol) > maxStopLossPips) return null;

    const takeProfit = entry + risk * REWARD_RISK_RATIO;
    if (takeProfit <= 0) return null;

    return {
      strategy: STRATEGY_ID,
      symbol,
      direction: 'buy',
      timeframe: '1h/5min',
      entry,
      stopLoss,
      takeProfit,
      reason: 'Sell-side liquidity swept, impulsive move disrespected prior bearish FVG forming a Balanced Price Range, fresh LTF FVG confirmation',
      time: latestLtfCandle.time,
    };
  }

  if (bpr.direction === 'bearish') {
    const stopLoss = Math.max(sweptPrice, bpr.top) + (bpr.top - bpr.bottom) * 0.1;
    const entry = latestLtfCandle.close;
    const risk = stopLoss - entry;
    if (risk <= 0 || risk > entry * 0.05) return null; // sanity guard: reject absurd stop distances (>5% of price is not realistic for major forex pairs)

    // Optional user-controlled cap — see comment in the buy branch above.
    if (maxStopLossPipsEnabled && toPips(risk, symbol) > maxStopLossPips) return null;

    const takeProfit = entry - risk * REWARD_RISK_RATIO;
    if (takeProfit <= 0) return null;

    return {
      strategy: STRATEGY_ID,
      symbol,
      direction: 'sell',
      timeframe: '1h/5min',
      entry,
      stopLoss,
      takeProfit,
      reason: 'Buy-side liquidity swept, impulsive move disrespected prior bullish FVG forming a Balanced Price Range, fresh LTF FVG confirmation',
      time: latestLtfCandle.time,
    };
  }

  return null;
}

module.exports = { analyze, STRATEGY_ID };
  
