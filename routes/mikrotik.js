'use strict';
const express       = require('express');
const { runCommand} = require('./routeros-api');
const router        = express.Router();

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function apiHost() {
  const host = (process.env.MIKROTIK_HOST || '').split(':')[0];
  const port = parseInt(process.env.MIKROTIK_API_PORT || '56988');
  return { host, port };
}
function user() { return process.env.MIKROTIK_USER || ''; }
function pass() { return process.env.MIKROTIK_PASS || ''; }

async function api(cmd, extra = []) {
  const { host, port } = apiHost();
  return runCommand(host, port, user(), pass(), cmd, extra);
}

// Interface types considered "core" (exclude pppoe-out tunnels per-session)
const CORE_TYPES = new Set(['ether','bridge','vlan','bonding','wlan','vlan','sfp','ppp','l2tp','sstp','ovpn','eoip','ipip','gre','vxlan']);
function isCore(iface) {
  const t = (iface.type || '').toLowerCase();
  return !t.startsWith('pppoe') && !t.includes('pppoe-out') && !t.includes('pppoe-in');
}

// For backwards-compat with router IP from session (ignored — always uses .env host)
async function apiFor(_routerIp, cmd, extra = []) {
  return api(cmd, extra);
}

/* ─── GET /api/mikrotik/status ─────────────────────────────────────────────── */
router.get('/status', async (req, res) => {
  try {
    await api('/system/identity/print');
    return res.json({ online: true, routerIp: req.session.routerIp });
  } catch (err) {
    return res.json({ online: false, routerIp: req.session.routerIp, error: err.message });
  }
});

/* ─── GET /api/mikrotik/resources ──────────────────────────────────────────── */
router.get('/resources', async (req, res) => {
  try {
    const rows = await api('/system/resource/print');
    return res.json(rows[0] || {});
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/health ─────────────────────────────────────────────── */
router.get('/health', async (req, res) => {
  try {
    const rows = await api('/system/health/print');
    return res.json(rows);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/interfaces ─────────────────────────────────────────── */
router.get('/interfaces', async (req, res) => {
  try {
    const all    = await api('/interface/print');
    const ifaces = all.filter(isCore); // hide pppoe-out session tunnels
    const stats  = await api('/interface/print', ['=stats=']).catch(() => []);
    return res.json({ ifaces, stats });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── POST /api/mikrotik/traffic ────────────────────────────────────────────── */
router.post('/traffic', async (req, res) => {
  try {
    const all    = await api('/interface/print');
    // Only monitor core (non-pppoe-out) running interfaces, max 100
    const running = all.filter(i => i.running === 'true' && isCore(i)).map(i => i.name).slice(0, 100);
    if (!running.length) return res.json([]);
    const data = await api('/interface/monitor-traffic', [
      `=interface=${running.join(',')}`,
      '=once=',
    ]);
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/pppoe-active ────────────────────────────────────────── */
router.get('/pppoe-active', async (req, res) => {
  try {
    const data = await api('/ppp/active/print');
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/connections ────────────────────────────────────────── */
router.get('/connections', async (req, res) => {
  try {
    const data = await api('/ip/firewall/connection/print', [
      '=.proplist=src-address,dst-address,protocol,tcp-state,orig-bytes,repl-bytes',
    ]);
    return res.json(data.slice(0, 1000));
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/queues ─────────────────────────────────────────────── */
router.get('/queues', async (req, res) => {
  try {
    const data = await api('/queue/simple/print');
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/firewall-stats ─────────────────────────────────────── */
router.get('/firewall-stats', async (req, res) => {
  try {
    const proplist = ['=.proplist=.id,chain,action,protocol,src-address,dst-address,comment,bytes,packets,disabled'];
    const [filter, nat, mangle] = await Promise.all([
      api('/ip/firewall/filter/print', proplist).catch(() => []),
      api('/ip/firewall/nat/print', proplist).catch(() => []),
      api('/ip/firewall/mangle/print', proplist).catch(() => []),
    ]);
    return res.json({ filter, nat, mangle });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/logs ───────────────────────────────────────────────── */
router.get('/logs', async (req, res) => {
  try {
    const data = await api('/log/print');
    return res.json(data.slice(-200).reverse());
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/dns-cache ──────────────────────────────────────────── */
router.get('/dns-cache', async (req, res) => {
  try {
    const data = await api('/ip/dns/cache/print');
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── POST /api/mikrotik/interface-traffic ─────────────────────────────────── */
router.post('/interface-traffic', async (req, res) => {
  try {
    const names = (req.query.iface || '').trim();
    if (!names) return res.json([]);
    const data = await api('/interface/monitor-traffic', [`=interface=${names}`, '=once=']);
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── mikrotikFetch (legacy compat — used by alerts.js / history.js) ─────── */
async function mikrotikFetch(_routerIp, path) {
  // Translate REST-style path to binary API command
  const map = {
    '/rest/system/resource':       ['/system/resource/print', []],
    '/rest/system/health':         ['/system/health/print', []],
    '/rest/system/identity':       ['/system/identity/print', []],
    '/rest/interface':             ['/interface/print', []],
    '/rest/log':                   ['/log/print', []],
  };
  const entry = map[path];
  if (entry) {
    const rows = await api(entry[0], entry[1]);
    // Return first row for single-result paths
    if (path.includes('resource') || path.includes('identity')) return rows[0] || {};
    return rows;
  }
  throw new Error('mikrotikFetch: unsupported path ' + path);
}

module.exports = { router, mikrotikFetch };
