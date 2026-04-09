'use strict';
const express       = require('express');
const { runCommand} = require('./routeros-api');
const router        = express.Router();

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function loadMikrotikDevices() {
  const envVars = process.env; // Can use native process.env since Settings updates it live now
  const devices = {
    MAIN: { key: 'MAIN', label: '.31 Utama (CCR)', host: (envVars.MIKROTIK_HOST||'').split(':')[0], port: parseInt(envVars.MIKROTIK_API_PORT||'56988'), user: envVars.MIKROTIK_USER||'', pass: envVars.MIKROTIK_PASS||'' },
    BRS:  { key: 'BRS',  label: '.42 X86 (BRS)',   host: (envVars.BRS_HOST||'').split(':')[0],  port: parseInt(envVars.BRS_API_PORT||'8728'), user: envVars.BRS_USER||'', pass: envVars.BRS_PASS||'' },
    R50:  { key: 'R50',  label: '.50 PDG (BRS)',   host: (envVars.R50_HOST||'').split(':')[0],  port: parseInt(envVars.R50_API_PORT||'8750'), user: envVars.R50_USER||'', pass: envVars.R50_PASS||'' },
    R155: { key: 'R155', label: '.155 NOC',        host: (envVars.R155_HOST||'').split(':')[0], port: parseInt(envVars.R155_API_PORT||'1945'), user: envVars.R155_USER||'', pass: envVars.R155_PASS||'' },
  };
  
  // Custom dynamically added devices via Settings GUI (MK_DEVICE_<KEY>_HOST)
  for (const [k, v] of Object.entries(envVars)) {
    const m = k.match(/^MK_DEVICE_([A-Z0-9_]+)_HOST$/);
    if (!m) continue;
    const key = m[1];
    devices[key] = {
      key,
      label: envVars[`MK_DEVICE_${key}_LABEL`] || `Device ${key}`,
      host:  (v||'').split(':')[0],
      port:  parseInt(envVars[`MK_DEVICE_${key}_API_PORT`] || '8728'),
      user:  envVars[`MK_DEVICE_${key}_USER`] || '',
      pass:  envVars[`MK_DEVICE_${key}_PASS`] || ''
    };
  }
  return devices;
}

function getDeviceAuth(key = 'MAIN') {
  const devices = loadMikrotikDevices();
  const d = devices[key.toUpperCase()] || devices['MAIN'];
  return d;
}

async function api(cmd, extra = [], maxRows = Infinity, deviceKey = 'MAIN') {
  const { host, port, user, pass } = getDeviceAuth(deviceKey);
  return runCommand(host, port, user, pass, cmd, extra, maxRows);
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
    
    const fetchRes = async (prefix) => {
      const host = process.env[`${prefix}_HOST`];
      if (!host) return [];
      const apiPort = parseInt(process.env[`${prefix}_API_PORT`] || '8728');
      const wwwPort = parseInt(process.env[`${prefix}_WWW_PORT`] || '80');
      const user = process.env[`${prefix}_USER`] || process.env.MIKROTIK_USER || 'admin';
      const pass = process.env[`${prefix}_PASS`] || process.env.MIKROTIK_PASS || '';

      return runCommand(host, apiPort, user, pass, '/system/resource/print')
        .catch(e => ({ error: e })).then(async (resObj) => {
          if (resObj && resObj.error) {
             try {
               const auth = Buffer.from(user + ':' + pass).toString('base64');
               const r = await fetch(`http://${host}:${wwwPort}/rest/system/resource`, {
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
    };

    const [mainRows, r42Rows, r50Rows, r155Rows] = await Promise.all([
      pMain,
      fetchRes('BRS'),
      fetchRes('R50'),
      fetchRes('R155')
    ]);
    
    return res.json({
      main: (Array.isArray(mainRows) ? mainRows[0] : null) || {},
      r42:  (Array.isArray(r42Rows) ? r42Rows[0] : null) || {},
      r50:  (Array.isArray(r50Rows) ? r50Rows[0] : null) || {},
      r155: (Array.isArray(r155Rows) ? r155Rows[0] : null) || {}
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

/* ─── GET /api/mikrotik/interfaces/:key? ───────────────────────────────────── */
router.get('/interfaces/:key?', async (req, res) => {
  try {
    const key = req.params.key || 'MAIN';
    // Single call to get everything efficiently
    const all = await api('/interface/print', [], Infinity, key);
    
    // Counters
    let up = 0, down = 0, vlanCount = 0;
    const coreList = [];

    for (let i = 0; i < all.length; i++) {
      const row = all[i];
      if (isCore(row)) {
        coreList.push(row);
        const nameL = (row.name || '').toLowerCase();
        const run   = row.running === 'true';
        if (run) up++; else down++;
        if (nameL.includes('vlan')) vlanCount++;
      }
    }
    
    // Render
    const formatted = coreList.map((item, idx) => ({
      idx: idx + 1,
      name: item.name || '',
      type: item.type || '',
      mac: item['mac-address'] || '',
      mtu: item['actual-mtu'] || item.mtu || '',
      txSpeed: '-', // Traffic comes from /interface/monitor-traffic loop
      rxSpeed: '-',
      txBytes: Number(item['tx-byte'] || 0),
      rxBytes: Number(item['rx-byte'] || 0),
      up: item.running === 'true',
      lastLinkChange: item['last-link-change'] || 'N/A'
    }));

    return res.json({
      total: coreList.length,
      up,
      down,
      vlan: vlanCount,
      interfaces: formatted
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/interface/stats/:key? ───────────────────────────────── */
router.get('/interface/stats/:key?', async (req, res) => {
  try {
    const key = req.params.key || 'MAIN';
    const all = await api('/interface/print', [], Infinity, key);
    // Only monitor core (non-pppoe-out) running interfaces, max 100
    const running = all.filter(i => i.running === 'true' && isCore(i)).map(i => i.name).slice(0, 100);
    if (!running.length) return res.json([]);
    const data = await api('/interface/monitor-traffic', [
      `=interface=${running.join(',')}`,
      '=once=',
    ], Infinity, key);
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/* ─── GET /api/mikrotik/devices (New Route for Dropdown) ───────────────────── */
router.get('/devices', (req, res) => {
  const devices = loadMikrotikDevices();
  const list = Object.values(devices)
    .filter(d => d.host && d.port)
    .map(d => ({ key: d.key, label: d.label, host: d.host }));
  res.json(list);
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
