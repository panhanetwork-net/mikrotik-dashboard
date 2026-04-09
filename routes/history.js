'use strict';

/**
 * History module — in-memory ring buffers for:
 * - Traffic history (rx/tx bps over time)
 * - Uptime events (router reboots)
 * - Threshold alert log
 */

const MAX_TRAFFIC_POINTS = 1440; // 24h at 1 poll/minute
const MAX_EVENTS         = 200;

// ─── Ring buffers ─────────────────────────────────────────────────────────────
const trafficHistory  = [];   // { ts, total: {rx,tx}, sfp: {rx,tx}, lacp: {rx,tx}, arah: {rx,tx} }
const uptimeEvents    = [];   // { ts, event:'start'|'reboot', uptimeStr }
const thresholdAlerts = [];   // { ts, type, value, threshold, routerIp }

// Track previous uptime seconds to detect reboots
let prevUptimeSeconds = null;

// Cooldown map: last send time per alert type (ms)
const alertCooldown = {}; // { 'cpu'|'cpu-temp'|'board-temp': lastSentMs }
const COOLDOWN_MS   = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pushCapped(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

function uptimeToSeconds(upStr) {
  if (!upStr) return 0;
  let s = 0;
  const wk = upStr.match(/(\d+)w/); if (wk) s += +wk[1] * 7 * 86400;
  const dy = upStr.match(/(\d+)d/); if (dy) s += +dy[1] * 86400;
  const hr = upStr.match(/(\d+)h/); if (hr) s += +hr[1] * 3600;
  const mn = upStr.match(/(\d+)m/); if (mn) s += +mn[1] * 60;
  const sc = upStr.match(/(\d+)s/); if (sc) s += +sc[1];
  return s;
}

// ─── Record traffic point ─────────────────────────────────────────────────────
function recordTraffic(totalRx, totalTx, sfpRx, sfpTx, lacpRx, lacpTx, arahRx, arahTx) {
  pushCapped(trafficHistory, {
    ts: Date.now(),
    total: { rx: totalRx, tx: totalTx },
    sfp:   { rx: sfpRx, tx: sfpTx },
    lacp:  { rx: lacpRx, tx: lacpTx },
    arah:  { rx: arahRx || 0, tx: arahTx || 0 }
  }, MAX_TRAFFIC_POINTS);
}

// ─── Record uptime + detect reboots ──────────────────────────────────────────
function recordUptime(uptimeStr) {
  const currentSec = uptimeToSeconds(uptimeStr);
  if (prevUptimeSeconds === null) {
    // First time — server started
    pushCapped(uptimeEvents, {
      ts: Date.now(),
      event: 'start',
      uptimeStr,
      label: 'Dashboard mulai monitoring'
    }, MAX_EVENTS);
  } else if (currentSec < prevUptimeSeconds - 30) {
    // Uptime went backwards > 30s → router rebooted
    pushCapped(uptimeEvents, {
      ts: Date.now(),
      event: 'reboot',
      uptimeStr,
      label: 'Router reboot terdeteksi'
    }, MAX_EVENTS);
  }
  prevUptimeSeconds = currentSec;
}

// ─── Threshold check & alert ─────────────────────────────────────────────────
async function checkThresholds({ cpuLoad, cpuTemp, boardTemp, routerIp, sendTelegram }) {
  const now = Date.now();

  const checks = [
    {
      key:       'cpu',
      value:     cpuLoad,
      threshold: 80,
      unit:      '%',
      label:     '🔥 CPU Load',
      emoji:     '⚡',
    },
    {
      key:       'cpu-temp',
      value:     cpuTemp,
      threshold: 75,
      unit:      '°C',
      label:     '🌡️ CPU Temperature',
      emoji:     '🔴',
    },
    {
      key:       'board-temp',
      value:     boardTemp,
      threshold: 60,
      unit:      '°C',
      label:     '🌡️ Board Temperature',
      emoji:     '🟠',
    },
  ];

  for (const check of checks) {
    if (check.value === null || isNaN(check.value)) continue;
    if (check.value <= check.threshold) continue;

    // Check cooldown
    const lastSent = alertCooldown[check.key] || 0;
    if (now - lastSent < COOLDOWN_MS) continue;

    // Record locally
    pushCapped(thresholdAlerts, {
      ts:        now,
      type:      check.key,
      label:     check.label,
      value:     check.value,
      threshold: check.threshold,
      unit:      check.unit,
      routerIp,
    }, MAX_EVENTS);

    alertCooldown[check.key] = now;

    // Send Telegram
    const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const msg =
      `${check.emoji} <b>Threshold Alert — ${check.label}</b>\n\n` +
      `📡 <b>Router:</b> <code>${routerIp}</code>\n` +
      `📊 <b>Nilai saat ini:</b> ${check.value.toFixed(1)}${check.unit}\n` +
      `⚠️ <b>Batas:</b> ${check.threshold}${check.unit}\n` +
      `🕐 <b>Waktu:</b> ${ts}\n` +
      `🔧 <b>Sistem:</b> 2Arah Tech — MikroTik Dashboard`;

    console.log(`[Threshold] ${check.label} = ${check.value}${check.unit} > ${check.threshold}${check.unit} — Telegram dikirim`);
    await sendTelegram(msg).catch(e => console.error('[Threshold] Telegram error:', e.message));
  }
}

// ─── Express router ───────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

router.get('/traffic', (req, res) => {
  // Return last 288 points (e.g., 24h at 5min interval) or all
  return res.json(trafficHistory.slice(-288));
});

router.get('/uptime', (req, res) => {
  return res.json([...uptimeEvents].reverse()); // newest first
});

router.get('/threshold-alerts', (req, res) => {
  return res.json([...thresholdAlerts].reverse()); // newest first
});

module.exports = { router, recordTraffic, recordUptime, checkThresholds };
