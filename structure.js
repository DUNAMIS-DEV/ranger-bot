/**
 * Shared market-structure utilities.
 * Every strategy module builds on these primitives:
 *  - swing point detection (highs/lows)
 *  - trend direction
 *  - break of structure (BOS) / change of character (CHoCH)
 *  - fair value gaps (FVG)
 *  - candle pattern helpers (engulfing, wick ratios)
 *
 * Candle shape expected everywhere in this codebase:
 *  { time, open, high, low, close }
 */

/**
 * Find swing highs/lows using a simple fractal method:
 * a candle at index i is a swing high if its high is greater than
 * `lookback` candles on each side; swing low is the mirror case.
 */
function findSwingPoints(candles, lookback = 2) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }

    if (isHigh) swingHighs.push({ index: i, price: c.high, time: c.time });
    if (isLow) swingLows.push({ index: i, price: c.low, time: c.time });
  }

  return { swingHighs, swingLows };
}

/**
 * Determine trend direction from the last N swing highs/lows.
 * Returns 'up' | 'down' | 'sideways'.
 *
 * Uses a majority/net-direction check rather than requiring every
 * single swing point to strictly increase or decrease — real price
 * action rarely produces perfectly monotonic swings, so a strict
 * check was returning "sideways" almost always.
 */
function getTrendDirection(candles, lookback = 2, sampleSize = 4) {
  const { swingHighs, swingLows } = findSwingPoints(candles, lookback);

  const recentHighs = swingHighs.slice(-sampleSize);
  const recentLows = swingLows.slice(-sampleSize);

  if (recentHighs.length < 2 || recentLows.length < 2) return 'sideways';

  // Net direction: compare first vs last in the sample window rather
  // than requiring strict step-by-step monotonicity.
  const highsNetChange = recentHighs[recentHighs.length - 1].price - recentHighs[0].price;
  const lowsNetChange = recentLows[recentLows.length - 1].price - recentLows[0].price;

  // Count how many consecutive steps agree with the net direction —
  // this tolerates one noisy swing without flipping the whole read.
  const countAgreeing = (points, wantRising) => {
    let agree = 0;
    for (let i = 1; i < points.length; i++) {
      const rising = points[i].price > points[i - 1].price;
      if (rising === wantRising) agree++;
    }
    return agree;
  };

  const highsRisingMajority = highsNetChange > 0 && countAgreeing(recentHighs, true) >= recentHighs.length - 2;
  const lowsRisingMajority = lowsNetChange > 0 && countAgreeing(recentLows, true) >= recentLows.length - 2;
  const highsFallingMajority = highsNetChange < 0 && countAgreeing(recentHighs, false) >= recentHighs.length - 2;
  const lowsFallingMajority = lowsNetChange < 0 && countAgreeing(recentLows, false) >= recentLows.length - 2;

  if (highsRisingMajority && lowsRisingMajority) return 'up';
  if (highsFallingMajority && lowsFallingMajority) return 'down';
  return 'sideways';
}

/**
 * Detect a break of structure (BOS): the most recent close breaks
 * beyond the last relevant swing point in the given direction.
 * direction: 'up' looks for a close above the last swing high,
 *            'down' looks for a close below the last swing low.
 * Returns the breaking candle index + the swing point broken, or null.
 */
function detectBreakOfStructure(candles, direction, lookback = 2) {
  const { swingHighs, swingLows } = findSwingPoints(candles, lookback);

  if (direction === 'up') {
    if (swingHighs.length === 0) return null;
    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    for (let i = lastSwingHigh.index + 1; i < candles.length; i++) {
      if (candles[i].close > lastSwingHigh.price) {
        return { breakIndex: i, brokenLevel: lastSwingHigh };
      }
    }
  } else if (direction === 'down') {
    if (swingLows.length === 0) return null;
    const lastSwingLow = swingLows[swingLows.length - 1];
    for (let i = lastSwingLow.index + 1; i < candles.length; i++) {
      if (candles[i].close < lastSwingLow.price) {
        return { breakIndex: i, brokenLevel: lastSwingLow };
      }
    }
  }
  return null;
}

/**
 * Change in State of Delivery (CISD) / Change of Character (CHoCH):
 * a close that breaks the opposite-direction structure, signaling
 * a possible reversal. Same mechanics as BOS but checked against
 * the trend that was previously in place.
 */
function detectChangeOfCharacter(candles, priorTrend, lookback = 2) {
  const oppositeDirection = priorTrend === 'up' ? 'down' : 'up';
  return detectBreakOfStructure(candles, oppositeDirection, lookback);
}

/**
 * Detect Fair Value Gaps (3-candle imbalance).
 * Bullish FVG: candle[i-1].high < candle[i+1].low (gap between them)
 * Bearish FVG: candle[i-1].low > candle[i+1].high
 * Returns array of { index, type, top, bottom }.
 */
function findFairValueGaps(candles) {
  const gaps = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    if (prev.high < next.low) {
      gaps.push({
        index: i,
        type: 'bullish',
        top: next.low,
        bottom: prev.high,
      });
    }
    if (prev.low > next.high) {
      gaps.push({
        index: i,
        type: 'bearish',
        top: prev.low,
        bottom: next.high,
      });
    }
  }
  return gaps;
}

/**
 * Check if a candle is a bullish/bearish engulfing pattern relative
 * to the previous candle.
 */
function isEngulfing(prevCandle, candle) {
  const prevBullish = prevCandle.close > prevCandle.open;
  const currBullish = candle.close > candle.open;

  const bullishEngulf =
    !prevBullish && currBullish &&
    candle.close > prevCandle.open &&
    candle.open < prevCandle.close;

  const bearishEngulf =
    prevBullish && !currBullish &&
    candle.open > prevCandle.close &&
    candle.close < prevCandle.open;

  if (bullishEngulf) return 'bullish';
  if (bearishEngulf) return 'bearish';
  return null;
}

/**
 * Wick ratio helpers — used for "long upper/lower wick" rejection checks.
 * Returns wick length as a multiple of the candle body.
 */
function wickRatios(candle) {
  const body = Math.abs(candle.close - candle.open) || 1e-9;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return {
    upperRatio: upperWick / body,
    lowerRatio: lowerWick / body,
    upperWick,
    lowerWick,
    body,
  };
}

/** A "long wick" candle: wick is at least `minRatio`x the body (default 1.5x). */
function hasLongUpperWick(candle, minRatio = 1.5) {
  return wickRatios(candle).upperRatio >= minRatio;
}
function hasLongLowerWick(candle, minRatio = 1.5) {
  return wickRatios(candle).lowerRatio >= minRatio;
}

/** Standard Fibonacci retracement levels between two price points. */
function fibLevels(startPrice, endPrice) {
  const diff = endPrice - startPrice;
  return {
    0: endPrice,
    0.382: endPrice - diff * 0.382,
    0.5: endPrice - diff * 0.5,
    0.618: endPrice - diff * 0.618,
    1: startPrice,
  };
}

module.exports = {
  findSwingPoints,
  getTrendDirection,
  detectBreakOfStructure,
  detectChangeOfCharacter,
  findFairValueGaps,
  isEngulfing,
  wickRatios,
  hasLongUpperWick,
  hasLongLowerWick,
  fibLevels,
};
  
