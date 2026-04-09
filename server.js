'use strict';
// Manual .env loader — no dotenv package required
const fs = require('fs'), path = require('path');
try {
  const envPath = path.join(__dirname, '.env');
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx < 0) continue;
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
} catch (_) { }

const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);

const authRouter = require('./routes/auth');
const { router: mikrotikRouter, mikrotikFetch } = require('./routes/mikrotik');
const { router: alertsRouter, startHealthMonitor,
  registerRouter } = require('./routes/alerts');
const { router: historyRouter, checkThresholds } = require('./routes/history');
const { router: pingRouter, startPingMonitor } = require('./routes/ping');
const snmpRouter = require('./routes/snmp-poller');
const settingsRouter = require('./routes/settings');
const requireAuth = require('./middleware/requireAuth');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new MemoryStore({ checkPeriod: 24 * 60 * 60 * 1000 }), // 24 hours checks
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));

app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', authRouter);

app.use((req, res, next) => {
  if (req.session && req.session.routerIp) registerRouter(req.session.routerIp);
  next();
});

app.use('/api/mikrotik', requireAuth, mikrotikRouter);
app.use('/api/alerts', requireAuth, alertsRouter);
app.use('/api/history', requireAuth, historyRouter);
app.use('/api/ping', requireAuth, pingRouter);
app.use('/api/snmp', requireAuth, snmpRouter);
app.use('/api/settings', requireAuth, settingsRouter);

