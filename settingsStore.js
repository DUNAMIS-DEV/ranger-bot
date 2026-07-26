/**
 * Settings store for the RANGER-only bot. Persisted to disk so settings
 * survive a server restart (as long as Render doesn't wipe the
 * filesystem — keep it pinged to avoid that during active use).
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const DEFAULT_PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'NZD/USD', 'GBP/JPY'];

const DEFAULT_SETTINGS = {
  enabled: true,
  pairs: DEFAULT_PAIRS,
  pollIntervalMs: 30 * 60 * 1000, // 30 min — safe for 7 pairs x 2 timeframes on Twelve Data's 8/min, 800/day free plan
  swingLookback: 2,
  minCandlesRequired: 30,
  fvgRecencyWindow: 15,
  sweepLookback: 30,
  maxStopLossPipsEnabled: false,
  maxStopLossPips: 30,
  telegram: {
    enabled: true,
    dedupeWindowMinutes: 30,
  },
};

/**
 * Given a pair count, calculate the MINIMUM safe poll interval (in ms)
 * that stays under both the 8-req/min and 800-req/day Twelve Data
 * limits. RANGER needs 2 timeframes per pair per check.
 */
function minSafeIntervalMs(pairCount) {
  const combosPerCheck = pairCount * 2; // 1h + 5min per pair
  const minutesFor8PerMin = Math.ceil(combosPerCheck / 8); // spreading combosPerCheck calls at 8/min takes this many minutes minimum
  const minutesFor800PerDay = Math.ceil((combosPerCheck * 24 * 60) / 800); // combos-per-day / 800 budget
  const safeMinutes = Math.max(minutesFor8PerMin, minutesFor800PerDay, 5); // never faster than 5 min regardless
  return safeMinutes * 60 * 1000;
}

function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return structuredClone(DEFAULT_SETTINGS);
  }
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse settings.json, falling back to defaults:', err.message);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let currentSettings = loadSettings();

function getSettings() {
  return currentSettings;
}

/**
 * Update settings. If pairs changes OR pollIntervalMs is set below the
 * safe minimum for the current pair count, the interval is automatically
 * bumped up to the safe minimum — this can't be bypassed by accident,
 * matching the safety idea from the reference bot we reviewed (it
 * auto-enforced a minimum interval from pair count, which is a good
 * guardrail worth keeping).
 */
function updateSettings(updates) {
  currentSettings = { ...currentSettings, ...updates };

  const safeMinMs = minSafeIntervalMs(currentSettings.pairs.length);
  if (currentSettings.pollIntervalMs < safeMinMs) {
    currentSettings.pollIntervalMs = safeMinMs;
    currentSettings._intervalAutoAdjusted = true;
  } else {
    currentSettings._intervalAutoAdjusted = false;
  }

  saveSettings(currentSettings);
  return currentSettings;
}

function updateTelegramSettings(updates) {
  currentSettings.telegram = { ...currentSettings.telegram, ...updates };
  saveSettings(currentSettings);
  return currentSettings.telegram;
}

function resetToDefaults() {
  currentSettings = structuredClone(DEFAULT_SETTINGS);
  saveSettings(currentSettings);
  return currentSettings;
}

module.exports = {
  getSettings,
  updateSettings,
  updateTelegramSettings,
  resetToDefaults,
  minSafeIntervalMs,
  DEFAULT_SETTINGS,
};
