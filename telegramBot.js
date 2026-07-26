/**
 * Telegram alert sender. Requires TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID environment variables. If either is missing,
 * alerts are silently skipped (logged to console instead) so the
 * rest of the app still runs fine without Telegram configured.
 */

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function formatSetupMessage(setup) {
  const directionEmoji = setup.direction === 'buy' ? '🟢 BUY' : '🔴 SELL';
  const fmt = (n) => (typeof n === 'number' ? n.toFixed(5) : n);

  return [
    `*[${setup.strategy}] ${setup.symbol}*`,
    `${directionEmoji} — ${setup.timeframe}`,
    ``,
    `Entry: \`${fmt(setup.entry)}\``,
    `Stop Loss: \`${fmt(setup.stopLoss)}\``,
    `Take Profit: \`${fmt(setup.takeProfit)}\``,
    ``,
    `${setup.reason}`,
    ``,
    `_${new Date(setup.time || setup.createdAt).toLocaleString()}_`,
  ].join('\n');
}

async function sendSetupAlert(setup) {
  if (!isConfigured()) {
    console.log('[Telegram] Not configured — skipping alert for', setup.strategy, setup.symbol);
    return { sent: false, reason: 'not_configured' };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const message = formatSetupMessage(setup);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error('[Telegram] Send failed:', json.description);
      return { sent: false, reason: json.description };
    }
    return { sent: true };
  } catch (err) {
    console.error('[Telegram] Error sending alert:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendSetupAlert, isConfigured, formatSetupMessage };