// ─── Technitium DNS Proxy ───────────────────────────────────────────────────
app.get('/api/technitium/chart', requireAuth, async (req, res) => {
  try {
    const dURL = process.env.TECHNITIUM_URL;
    const token = process.env.TECHNITIUM_TOKEN;
    if (!dURL || !token) return res.status(500).json({ error: 'Technitium ENV not set' });

    const u = `${dURL}/api/dashboard/stats/get?token=${token}&type=lastHour`;
    const resp = await fetch(u);

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API Error ${resp.status}: ${errText}`);
    }
    const j = await resp.json();
    return res.json(j);
  } catch (err) {
    console.error('[Technitium] Proxy Error:', err.message);
    return res.status(502).json({ error: err.message });
  }
});

// ─── Pages ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/dhcp', requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dhcp.html')));

app.get('/connections', requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'connections.html')));

// ─── 404 / Error ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  2Arah Tech — MikroTik Dashboard`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Server berjalan di http://localhost:${PORT}`);
  console.log(`  Telegram alerts: ${process.env.TELEGRAM_BOT_TOKEN ? 'AKTIF' : 'TIDAK DIKONFIGURASI'}`);
  console.log(`  ─────────────────────────────────────\n`);

  startHealthMonitor(mikrotikFetch, checkThresholds);
  startPingMonitor();
  startTrafficRecorder();
});

// ─── Traffic Recorder (fills /api/history/traffic ring buffer) ────────────────
const { runCommand } = require('./routes/routeros-api');
const { recordTraffic, recordUptime } = require('./routes/history');

async function trafficSnapshot() {
  try {
    const host = (process.env.MIKROTIK_HOST || '').split(':')[0];
    const port = parseInt(process.env.MIKROTIK_API_PORT || '56988');
    const user = process.env.MIKROTIK_USER || '';
    const pass = process.env.MIKROTIK_PASS || '';

    const [resRows, ifaces] = await Promise.all([
      runCommand(host, port, user, pass, '/system/resource/print'),
      runCommand(host, port, user, pass, '/interface/print'),
    ]);

    const running = ifaces
      .filter(i => i.running === 'true' && !(i.type || '').toLowerCase().startsWith('pppoe'))
      .map(i => i.name)
      .slice(0, 100);

    let rx = 0, tx = 0, sfpRx = 0, sfpTx = 0, lacpRx = 0, lacpTx = 0, arahRx = 0, arahTx = 0;

    if (running.length) {
      const pMain = runCommand(host, port, user, pass, '/interface/monitor-traffic', [
        `=interface=${running.join(',')}`,
        '=once=',
      ]).catch(e => ({ error: e }));

      // The user requested LACP polling to .42 x86
      const brsHost = process.env.BRS_HOST || '157.66.36.42';
      const brsApiPort = parseInt(process.env.BRS_API_PORT || '8233');
      const brsUser = process.env.BRS_USER || process.env.MIKROTIK_USER || 'admin';
      const brsPass = process.env.BRS_PASS || process.env.MIKROTIK_PASS || 'PNS321';

      const pBrs = runCommand(brsHost, brsApiPort, brsUser, brsPass, '/interface/print').then(swIfaces => {
        if (!Array.isArray(swIfaces)) return [];
        const running = swIfaces.filter(i => i.running === 'true').map(i => i.name).slice(0, 50);
        if (!running.length) return [];
        return runCommand(brsHost, brsApiPort, brsUser, brsPass, '/interface/monitor-traffic', [
          `=interface=${running.join(',')}`,
          '=once=',
        ]).catch(e => ({ error: e }));
      }).catch(e => ({ error: e }));

      const swHost = process.env.SW_HOST || '192.20.40.2';
      const swApiPort = parseInt(process.env.SW_API_PORT || '8728');
      const swUser = process.env.SW_USER || process.env.MIKROTIK_USER || 'admin';
      const swPass = process.env.SW_PASS || process.env.MIKROTIK_PASS || '';

      const pSw = runCommand(swHost, swApiPort, swUser, swPass, '/interface/print')
        .catch(e => ({ error: e })).then(async (swIfaces) => {
          if (swIfaces && swIfaces.error) return swIfaces;
          if (!Array.isArray(swIfaces)) return [];

          const swIfaceName = process.env.SW_INTERFACE || '';
          const target = swIfaces.find(i => {
            const n = (i.name || '').toUpperCase();
            const c = (i.comment || '').toUpperCase();
            return (swIfaceName && n === swIfaceName.toUpperCase()) ||
              n.includes('ARAH-BAROS') || c.includes('ARAH-BAROS') || c.includes('ARAH BAROS');
          });
          if (!target) return [];

          return runCommand(swHost, swApiPort, swUser, swPass, '/interface/monitor-traffic', [
            `=interface=${target.name}`,
            '=once=',
          ]).catch(e => ({ error: e }));
        });

      const [mainRes, brsRes, swRes] = await Promise.all([pMain, pBrs, pSw]);

      if (Array.isArray(mainRes) && !mainRes.error) {
        mainRes.forEach(e => {
          const nr = parseInt(e['rx-bits-per-second'] || 0);
          const nt = parseInt(e['tx-bits-per-second'] || 0);
          rx += nr;
          tx += nt;
          const n = e.name || '';
          if (n === 'A-sfp-sfplus-1') {
            sfpRx = nr; sfpTx = nt;
          }
        });
      } else {
        console.error('[Traffic] Main Router Error:', mainRes.reason);
      }

      if (Array.isArray(swRes) && !swRes.error) {
        swRes.forEach(e => {
          arahRx += parseInt(e['rx-bits-per-second'] || 0);
          arahTx += parseInt(e['tx-bits-per-second'] || 0);
        });
      } else if (swRes && swRes.error) {
        console.error('[Traffic] CRS-326 Switch Error:', swRes.error.message || swRes.error);
      }

      if (Array.isArray(brsRes) && !brsRes.error) {
        brsRes.forEach(e => {
          lacpRx += parseInt(e['rx-bits-per-second'] || 0);
          lacpTx += parseInt(e['tx-bits-per-second'] || 0);
        });
      } else if (brsRes.error) {
        console.error('[Traffic] BRS Router Error:', brsRes.error.message || brsRes.error);
      }
    }

    recordTraffic(rx, tx, sfpRx, sfpTx, lacpRx, lacpTx, arahRx, arahTx);
    if (resRows[0]) recordUptime(resRows[0].uptime || '');
  } catch (_) { }
}

function startTrafficRecorder() {
  console.log('  [History] Traffic recorder dimulai — interval 30s');
  trafficSnapshot();                        // first snapshot immediately
  setInterval(trafficSnapshot, 30 * 1000); // every 30s
}
