/**
 * Unified market data interface. Everything else calls ONLY this module.
 * If TWELVE_DATA_API_KEY is set, real data is fetched from Twelve Data.
 * Otherwise, mock data is generated so the app can still be demoed.
 */

const mockData = require('./mockData');
const twelveData = require('./twelveData');

function isLiveMode() {
  return Boolean(process.env.TWELVE_DATA_API_KEY);
}

async function getCandles(symbol, interval, outputsize = 100) {
  if (isLiveMode()) {
    return twelveData.getCandles(symbol, interval, outputsize);
  }
  return mockData.generateCandles(symbol, interval, outputsize);
}

async function getMultiTimeframeCandles(symbol, intervals, outputsize = 100) {
  const result = {};
  for (const interval of intervals) {
    result[interval] = await getCandles(symbol, interval, outputsize);
  }
  return result;
}

module.exports = { getCandles, getMultiTimeframeCandles, isLiveMode };
