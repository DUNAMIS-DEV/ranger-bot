/**
 * Outcome tracker — once a setup is generated, it's "pending" until
 * price either hits its take-profit (win) or stop-loss (loss) first.
 * This module checks all pending/in-progress setups against the latest
 * price on each poll and updates their status accordingly.
 *
 * Status lifecycle:
 *   pending -> winning/losing (in-progress, based on current price vs entry)
 *           -> win/loss (locked in once TP or SL is actually touched)
 * Once a setup reaches 'win' or 'loss' it's final and no longer checked.
 */

const marketData = require('./marketData');
const { getSetups } = require('./setupStore');

/**
 * Given a setup and a candle, determine if TP or SL was actually hit
 * (a FINAL outcome). Checks high/low of the candle against both levels.
 * If both would technically be touched within the same candle (rare,
 * but possible on a big-range candle), we conservatively assume SL was
 * hit first (worst-case assumption — this can't be known for certain
 * without lower-timeframe data, so we err toward the pessimistic outcome).
 */
function checkFinalOutcome(setup, candle) {
  const { direction, stopLoss, takeProfit } = setup;

  if (direction === 'buy') {
    const hitTP = candle.high >= takeProfit;
    const hitSL = candle.low <= stopLoss;
    if (hitTP && hitSL) return 'loss'; // ambiguous same-candle hit — assume worst case
    if (hitTP) return 'win';
    if (hitSL) return 'loss';
  }

  if (direction === 'sell') {
    const hitTP = candle.low <= takeProfit;
    const hitSL = candle.high >= stopLoss;
    if (hitTP && hitSL) return 'loss';
    if (hitTP) return 'win';
    if (hitSL) return 'loss';
  }

  return null; // TP/SL not yet reached
}

/**
 * Given a setup and the current (latest) price, determine the
 * IN-PROGRESS directional read: is price currently sitting favorably
 * (beyond entry, in the trade's direction) or unfavorably (behind entry)?
 * This is NOT a final outcome — it's a live "how's it looking right now"
 * status that can flip back and forth until TP/SL actually locks it in.
 */
function checkInProgressStatus(setup, currentPrice) {
  const { direction, entry } = setup;

  if (direction === 'buy') {
    return currentPrice >= entry ? 'winning' : 'losing';
  }
  if (direction === 'sell') {
    return currentPrice <= entry ? 'winning' : 'losing';
  }
  return 'pending';
}

// Backward-compatible alias, in case anything else imports the old name.
const checkOutcome = checkFinalOutcome;

/**
 * Checks every non-final setup (pending, winning, or losing — i.e. not
 * yet win/loss) against the most recent candles for its symbol/timeframe,
 * and updates status in the setup store:
 *   1. First check if TP or SL was actually touched by any candle since
 *      the setup was created -> lock in as 'win' or 'loss' if so.
 *   2. Otherwise, update the in-progress 'winning'/'losing' read based
 *      on the latest close price vs entry.
 */
async function updatePendingOutcomes(setupStoreRef) {
  const allSetups = setupStoreRef.getSetups({ limit: 500 });
  const active = allSetups.filter((s) => s.outcome !== 'win' && s.outcome !== 'loss');

  for (const setup of active) {
    try {
      // Use the setup's own timeframe (first one if multi-timeframe like "4h/15min")
      const timeframe = setup.timeframe.split('/')[0];
      const candles = await marketData.getCandles(setup.symbol, timeframe, 50);
      if (candles.length === 0) continue;

      // Only check candles that occurred AFTER the setup was created,
      // so we don't judge the outcome using data from before the signal.
      // Use the setup's own entry-basis SL/TP (which may have been
      // manually edited by the user since creation).
      const setupTime = new Date(setup.createdAt).getTime();
      const relevantCandles = candles.filter((c) => new Date(c.time).getTime() >= setupTime);

      let finalOutcome = null;
      let finalOutcomeTime = null;
      for (const candle of relevantCandles) {
        const outcome = checkFinalOutcome(setup, candle);
        if (outcome) {
          finalOutcome = outcome;
          finalOutcomeTime = candle.time;
          break;
        }
      }

      if (finalOutcome) {
        setupStoreRef.updateSetupOutcome(setup.id, finalOutcome, finalOutcomeTime);
        continue;
      }

      // No final outcome yet — update the in-progress winning/losing read
      // using the latest available close price.
      const latestClose = candles[candles.length - 1].close;
      const inProgressStatus = checkInProgressStatus(setup, latestClose);
      setupStoreRef.updateSetupOutcome(setup.id, inProgressStatus, null);
    } catch (err) {
      console.error(`[OutcomeTracker] Error checking setup ${setup.id} (${setup.symbol}):`, err.message);
    }
  }
}

module.exports = { updatePendingOutcomes, checkOutcome, checkFinalOutcome, checkInProgressStatus };
      
