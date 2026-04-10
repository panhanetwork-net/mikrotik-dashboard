'use strict';
const express       = require('express');
const { runCommand} = require('./routeros-api');
const fs            = require('fs');
const path          = require('path');
const router        = express.Router();

// ─── Config ─────────────────────────────────────────────────────────────────
const PING_INTERVAL     = 15000;          // 15s
const ALERT_COOLDOWN    = 5 * 60 * 1000; // 5 min between repeat alerts while RTO
const ALERT_REPEAT_EVERY = 5;            // send alert every N consecutive RTOs

// Reads PING_TARGET dynamically from .env each cycle so settings updates apply without restart
function getPingTarget() {
  try {
    const envPath = path.join(__dirname, '../.env');
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx < 0) continue;
      if (t.slice(0, idx).trim() === 'PING_TARGET') {
        return t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) {}
  return process.env.PING_TARGET || '8.8.8.8';
}

// ─── State ──────────────────────────────────────────────────────────────────
let pingStatus = {
  target:          null,
  online:          null,
  consecutiveRTO:  0,
  totalRTO:        0,
  totalSuccess:    0,
  lastSuccess:     null,
  lastRTO:         null,
  lastAlertAt:     null,
  lastRTODetail:   null,
};

// ─── RouterOS API helpers ────────────────────────────────────────────────────
function apiConn() {
  const host = (process.env.MIKROTIK_HOST || '').split(':')[0];
  const port = parseInt(process.env.MIKROTIK_API_PORT || '56988');
  const user = process.env.MIKROTIK_USER || '';
  const pass = process.env.MIKROTIK_PASS || '';
  return { host, port, user, pass };
}

// ─── Telegram helper ─────────────────────────────────────────────────────────
async function sendTelegram(msg) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const fetch = require('node-fetch');
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
    });
  } catch (_) {}
}

// ─── Ping via RouterOS API ────────────────────────────────────────────────────
// Runs /ping on the router itself so it can reach internal IPs (e.g. 192.168.22.3)
async function runPing() {
  const now = Date.now();
  const PING_TARGET = getPingTarget();
  pingStatus.target = PING_TARGET; // sync for status endpoint
  try {
    const { host, port, user, pass } = apiConn();
    if (!host) return; // not configured yet

    const rows = await runCommand(host, port, user, pass, '/ping', [
      `=address=${PING_TARGET}`,
      '=count=3',
      '=interval=0.2',
    ]);

    // Row format: { sent, received, packet-loss, min-rtt, avg-rtt, max-rtt }
    const last = rows[rows.length - 1] || {};
    const received = parseInt(last.received || '0');
    const sent     = parseInt(last.sent || '3');
    const ok = received > 0;

    if (ok) {
      // ── Sukses ──────────────────────────────────────────────────────────
      const wasRTO = pingStatus.online === false;
      pingStatus.online        = true;
      pingStatus.totalSuccess++;
      pingStatus.lastSuccess   = now;

      if (wasRTO) {
        const msg =
          `\u2705 <b>PING Pulih \u2014 ${PING_TARGET}</b>\n` +
          `Koneksi kembali normal setelah ${pingStatus.consecutiveRTO}x RTO\n` +
          `Pulih pada: ${new Date(now).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
        await sendTelegram(msg);
        pingStatus.lastAlertAt = now;
      }
      pingStatus.consecutiveRTO = 0;
      pingStatus.lastRTODetail  = null;

    } else {
      // ── RTO ─────────────────────────────────────────────────────────────
      const wasOnline = pingStatus.online;
      pingStatus.online         = false;
      pingStatus.consecutiveRTO++;
      pingStatus.totalRTO++;
      pingStatus.lastRTO        = now;
      pingStatus.lastRTODetail  = `RTO ke-${pingStatus.consecutiveRTO} pada ${new Date(now).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;

      const shouldAlert =
        wasOnline !== false ||
        pingStatus.consecutiveRTO % ALERT_REPEAT_EVERY === 0 ||
        !pingStatus.lastAlertAt ||
        (now - pingStatus.lastAlertAt) >= ALERT_COOLDOWN;

      if (shouldAlert) {
        pingStatus.lastAlertAt = now;
        const sinceStr = pingStatus.lastSuccess
          ? `Terakhir berhasil: ${new Date(pingStatus.lastSuccess).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
          : 'Belum pernah berhasil sejak monitoring dimulai';
        const msg =
          `\u26a0\ufe0f <b>PING RTO \u2014 ${PING_TARGET}</b>\n` +
          `RTO berturut-turut: <b>${pingStatus.consecutiveRTO}x</b>\n` +
          `Total RTO: ${pingStatus.totalRTO}\n` +
          `${sinceStr}`;
        await sendTelegram(msg);
      }
    }
  } catch (err) {
    // If API itself fails (router unreachable) treat as RTO too
    const wasOnline = pingStatus.online;
    pingStatus.online         = false;
    pingStatus.consecutiveRTO++;
    pingStatus.totalRTO++;
    pingStatus.lastRTO        = now;
    pingStatus.lastRTODetail  = `API error: ${err.message}`;
    console.error('[Ping] API error:', err.message);

    if (wasOnline !== false && pingStatus.lastAlertAt === null) {
      pingStatus.lastAlertAt = now;
      await sendTelegram(
        `\u26a0\ufe0f <b>PING Monitor Error</b>\n` +
        `Tidak dapat menjangkau router untuk ping ${PING_TARGET}\n` +
        `Error: ${err.message}`
      );
    }
  }
}

// ─── Start monitor ────────────────────────────────────────────────────────────
function startPingMonitor() {
  console.log(`  [Ping] Monitoring ${getPingTarget()} via RouterOS API setiap ${PING_INTERVAL / 1000}s (target dinamis dari .env)`);
  runPing();
  setInterval(runPing, PING_INTERVAL);
}

// ─── GET /api/ping/status ─────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    target:         pingStatus.target,
    online:         pingStatus.online,
    consecutiveRTO: pingStatus.consecutiveRTO,
    totalRTO:       pingStatus.totalRTO,
    totalSuccess:   pingStatus.totalSuccess,
    lastSuccess:    pingStatus.lastSuccess,
    lastRTO:        pingStatus.lastRTO,
    lastRTODetail:  pingStatus.lastRTODetail,
  });
});

module.exports = { router, startPingMonitor };
