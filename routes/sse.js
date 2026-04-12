'use strict';
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { api, getDevicesList } = require('./mikrotik');
const { getPingStatus } = require('./ping');
const { runCommand } = require('./routeros-api');

const router = express.Router();

let sseClients = new Set();
let globalState = {};

// â”€â”€â”€ MAC Vendor Cache â”€â”€â”€
let macCache = {};
const macCachePath = path.join(__dirname, '../data/mac-cache.json');
try {
  if (fs.existsSync(macCachePath)) {
    macCache = JSON.parse(fs.readFileSync(macCachePath, 'utf8'));
  } else {
    if (!fs.existsSync(path.dirname(macCachePath))) fs.mkdirSync(path.dirname(macCachePath), { recursive: true });
    fs.writeFileSync(macCachePath, '{}');
  }
} catch (e) {
  console.error('[SSE] Failed to load MAC cache', e);
}

const macQueue = new Set();
setInterval(async () => {
  if (macQueue.size === 0) return;
  const mac = Array.from(macQueue)[0];
  macQueue.delete(mac);
  
  const prefix = mac.substring(0, 8).toUpperCase(); // e.g. "00:11:22"
  if (macCache[prefix] || prefix.length < 8) return;

  try {
    const res = await fetch(`https://api.macvendors.com/${prefix}`);
    if (res.ok) {
      const vendor = await res.text();
      macCache[prefix] = vendor.trim();
      fs.writeFileSync(macCachePath, JSON.stringify(macCache));
    } else {
      // Avoid re-fetching immediately if API limit hit
      macCache[prefix] = 'Unknown';
    }
  } catch (err) {
    // silently fail
  }
}, 1500); // 1 request per 1.5s to respect API Rate Limits

// â”€â”€â”€ Data Fetchers â”€â”€â”€
async function fetchTechnitium() {
  const dURL = process.env.TECHNITIUM_URL;
  const token = process.env.TECHNITIUM_TOKEN;
  if (!dURL || !token) return null;
  try {
    const res = await fetch(`${dURL}/api/dashboard/stats/get?token=${token}&type=lastHour`);
    if (res.ok) return await res.json();
  } catch(e){}
  return null;
}

async function fetchResources() {
  const devices = getDevicesList();
  const fetchRes = async (d) => {
    if (d.key === 'MAIN') {
      return api('/system/resource/print').catch(e => {
        const mainErr = e && e.message ? e.message : String(e);
        return [{ _error: `API Error: ${mainErr}` }];
      });
    }

    return runCommand(d.host, d.port, d.user, d.pass, '/system/resource/print')
      .catch(e => ({ error: e })).then(async (resObj) => {
        if (resObj && resObj.error) {
           const cmdErr = resObj.error && resObj.error.message
             ? resObj.error.message
             : String(resObj.error);

           try {
             const auth = Buffer.from(d.user + ':' + d.pass).toString('base64');
             const r = await fetch(`http://${d.host}:${d.webPort}/rest/system/resource`, { headers: { 'Authorization': 'Basic ' + auth }});
             if (!r.ok) {
               return [{ _error: `API Error: ${cmdErr}` }];
             }
             const text = await r.text();
             try {
               const j = JSON.parse(text);
               return Array.isArray(j) ? j : [j];
             } catch (_) {
               return [{ _error: `API Error: ${cmdErr}` }];
             }
           } catch (eREST) {
               return [{ _error: `API Error: ${cmdErr}` }];
           }
        }
        return resObj;
      });
  };
  const results = await Promise.all(devices.map(d => fetchRes(d)));
  const out = {};
  devices.forEach((d, idx) => {
    const rows = results[idx];
    out[d.key] = (Array.isArray(rows) && rows[0]) ? rows[0] : {};
  });
  return out;
}

// Global Poller Engine
function startGlobalPoller() {
  console.log('[SSE] Global Poller Engine started (2s interval)');
  
  setInterval(async () => {
    if (sseClients.size === 0) return; // Don't poll heavily if no clients are listening
    
    try {
      const [technitium, resources, health, pppoe, track, connectionsArray, filter, nat, mangle, logs] = await Promise.all([
        fetchTechnitium(),
        fetchResources(),
        api('/system/health/print').catch(() => []),
        api('/ppp/active/print').catch(() => []),
        api('/ip/firewall/connection/tracking/print').catch(() => []),
        api('/ip/firewall/connection/print', ['=.proplist=src-address,dst-address,protocol,tcp-state,orig-bytes,repl-bytes'], 3000).catch(() => []),
        api('/ip/firewall/filter/print').catch(() => []),
        api('/ip/firewall/nat/print').catch(() => []),
        api('/ip/firewall/mangle/print').catch(() => []),
        api('/log/print').catch(() => [])
      ]);

      const pingD = getPingStatus();
      const totalConnections = parseInt((track && track[0] ? track[0]['total-entries'] : '0') || '0');
      
      // Update macQueue
      pppoe.forEach(s => {
        if (s['caller-id'] && s['caller-id'].includes(':')) {
           const pre = s['caller-id'].substring(0,8).toUpperCase();
           if (!macCache[pre] && pre.length === 8) macQueue.add(s['caller-id']);
        }
      });
      // We could also do it for connections or interfaces if they have MACs, but PPPoE is primary target here.

      globalState = {
        time: Date.now(),
        technitium: technitium || { error: 'none' },
        resources: resources,
        health: health,
        pppoe: { total: pppoe.length, sessions: pppoe },
        connections: { total: totalConnections, connections: connectionsArray },
        firewall: { filter: filter, nat: nat, mangle: mangle },
        logs: Array.isArray(logs) ? logs.slice(-200).reverse() : [],
        macVendors: macCache,
        ping: pingD
      };

      const payload = `data: ${JSON.stringify(globalState)}\n\n`;
      sseClients.forEach(client => {
        client.write(payload);
      });
      
    } catch (e) {
      console.error('[SSE] Poller error:', e.message);
    }
  }, 2000);
}

startGlobalPoller();

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n'); // keep-alive initial flush

  sseClients.add(res);

  // Send an immediate snapshot if available
  if (globalState.time) {
    res.write(`data: ${JSON.stringify(globalState)}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

module.exports = router;
