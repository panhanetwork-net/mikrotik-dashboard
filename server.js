'use strict';
// Manual .env loader — no dotenv package required
const fs = require('fs'), path = require('path');
try {
  const envPath = path.join(__dirname, '.env');
  let envRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  // Bootstrap default Legacy Custom Graphs if none exist out of the box
  if (!envRaw.includes('CUSTOM_GRAPH_')) {
    const defaults = `\n# Default Legacy Graphs\nCUSTOM_GRAPH_1_DEV=MAIN\nCUSTOM_GRAPH_1_IFACE=A-sfp-sfplus-1\nCUSTOM_GRAPH_1_TITLE=A-sfp-sfplus-1 Traffic\nCUSTOM_GRAPH_2_DEV=BRS\nCUSTOM_GRAPH_2_IFACE=ether1\nCUSTOM_GRAPH_2_TITLE=LACP X86 Traffic\nCUSTOM_GRAPH_3_DEV=MAIN\nCUSTOM_GRAPH_3_IFACE=ether1\nCUSTOM_GRAPH_3_TITLE=ARAH-BAROS Traffic\n`;
    fs.appendFileSync(envPath, defaults);
    envRaw += defaults;
  }

  const lines = envRaw.split('\n');
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

// â”€â”€â”€ Middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use('/api', authRouter);

app.use((req, res, next) => {
  if (req.session && req.session.routerIp) registerRouter(req.session.routerIp);
  next();
});

// â”€â”€â”€ Public Config (no auth required — registered BEFORE requireAuth) â”€â”€â”€â”€â”€
app.get('/api/mikrotik/public-config', (req, res) => {
  const customGraphs = [];
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^CUSTOM_GRAPH_([A-Z0-9_]+)_DEV$/);
    if (match) {
      const id = match[1];
      customGraphs.push({
        id,
        dev:   process.env[key],
        iface: process.env[`CUSTOM_GRAPH_${id}_IFACE`] || '',
        title: process.env[`CUSTOM_GRAPH_${id}_TITLE`] || `Graph ${id}`,
      });
    }
  }
  res.json({
    interval: parseInt(process.env.POLL_INTERVAL || '3000'),
    graphs: customGraphs,
  });
});

app.use('/api/mikrotik', requireAuth, mikrotikRouter);
app.use('/api/alerts', requireAuth, alertsRouter);
app.use('/api/history', requireAuth, historyRouter);
app.use('/api/ping', requireAuth, pingRouter);
app.use('/api/snmp', requireAuth, snmpRouter);
app.use('/api/settings', requireAuth, settingsRouter);

// â”€â”€â”€ Technitium DNS Proxy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Pages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ 404 / Error â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// â”€â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.listen(PORT, () => {
  console.log(`\n  Panha Network — MikroTik Dashboard`);
  console.log(`  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);
  console.log(`  Server berjalan di http://localhost:${PORT}`);
  console.log(`  Telegram alerts: ${process.env.TELEGRAM_BOT_TOKEN ? 'AKTIF' : 'TIDAK DIKONFIGURASI'}`);
  console.log(`  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n`);

  startHealthMonitor(mikrotikFetch, checkThresholds);
  startPingMonitor();
  startTrafficRecorder();
});

// â”€â”€â”€ Traffic Recorder (fills /api/history/traffic ring buffer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const { runCommand } = require('./routes/routeros-api');
const { recordTraffic, recordUptime } = require('./routes/history');

