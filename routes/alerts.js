'use strict';
const fetch = require('node-fetch');
const { logAlert } = require('../db/database');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000', 10);

// Track status tiap router
const routerStatus = {};

// ─── Send Telegram message (exported for history.js) ─────────────────────────
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[Alert] TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID tidak dikonfigurasi.');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.description || JSON.stringify(json));
    console.log('[Alert] Telegram terkirim:', text.substring(0, 60));
    return { ok: true };
  } catch (err) {
    console.error('[Alert] Gagal kirim Telegram:', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Build UP/DOWN message ────────────────────────────────────────────────────
function buildMessage(type, routerIp) {
  const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const icon = type === 'DOWN' ? '🔴' : '🟢';
  const state = type === 'DOWN' ? 'OFFLINE / DOWN' : 'ONLINE / UP';
  return (
    `${icon} <b>MikroTik Router ${state}</b>\n\n` +
    `<b>Router IP:</b> <code>${routerIp}</code>\n` +
    `<b>Waktu:</b> ${ts}\n` +
    `<b>Sistem:</b> 2Arah Tech — MikroTik Dashboard\n\n` +
    (type === 'DOWN'
      ? `Router tidak dapat dijangkau. Tim NOC harap segera cek koneksi.`
      : `Router kembali online dan dapat dijangkau.`)
  );
}

// ─── Check single router ──────────────────────────────────────────────────────
async function checkRouter(routerIp, { mikrotikFetch }) {
  let online = false;
  // Retry mechanism for false positives over VPN
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await mikrotikFetch(routerIp, '/rest/system/identity');
      online = true;
      break; // Success
    } catch (_) {
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }

  const prev = routerStatus[routerIp];
  if (prev === false && online === true) {
    console.log(`[Alert] Router ${routerIp} KEMBALI ONLINE`);
    const msg = buildMessage('UP', routerIp);
    await sendTelegram(msg);
    logAlert('UP', routerIp, msg);
  }
  if (online === false && prev !== false) {
    console.log(`[Alert] Router ${routerIp} DOWN`);
    const msg = buildMessage('DOWN', routerIp);
    await sendTelegram(msg);
    logAlert('DOWN', routerIp, msg);
  }
  routerStatus[routerIp] = online;
  return online;
}

// ─── Express router ───────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();

router.get('/status', (req, res) => {
  const routerIp = req.session.routerIp;
  const online = routerStatus[routerIp];
  return res.json({ routerIp, online: online !== false, lastStatus: online });
});

const { getRecentAlerts } = require('../db/database');
router.get('/log', (req, res) => {
  return res.json(getRecentAlerts());
});

router.post('/test', async (req, res) => {
  const routerIp = req.session.routerIp || 'unknown';
  const result = await sendTelegram(
    ` <b>Test Notifikasi — 2Arah Tech Dashboard</b>\n\n` +
    `Notifikasi Telegram berhasil dikonfigurasi!\n` +
    ` Router: <code>${routerIp}</code>\n` +
    ` ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
  );
  if (result && !result.ok) {
    return res.status(400).json({ error: result.error, solution: "Pastikan Token BOT diawali angka, dan Chat-ID valid tanpa spasi berlebih." });
  }
  return res.json({ ok: true });
});

// ─── Start health monitor (with threshold checking) ───────────────────────────
function startHealthMonitor(mikrotikFetch, checkThresholds) {
  console.log(`[Alert] Health monitor dimulai — interval ${INTERVAL}ms`);

  setInterval(async () => {
    const uniqueIps = Object.keys(routerStatus);
    for (const ip of uniqueIps) {
      const online = await checkRouter(ip, { mikrotikFetch });
      if (!online || !checkThresholds) continue;

      // Fetch resources + health for threshold checking
      try {
        const [res, health] = await Promise.all([
          mikrotikFetch(ip, '/rest/system/resource').catch(() => ({})),
          mikrotikFetch(ip, '/rest/system/health').catch(() => []),
        ]);

        const cpuLoad = parseInt(res['cpu-load'] || 0);
        let cpuTemp = null, boardTemp = null;

        if (Array.isArray(health)) {
          health.forEach(item => {
            const n = (item.name || '').toLowerCase();
            const v = parseFloat(item.value);
            if (n.includes('cpu-temperature')) cpuTemp = v;
            else if (n.includes('board-temperature') || n === 'temperature') boardTemp = v;
          });
        } else if (health && typeof health === 'object') {
          cpuTemp = parseFloat(health['cpu-temperature'] || NaN) || null;
          boardTemp = parseFloat(health['board-temperature'] || health['temperature'] || NaN) || null;
        }

        await checkThresholds({ cpuLoad, cpuTemp, boardTemp, routerIp: ip, sendTelegram });

        // Record traffic for history
        try {
          const ifaces = await mikrotikFetch(ip, '/rest/interface?running=true').catch(() => []);
          const names = ifaces.map(i => i.name).join(',');
          if (names) {
            const traffic = await mikrotikFetch(ip, '/rest/interface/monitor-traffic', {
              method: 'POST',
              body: JSON.stringify({ interface: names, duration: '1s', once: '' }),
            }).catch(() => []);
            let totalRx = 0, totalTx = 0;
            if (Array.isArray(traffic)) {
              traffic.forEach(e => {
                totalRx += parseInt(e['rx-bits-per-second'] || 0);
                totalTx += parseInt(e['tx-bits-per-second'] || 0);
              });
            }
            // Dynamic-require to avoid circular dep at init
            const { recordTraffic, recordUptime } = require('./history');
            recordTraffic(totalRx, totalTx);
            recordUptime(res['uptime'] || '');
          }
        } catch (_) { }
      } catch (_) { }
    }
  }, INTERVAL);
}

function registerRouter(routerIp) {
  if (!(routerIp in routerStatus)) {
    routerStatus[routerIp] = true;
    console.log(`[Alert] Router ${routerIp} didaftarkan untuk monitoring.`);
  }
}

module.exports = { router, startHealthMonitor, registerRouter, checkRouter, sendTelegram };
