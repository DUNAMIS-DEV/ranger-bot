/**
 * Setup store — in-memory store of detected setups, RANGER-only bot.
 *
 * IMPORTANT — duplicate/conflicting setup prevention:
 * A reference implementation we reviewed had a real bug: its duplicate
 * check only blocked an exact repeat (same price within 0.0001, same
 * direction), so it would happily fire a SHORT and a LONG on the same
 * pair within minutes of each other as price wiggled slightly — visibly
 * contradicting itself (we saw this directly: USD/CAD showed 4
 * simultaneous conflicting setups in one screenshot).
 *
 * This store fixes that with TWO layers:
 *   1. Time-window dedupe (same as before): same symbol+strategy+direction
 *      within the configured dedupe window is blocked.
 *   2. DIRECTIONAL CONFLICT GUARD (new): if a symbol already has an
 *      OPEN setup (pending/winning/losing — not yet resolved) in one
 *      direction, a NEW setup in the OPPOSITE direction for the same
 *      symbol is rejected until the open one resolves to win/loss.
 *      A pair can still have multiple same-direction setups queue up
 *      (e.g. two separate BUY setups), but never a live BUY and SELL
 *      on the same pair at the same time.
 */

const MAX_SETUPS = 500;
let setups = [];
let idCounter = 1;

function dedupeKey(setup) {
  // Round entry to 4 decimal places (5 for JPY pairs where price scale
  // differs) so near-identical re-detections of the SAME setup are
  // still caught, but genuinely different setups (different entry
  // price) are correctly treated as distinct, not falsely blocked.
  const decimals = setup.symbol.includes('JPY') ? 2 : 4;
  const roundedEntry = Number(setup.entry).toFixed(decimals);
  return `${setup.symbol}_${setup.strategy}_${setup.direction}_${roundedEntry}`;
}

function isOpen(setup) {
  return setup.outcome === 'pending' || setup.outcome === 'winning' || setup.outcome === 'losing';
}

/**
 * Add a new setup if it passes both guards. Returns the stored setup,
 * or null if it was rejected (dedupe or directional conflict).
 */
function addSetup(setup, dedupeWindowMinutes = 30) {
  const now = Date.now();
  const windowMs = dedupeWindowMinutes * 60 * 1000;

  // Guard 1: time-window dedupe (same symbol+strategy+direction recently).
  const key = dedupeKey(setup);
  const recentDuplicate = setups.find(
    (s) => dedupeKey(s) === key && now - new Date(s.createdAt).getTime() < windowMs
  );
  if (recentDuplicate) return null;

  // Guard 2: directional conflict — reject if this symbol already has
  // an OPEN setup in the opposite direction.
  const opposingOpenSetup = setups.find(
    (s) => s.symbol === setup.symbol && s.direction !== setup.direction && isOpen(s)
  );
  if (opposingOpenSetup) return null;

  const stored = {
    id: idCounter++,
    ...setup,
    outcome: 'pending', // pending | winning | losing | win | loss
    outcomeTime: null,
    manuallyEdited: false,
    createdAt: new Date().toISOString(),
  };

  setups.unshift(stored);
  if (setups.length > MAX_SETUPS) {
    setups = setups.slice(0, MAX_SETUPS);
  }

  return stored;
}

function updateSetupOutcome(id, outcome, outcomeTime) {
  const setup = setups.find((s) => s.id === id);
  if (!setup) return null;
  setup.outcome = outcome;
  if (outcomeTime) setup.outcomeTime = outcomeTime;
  return setup;
}

function updateSetupLevels(id, { stopLoss, takeProfit, entry } = {}) {
  const setup = setups.find((s) => s.id === id);
  if (!setup) return { error: 'Setup not found' };
  if (setup.outcome === 'win' || setup.outcome === 'loss') {
    return { error: 'Cannot edit a setup that has already resolved to win/loss' };
  }
  if (stopLoss !== undefined) {
    if (typeof stopLoss !== 'number' || Number.isNaN(stopLoss)) {
      return { error: 'Stop loss must be a valid number' };
    }
    setup.stopLoss = stopLoss;
  }
  if (takeProfit !== undefined) {
    if (typeof takeProfit !== 'number' || Number.isNaN(takeProfit)) {
      return { error: 'Take profit must be a valid number' };
    }
    setup.takeProfit = takeProfit;
  }
  if (entry !== undefined) {
    if (typeof entry !== 'number' || Number.isNaN(entry)) {
      return { error: 'Entry must be a valid number' };
    }
    setup.entry = entry;
  }
  setup.manuallyEdited = true;
  return setup;
}

function deleteSetup(id) {
  const before = setups.length;
  setups = setups.filter((s) => s.id !== id);
  return setups.length < before;
}

function getSetups({ symbol, outcome, limit = 100 } = {}) {
  let result = setups;
  if (symbol) result = result.filter((s) => s.symbol === symbol);
  if (outcome) result = result.filter((s) => s.outcome === outcome);
  return result.slice(0, limit);
}

function getStats() {
  const resolved = setups.filter((s) => s.outcome === 'win' || s.outcome === 'loss');
  const wins = resolved.filter((s) => s.outcome === 'win').length;
  const losses = resolved.filter((s) => s.outcome === 'loss').length;
  const winningNow = setups.filter((s) => s.outcome === 'winning').length;
  const losingNow = setups.filter((s) => s.outcome === 'losing').length;
  const pending = setups.filter((s) => s.outcome === 'pending').length;

  const perPair = {};
  for (const s of setups) {
    if (!perPair[s.symbol]) {
      perPair[s.symbol] = { wins: 0, losses: 0, winningNow: 0, losingNow: 0, pending: 0, total: 0 };
    }
    perPair[s.symbol].total++;
    if (s.outcome === 'win') perPair[s.symbol].wins++;
    else if (s.outcome === 'loss') perPair[s.symbol].losses++;
    else if (s.outcome === 'winning') perPair[s.symbol].winningNow++;
    else if (s.outcome === 'losing') perPair[s.symbol].losingNow++;
    else perPair[s.symbol].pending++;
  }

  return {
    total: setups.length,
    wins,
    losses,
    winningNow,
    losingNow,
    pending,
    winRate: resolved.length > 0 ? (wins / resolved.length) * 100 : null,
    perPair,
  };
}

function clearSetups() {
  setups = [];
}

module.exports = {
  addSetup,
  getSetups,
  updateSetupOutcome,
  updateSetupLevels,
  deleteSetup,
  getStats,
  clearSetups,
};
    
