'use strict';

/**
 * History module — in-memory ring buffers for:
 * - Traffic history (rx/tx bps over time)
 * - Uptime events (router reboots)
 * - Threshold alert log
 */

const MAX_TRAFFIC_POINTS = 1440; // 24h at 1 poll/minute
const MAX_EVENTS         = 200;

// â”€â”€â”€ Ring buffers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const trafficHistory  = [];   // { ts, total: {rx,tx}, sfp: {rx,tx}, lacp: {rx,tx}, arah: {rx,tx} }
const uptimeEvents    = [];   // { ts, event:'start'|'reboot', uptimeStr }
const thresholdAlerts = [];   // { ts, type, value, threshold, routerIp }

// Track previous uptime seconds to detect reboots
let prevUptimeSeconds = null;

// Cooldown map: last send time per alert type (ms)
const alertCooldown = {}; // { 'cpu'|'cpu-temp'|'board-temp': lastSentMs }
const COOLDOWN_MS   = 5 * 60 * 1000; // 5 minutes

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Record traffic point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function recordTraffic(totalRx, totalTx, customGraphs) {
  pushCapped(trafficHistory, {
    ts: Date.now(),
    total: { rx: totalRx, tx: totalTx },
    custom: customGraphs || [] // Array of { id, rx, tx }
  }, MAX_TRAFFIC_POINTS);
}

// â”€â”€â”€ Record uptime + detect reboots â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // Uptime went backwards > 30s â†’ router rebooted
    pushCapped(uptimeEvents, {
      ts: Date.now(),
      event: 'reboot',
      uptimeStr,
      label: 'Router reboot terdeteksi'
    }, MAX_EVENTS);
  }
  prevUptimeSeconds = currentSec;
}

// â”€â”€â”€ Threshold check & alert â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function checkThresholds({ cpuLoad, cpuTemp, boardTemp, routerIp, sendTelegram }) {
  const now = Date.now();

  const checks = [
    {
      key:       'cpu',
      value:     cpuLoad,
      threshold: 80,
      unit:      '%',
      label:     'ðŸ”¥ CPU Load',
      emoji:     'âš¡',
    },
    {
      key:       'cpu-temp',
      value:     cpuTemp,
      threshold: 75,
      unit:      'Â°C',
      label:     'ðŸŒ¡ï¸ CPU Temperature',
      emoji:     'ðŸ”´',
    },
    {
      key:       'board-temp',
      value:     boardTemp,
      threshold: 60,
      unit:      'Â°C',
      label:     'ðŸŒ¡ï¸ Board Temperature',
      emoji:     'ðŸŸ ',
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
      `ðŸ“¡ <b>Router:</b> <code>${routerIp}</code>\n` +
      `ðŸ“Š <b>Nilai saat ini:</b> ${check.value.toFixed(1)}${check.unit}\n` +
      `âš ï¸ <b>Batas:</b> ${check.threshold}${check.unit}\n` +
      `ðŸ• <b>Waktu:</b> ${ts}\n` +
      `ðŸ”§ <b>Sistem:</b> Panha Network — MikroTik Dashboard`;

    console.log(`[Threshold] ${check.label} = ${check.value}${check.unit} > ${check.threshold}${check.unit} — Telegram dikirim`);
    await sendTelegram(msg).catch(e => console.error('[Threshold] Telegram error:', e.message));
  }
}

// â”€â”€â”€ Express router â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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


