/**
 * Twelve Data client.
 * Handles fetching OHLC candles, basic in-memory caching, and
 * graceful rate-limit backoff (free/basic tiers are limited to
 * a small number of requests per minute).
 */

const API_BASE = 'https://api.twelvedata.com';
const API_KEY = process.env.TWELVE_DATA_API_KEY;

// Simple in-memory cache: key -> { data, fetchedAt }
const cache = new Map();

// How long cached candles are considered "fresh" per timeframe (ms).
// Lengthened significantly to stay within an 8 req/min, 800 req/day plan —
// candles on a given timeframe genuinely don't change until that
// timeframe's next candle closes, so there's no value in re-fetching
// more often than that.
const CACHE_TTL = {
  '1min': 60 * 1000,        // 1 min
  '5min': 5 * 60 * 1000,    // 5 min
  '15min': 10 * 60 * 1000,  // 10 min
  '1h': 20 * 60 * 1000,     // 20 min
  '4h': 60 * 60 * 1000,     // 1 hour
  '1day': 4 * 60 * 60 * 1000, // 4 hours
};

// Basic request queue to avoid slamming rate limits.
// IMPORTANT: tune this to your actual Twelve Data plan's limit.
// Twelve Data "Basic 8" plan = 8 requests/minute, 800/day.
// 8 req/min means one request every 7.5s minimum — we use 8s to
// leave a small safety margin.
let lastRequestTime = 0;
const MIN_REQUEST_GAP_MS = 8000; // ~7.5 req/min ceiling, safe under an 8/min plan

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttledFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, lastRequestTime + MIN_REQUEST_GAP_MS - now);
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();

  const res = await fetch(url);
  const json = await res.json();

  if (json.status === 'error') {
    // Rate limit or bad request — surface a clear error upstream.
    throw new Error(`Twelve Data error: ${json.message || 'unknown error'}`);
  }
  return json;
}

/**
 * Fetch OHLC candles for a symbol/timeframe, using cache when fresh.
 * symbol: e.g. 'EUR/USD', 'XAU/USD'
 * interval: '1min' | '5min' | '15min' | '1h' | '4h' | '1day'
 * outputsize: number of candles to fetch (default 100)
 */
async function getCandles(symbol, interval, outputsize = 100) {
  const cacheKey = `${symbol}_${interval}_${outputsize}`;
  const cached = cache.get(cacheKey);
  const ttl = CACHE_TTL[interval] || 60 * 1000;

  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return cached.data;
  }

  const url = `${API_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${API_KEY}`;

  const json = await throttledFetch(url);

  if (!json.values) {
    throw new Error(`No candle data returned for ${symbol} ${interval}`);
  }

  // Twelve Data returns newest-first; normalize to oldest-first.
  const candles = json.values
    .map((v) => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse();

  cache.set(cacheKey, { data: candles, fetchedAt: Date.now() });
  return candles;
}

/**
 * Fetch candles for multiple timeframes at once (used by strategies
 * that need HTF bias + LTF confirmation, e.g. Power of Three).
 * Returns { '1h': [...], '15min': [...] } etc.
 */
async function getMultiTimeframeCandles(symbol, intervals, outputsize = 100) {
  const result = {};
  for (const interval of intervals) {
    result[interval] = await getCandles(symbol, interval, outputsize);
  }
  return result;
}

module.exports = {
  getCandles,
  getMultiTimeframeCandles,
};
