/**
 * RANGER-only Forex Signal Bot server.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const { getSettings, updateSettings, updateTelegramSettings, resetToDefaults, minSafeIntervalMs } = require('./settingsStore');
const setupStore = require('./setupStore');
const { startRunner, stopRunner, runOnce, getRunnerStatus } = require('./runner');
const marketData = require('./marketData');

const PORT = process.env.PORT || 3001;

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // ---- Settings ----
  if (req.method === 'GET' && pathname === '/api/settings') {
    return sendJson(res, 200, getSettings());
  }

  if (req.method === 'PATCH' && pathname === '/api/settings') {
    const body = await readBody(req);
    const updated = updateSettings(body);
    return sendJson(res, 200, updated);
  }

  if (req.method === 'PATCH' && pathname === '/api/settings/telegram') {
    const body = await readBody(req);
    const updated = updateTelegramSettings(body);
    return sendJson(res, 200, updated);
  }

  if (req.method === 'POST' && pathname === '/api/settings/reset') {
    return sendJson(res, 200, resetToDefaults());
  }

  // ---- Setups ----
  if (req.method === 'GET' && pathname === '/api/setups') {
    const symbol = url.searchParams.get('symbol') || undefined;
    const outcome = url.searchParams.get('outcome') || undefined;
    const limit = url.searchParams.get('limit');
    return sendJson(res, 200, setupStore.getSetups({ symbol, outcome, limit: limit ? parseInt(limit) : undefined }));
  }

  if (req.method === 'DELETE' && pathname === '/api/setups') {
    setupStore.clearSetups();
    return sendJson(res, 200, { cleared: true });
  }

  const setupIdMatch = pathname.match(/^\/api\/setups\/(\d+)$/);
  if (req.method === 'PATCH' && setupIdMatch) {
    const id = parseInt(setupIdMatch[1]);
    const body = await readBody(req);
    const result = setupStore.updateSetupLevels(id, body);
    if (result && result.error) return sendJson(res, 400, result);
    if (!result) return sendJson(res, 404, { error: 'Setup not found' });
    return sendJson(res, 200, result);
  }
  if (req.method === 'DELETE' && setupIdMatch) {
    const id = parseInt(setupIdMatch[1]);
    const deleted = setupStore.deleteSetup(id);
    return sendJson(res, deleted ? 200 : 404, { deleted });
  }

  // ---- Stats ----
  if (req.method === 'GET' && pathname === '/api/stats') {
    return sendJson(res, 200, setupStore.getStats());
  }

  // ---- Runner control ----
  if (req.method === 'POST' && pathname === '/api/runner/run-once') {
    const log = await runOnce();
    return sendJson(res, 200, { log });
  }
  if (req.method === 'GET' && pathname === '/api/runner/status') {
    return sendJson(res, 200, { ...getRunnerStatus(), liveMode: marketData.isLiveMode() });
  }
  if (req.method === 'POST' && pathname === '/api/runner/start') {
    startRunner();
    return sendJson(res, 200, { started: true });
  }
  if (req.method === 'POST' && pathname === '/api/runner/stop') {
    stopRunner();
    return sendJson(res, 200, { stopped: true });
  }

  // ---- Rate limit info (shown in the UI header) ----
  if (req.method === 'GET' && pathname === '/api/ratelimit-info') {
    const settings = getSettings();
    const combosPerCheck = settings.pairs.length * 2;
    const safeIntervalMs = minSafeIntervalMs(settings.pairs.length);
    return sendJson(res, 200, {
      pairs: settings.pairs.length,
      combosPerCheck,
      currentIntervalMinutes: settings.pollIntervalMs / 60000,
      minSafeIntervalMinutes: safeIntervalMs / 60000,
      estimatedRequestsPerDay: Math.round(combosPerCheck * (24 * 60 * 60 * 1000) / settings.pollIntervalMs),
    });
  }

  // ---- Serve the dashboard (index.html at repo root) ----
  // Supports both GET (full page) and HEAD (headers only, no body —
  // this is what uptime-monitoring services like UptimeRobot send by
  // default; without this, every ping would 404 even though the server
  // is genuinely up and fine).
  if (req.method === 'GET' || req.method === 'HEAD') {
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);
    return fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404);
        return res.end(req.method === 'HEAD' ? undefined : 'Not found');
      }
      const ext = path.extname(filePath);
      const contentType = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`RANGER bot server running on port ${PORT}`);
  console.log(`Live mode: ${marketData.isLiveMode() ? 'YES (Twelve Data)' : 'NO (using mock data)'}`);
  startRunner();
});
        