async function trafficSnapshot() {
  try {
    const mainHost = (process.env.MIKROTIK_HOST || '').split(':')[0];
    const mainPort = parseInt(process.env.MIKROTIK_API_PORT || '56988');
    const mainUser = process.env.MIKROTIK_USER || '';
    const mainPass = process.env.MIKROTIK_PASS || '';

    let rx = 0, tx = 0;

    // 1. Fetch Main Router global traffic
    const [resRows, ifaces] = await Promise.all([
      runCommand(mainHost, mainPort, mainUser, mainPass, '/system/resource/print').catch(() => []),
      runCommand(mainHost, mainPort, mainUser, mainPass, '/interface/print').catch(() => []),
    ]);

    if (Array.isArray(ifaces) && ifaces.length > 0) {
      const running = ifaces
        .filter(i => i.running === 'true' && !(i.type || '').toLowerCase().startsWith('pppoe'))
        .map(i => i.name)
        .slice(0, 100);

      if (running.length) {
        const mainRes = await runCommand(mainHost, mainPort, mainUser, mainPass, '/interface/monitor-traffic', [
          `=interface=${running.join(',')}`,
          '=once=',
        ]).catch(e => ({ error: e }));

        if (Array.isArray(mainRes) && !mainRes.error) {
          mainRes.forEach(e => {
            rx += parseInt(e['rx-bits-per-second'] || 0);
            tx += parseInt(e['tx-bits-per-second'] || 0);
          });
        }
      }
    }

    // 2. Fetch Dynamic Custom Graphs
    // Looking for process.env.CUSTOM_GRAPH_<ID>_DEV / _IFACE
    const customGraphs = [];
    const customPromises = [];

    // Group graphs by target device to optimize requests (one req per router)
    const devicePolls = {}; // { devKey: { host, port, user, pass, interfaces: Set, graphIds: Set } }

    const extractDevCreds = (devKey) => {
      if (devKey === 'MAIN' || devKey === 'MIKROTIK') return { h: mainHost, p: mainPort, u: mainUser, pw: mainPass };
      // Try resolving directly MK_DEVICE_<devKey>_... or fallback to devKey_HOST
      const h = process.env[`MK_DEVICE_${devKey}_HOST`] || process.env[`${devKey}_HOST`];
      const p = parseInt(process.env[`MK_DEVICE_${devKey}_API_PORT`] || process.env[`${devKey}_API_PORT`] || '8728');
      const u = process.env[`MK_DEVICE_${devKey}_USER`] || process.env[`${devKey}_USER`] || mainUser;
      const pw = process.env[`MK_DEVICE_${devKey}_PASS`] || process.env[`${devKey}_PASS`] || mainPass;
      return h ? { h, p, u, pw } : null;
    };

    for (const key of Object.keys(process.env)) {
      const match = key.match(/^CUSTOM_GRAPH_([A-Z0-9_]+)_DEV$/);
      if (match) {
        const id = match[1];
        const devKey = (process.env[key] || '').toUpperCase();
        const ifaceTarget = process.env[`CUSTOM_GRAPH_${id}_IFACE`] || '';

        if (!devKey || !ifaceTarget) continue;

        const creds = extractDevCreds(devKey);
        if (!creds) continue;

        if (!devicePolls[devKey]) {
          devicePolls[devKey] = { ...creds, requests: [] };
        }
        
        devicePolls[devKey].requests.push({ id, ifaceTarget });
        // placeholder
        customGraphs.push({ id, rx: 0, tx: 0 });
      }
    }

    // Execute the polls
    for (const devKey of Object.keys(devicePolls)) {
      const tg = devicePolls[devKey];
      const ifaceSet = Array.from(new Set(tg.requests.map(r => r.ifaceTarget)));
      
      const p = runCommand(tg.h, tg.p, tg.u, tg.pw, '/interface/monitor-traffic', [
        `=interface=${ifaceSet.join(',')}`,
        '=once='
      ]).catch(() => []).then(res => {
        if (!Array.isArray(res)) return;
        res.forEach(item => {
          const itemRx = parseInt(item['rx-bits-per-second'] || 0);
          const itemTx = parseInt(item['tx-bits-per-second'] || 0);
          const itemName = item.name || '';
          
          // Map speeds back to customGraphs based on interface name matching
          tg.requests.forEach(req => {
            if (req.ifaceTarget === itemName) {
              const cg = customGraphs.find(x => x.id === req.id);
              if (cg) {
                cg.rx = itemRx;
                cg.tx = itemTx;
              }
            }
          });
        });
      });
      customPromises.push(p);
    }

    if (customPromises.length > 0) {
      await Promise.all(customPromises);
    }

    recordTraffic(rx, tx, customGraphs);
    if (resRows && resRows[0]) recordUptime(resRows[0].uptime || '');
  } catch (_) {}
}

function startTrafficRecorder() {
  console.log('  [History] Traffic recorder dimulai — interval 30s');
  trafficSnapshot();                        // first snapshot immediately
  setInterval(trafficSnapshot, 30 * 1000); // every 30s
}


