/**
 * Runner — RANGER-only bot, so this is simpler than a multi-strategy
 * queue: one strategy, N pairs. Still staggers requests across pairs
 * (8s gap) so a poll cycle doesn't burst all N pairs' API calls in the
 * same instant — that caused a real rate-limit crash in an earlier,
 * multi-strategy version of this bot, so the fix carries over here too.
 */

const marketData = require('./marketData');
const { getSettings } = require('./settingsStore');
const setupStore = require('./setupStore');
const { sendSetupAlert } = require('./telegramBot');
const { updatePendingOutcomes } = require('./outcomeTracker');
const ranger = require('./ranger');

const INTER_PAIR_STAGGER_MS = 8000; // 8s between each pair's check

let isRunning = false;
let stopped = false;
let lastRunLog = [];
let timers = {};

function sleep(ms) {
  return new Promise((resolve) => { timers['__sleep'] = setTimeout(resolve, ms); });
}

async function checkPair(symbol, settings) {
  try {
    const candles = await marketData.getMultiTimeframeCandles(symbol, ['1h', '5min'], 200);
    const result = ranger.analyze(candles, symbol, settings);
    return { symbol, result };
  } catch (err) {
    console.error(`[Runner] Error checking ${symbol}:`, err.message);
    return { symbol, error: err.message };
  }
}

async function runOnce() {
  const settings = getSettings();
  const runLog = [];

  if (!settings.enabled) {
    runLog.push({ status: 'disabled' });
    lastRunLog = runLog;
    return runLog;
  }

  for (const symbol of settings.pairs) {
    const { result, error } = await checkPair(symbol, settings);

    if (error) {
      runLog.push({ symbol, status: 'error', error });
    } else if (result) {
      const stored = setupStore.addSetup(result, settings.telegram.dedupeWindowMinutes);
      if (stored) {
        runLog.push({ symbol, status: 'setup_found', direction: result.direction });
        if (settings.telegram.enabled) {
          sendSetupAlert(stored).catch((e) => console.error('Telegram send error:', e.message));
        }
      } else {
        runLog.push({ symbol, status: 'rejected_duplicate_or_conflict' });
      }
    } else {
      runLog.push({ symbol, status: 'no_setup' });
    }

    // Stagger between pairs, not just at the top of each cycle.
    await sleep(INTER_PAIR_STAGGER_MS);
  }

  await updatePendingOutcomes(setupStore);

  lastRunLog = runLog;
  return runLog;
}

async function pollLoopForever() {
  while (!stopped) {
    await runOnce();
    const settings = getSettings();
    await sleep(settings.pollIntervalMs);
  }
}

function startRunner() {
  if (isRunning) return;
  isRunning = true;
  stopped = false;

  const settings = getSettings();
  const pairCount = settings.pairs.length;
  const combosPerDay = pairCount * 2 * (24 * 60 * 60 * 1000 / settings.pollIntervalMs);
  console.log(`[Runner] Started. ${pairCount} pairs, poll every ${(settings.pollIntervalMs / 60000).toFixed(0)} min.`);
  console.log(`[Runner] API math: ${pairCount} pairs x 2 timeframes x ${(24 * 60 / (settings.pollIntervalMs / 60000)).toFixed(1)} checks/day = ~${combosPerDay.toFixed(0)} requests/day (limit: 800)`);

  pollLoopForever().catch((e) => console.error('[Runner] Poll loop crashed:', e.message));
}

function stopRunner() {
  stopped = true;
  if (timers['__sleep']) clearTimeout(timers['__sleep']);
  isRunning = false;
  console.log('[Runner] Stopped.');
}

function getRunnerStatus() {
  return { isRunning, lastRunLog };
}

module.exports = { startRunner, stopRunner, runOnce, getRunnerStatus };
    
