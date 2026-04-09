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

async function api(cmd, extra = [], maxRows = Infinity) {
  const { host, port } = apiHost();
  return runCommand(host, port, user(), pass(), cmd, extra, maxRows);
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
    const pMain = api('/system/resource/print').catch(() => []);
    
    const brsHost = process.env.BRS_HOST || '157.66.36.50';
    const brsApiPort = parseInt(process.env.BRS_API_PORT || '8750');
    const brsWwwPort = parseInt(process.env.BRS_WWW_PORT || '8965');
    const brsUser = process.env.BRS_USER || process.env.MIKROTIK_USER || 'admin';
    const brsPass = process.env.BRS_PASS || process.env.MIKROTIK_PASS || '';

    const pBrs = runCommand(brsHost, brsApiPort, brsUser, brsPass, '/system/resource/print')
      .catch(e => ({ error: e })).then(async (resObj) => {
        if (resObj && resObj.error) {
           try {
             const auth = Buffer.from(brsUser + ':' + brsPass).toString('base64');
             const r = await fetch(`http://${brsHost}:${brsWwwPort}/rest/system/resource`, {
               headers: { 'Authorization': 'Basic ' + auth }
             });
             const text = await r.text();
             try {
               const j = JSON.parse(text);
               return Array.isArray(j) ? j : [j];
             } catch (e) {
               return [];
             }
           } catch (e) {
             return [];
           }
        }
        return resObj;
      });

    const [mainRows, brsRows] = await Promise.all([pMain, pBrs]);
    
    return res.json({
      main: (Array.isArray(mainRows) ? mainRows[0] : null) || {},
      brs:  (Array.isArray(brsRows) ? brsRows[0] : null) || {}
    });
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
    // rx-byte/tx-byte are already included in /interface/print output on ROS 7.x
    return res.json({ ifaces, stats: ifaces });
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
    const sessions = await api('/ppp/active/print');
    return res.json({ total: sessions.length, sessions });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/connections ────────────────────────────────────────── */
router.get('/connections', async (req, res) => {
  try {
    // 1. Get true total connections instantly via tracking
    const track = await api('/ip/firewall/connection/tracking/print');
    const total = parseInt((track[0] || {})['total-entries'] || '0');

    // 2. Fetch a capped subset of connections so we don't timeout the socket 
    // maxRows = 3000 effectively aborts the socket once 3000 rows are processed
    const connections = await api('/ip/firewall/connection/print', [
      '=.proplist=src-address,dst-address,protocol,tcp-state,orig-bytes,repl-bytes',
    ], 3000);

    return res.json({ total, connections });
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
    // Sequential calls: avoid parallel connection overload on RouterOS API
    // No proplist — bytes/packets require stats flag not supported in binary API
    const filter = await api('/ip/firewall/filter/print').catch(() => []);
    const nat    = await api('/ip/firewall/nat/print').catch(() => []);
    const mangle = await api('/ip/firewall/mangle/print').catch(() => []);
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
