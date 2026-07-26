/**
 * Mock data generator — produces realistic-looking OHLC candles so
 * the whole system (strategies, dashboard, alerts) can run and be
 * demoed WITHOUT a Twelve Data API key. Once TWELVE_DATA_API_KEY is
 * set in the environment, the app automatically switches to real data
 * (see data/twelveData.js + data/marketData.js).
 */

const BASE_PRICES = {
  'EUR/USD': 1.0850,
  'GBP/USD': 1.2650,
  'USD/JPY': 157.50,
  'USD/CHF': 0.9050,
  'XAU/USD': 2380.00,
};

// Deterministic-ish pseudo-random walk so repeated calls within the
// same session look continuous rather than fully random noise.
const seriesCache = new Map();

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function intervalToMinutes(interval) {
  const map = {
    '1min': 1, '5min': 5, '15min': 15, '1h': 60, '4h': 240, '1day': 1440,
  };
  return map[interval] || 60;
}

function generateCandles(symbol, interval, count = 100) {
  const cacheKey = `${symbol}_${interval}`;
  const basePrice = BASE_PRICES[symbol] || 1.0;
  const volatility = basePrice * 0.0015; // rough per-candle volatility
  const minutesPerCandle = intervalToMinutes(interval);

  let seed = seriesCache.get(cacheKey) || Math.abs(hashCode(cacheKey));
  const candles = [];
  let price = basePrice;
  const now = Date.now();

  // Build price action in "legs": an impulsive move followed by a
  // pullback/retest, then continuation — this mirrors the actual
  // structures (BOS -> retest, impulse -> pullback) the strategies
  // are designed to detect, rather than pure random noise.
  let candlesUntilNextLeg = 0;
  let legDirection = 1;
  let legStrength = 1;

  for (let i = 0; i < count; i++) {
    seed += 1;
    const r1 = seededRandom(seed);
    const r2 = seededRandom(seed * 1.37);
    const r3 = seededRandom(seed * 2.11);
    const r4 = seededRandom(seed * 3.71);

    if (candlesUntilNextLeg <= 0) {
      // Start a new leg: alternate impulse / pullback phases.
      legDirection = r1 > 0.45 ? legDirection : -legDirection; // mostly continue, sometimes reverse
      legStrength = 1.5 + r2 * 2.5; // impulsive legs are stronger
      candlesUntilNextLeg = 3 + Math.floor(r3 * 4); // leg lasts 3-6 candles
    }
    candlesUntilNextLeg--;

    const open = price;
    const bodySize = volatility * legStrength * (0.5 + r4 * 0.8);
    let close = open + legDirection * bodySize;

    // Occasionally force a genuine engulfing candle: open beyond the
    // previous candle's close, close beyond the previous candle's open,
    // in the opposite direction of the previous candle's body.
    const engulfRoll = seededRandom(seed * 7.9);
    let forcedOpen = open;
    if (engulfRoll > 0.9 && candles.length > 0) {
      const prev = candles[candles.length - 1];
      const prevBullish = prev.close > prev.open;
      if (prevBullish) {
        // force a bearish engulfing candle
        forcedOpen = prev.close + volatility * 0.1;
        close = prev.open - volatility * 0.15;
      } else {
        // force a bullish engulfing candle
        forcedOpen = prev.close - volatility * 0.1;
        close = prev.open + volatility * 0.15;
      }
    }
    const finalOpen = forcedOpen;

    // Realistic wicks: occasionally produce a genuinely long wick
    // (rejection candle) so wick-based confirmation logic has real
    // patterns to find, not just tiny proportional noise.
    const wickRoll = seededRandom(seed * 5.3);
    let upperWick, lowerWick;
    if (wickRoll > 0.85) {
      // Long upper wick (rejection from above)
      upperWick = bodySize * (1.5 + r2 * 2);
      lowerWick = bodySize * 0.15;
    } else if (wickRoll < 0.15) {
      // Long lower wick (rejection from below)
      lowerWick = bodySize * (1.5 + r3 * 2);
      upperWick = bodySize * 0.15;
    } else {
      upperWick = bodySize * (0.1 + r2 * 0.3);
      lowerWick = bodySize * (0.1 + r3 * 0.3);
    }

    const high = Math.max(finalOpen, close) + upperWick;
    const low = Math.min(finalOpen, close) - lowerWick;

    price = close;

    const time = new Date(now - (count - i) * minutesPerCandle * 60 * 1000).toISOString();

    candles.push({
      time,
      open: round(finalOpen, symbol),
      high: round(high, symbol),
      low: round(low, symbol),
      close: round(close, symbol),
    });
  }

  seriesCache.set(cacheKey, seed);
  return candles;
}

function round(value, symbol) {
  const decimals = symbol === 'USD/JPY' ? 3 : symbol === 'XAU/USD' ? 2 : 5;
  return parseFloat(value.toFixed(decimals));
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

module.exports = { generateCandles };
