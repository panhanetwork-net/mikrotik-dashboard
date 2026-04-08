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
const requireAuth = require('./middleware/requireAuth');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new MemoryStore({ checkPeriod: 8 * 60 * 60 * 1000 }),
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
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
  console.log(`  Threshold alerts: Board>60°C | CPU temp>75°C | CPU load>80%`);
  console.log(`  ─────────────────────────────────────\n`);

  startHealthMonitor(mikrotikFetch, checkThresholds);
  startPingMonitor();
});
