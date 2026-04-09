'use strict';
/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  SNMP v2c Poller — Pure Node.js (no native dependencies)       │
 * │  Uses built-in dgram (UDP) to speak raw SNMPv2c protocol        │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Supports:
 *  - GetRequest   (single OID)
 *  - GetBulkRequest (walk a MIB subtree)
 *
 * Env config (per device, use any KEY like SW1, OLT1, HW1, ...):
 *   SNMP_DEVICE_<KEY>_HOST=192.20.40.2
 *   SNMP_DEVICE_<KEY>_COMMUNITY=public
 *   SNMP_DEVICE_<KEY>_LABEL=CRS-326 Switch
 *   SNMP_DEVICE_<KEY>_VERSION=2c   (optional, default: 2c)
 */

const dgram   = require('dgram');
const express = require('express');
const router  = express.Router();

/* ─── OID Constants (IF-MIB + System MIB) ────────────────────────────────── */
const OID = {
  sysDescr:      '1.3.6.1.2.1.1.1.0',
  sysUpTime:     '1.3.6.1.2.1.1.3.0',
  sysName:       '1.3.6.1.2.1.1.5.0',
  ifNumber:      '1.3.6.1.2.1.2.1.0',
  /* Table OIDs (walked via GetBulk) */
  ifDescr:       '1.3.6.1.2.1.2.2.1.2',   // Interface Name
  ifType:        '1.3.6.1.2.1.2.2.1.3',   // Interface Type
  ifOperStatus:  '1.3.6.1.2.1.2.2.1.8',   // 1=up 2=down
  ifInOctets:    '1.3.6.1.2.1.2.2.1.10',  // RX bytes
  ifOutOctets:   '1.3.6.1.2.1.2.2.1.16',  // TX bytes
  ifAlias:       '1.3.6.1.2.1.31.1.1.1.18',// Alias / VLAN label
  ifHighSpeed:   '1.3.6.1.2.1.31.1.1.1.15',// Speed in Mbps
};

/* ─── Load SNMP devices from .env ─────────────────────────────────────────── */
function loadDevices() {
  const devices = {};
  // Match pattern: SNMP_DEVICE_<KEY>_HOST
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^SNMP_DEVICE_([A-Z0-9_]+)_HOST$/);
    if (!m) continue;
    const key = m[1];
    devices[key] = {
      key,
      host:      v,
      community: process.env[`SNMP_DEVICE_${key}_COMMUNITY`] || 'public',
      label:     process.env[`SNMP_DEVICE_${key}_LABEL`]     || `Device ${key}`,
      port:      parseInt(process.env[`SNMP_DEVICE_${key}_PORT`] || '161'),
    };
  }
  return devices;
}

/* ─── BER/ASN.1 helpers ───────────────────────────────────────────────────── */
function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const hex = len.toString(16).padStart(len < 0x100 ? 2 : 4, '0');
  const bytes = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
}

function encodeInteger(n) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.from(hex, 'hex');
  // prepend 0x00 if high-bit set (prevent sign extension)
  const val = (bytes[0] & 0x80) ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return Buffer.concat([Buffer.from([0x02]), encodeLength(val.length), val]);
}

function encodeOctetString(str) {
  const b = Buffer.from(str, 'utf8');
  return Buffer.concat([Buffer.from([0x04]), encodeLength(b.length), b]);
}

function encodeNull() { return Buffer.from([0x05, 0x00]); }

function encodeOID(oidStr) {
  const parts = oidStr.split('.').map(Number);
  // First two numbers encoded as 40*first + second
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    if (n === 0) { out.push(0); continue; }
    const bytes = [];
    while (n > 0) { bytes.unshift(n & 0x7f); n >>>= 7; }
    for (let j = 0; j < bytes.length - 1; j++) bytes[j] |= 0x80;
    out.push(...bytes);
  }
  const b = Buffer.from(out);
  return Buffer.concat([Buffer.from([0x06]), encodeLength(b.length), b]);
}

function encodeSequence(data) {
  return Buffer.concat([Buffer.from([0x30]), encodeLength(data.length), data]);
}

function encodePDU(type, requestId, varBinds) {
  // VarBindList
  const vbList = Buffer.concat(varBinds.map(oid =>
    encodeSequence(Buffer.concat([encodeOID(oid), encodeNull()]))
  ));
  const pduContent = Buffer.concat([
    encodeInteger(requestId),
    encodeInteger(0), // error-status
    encodeInteger(0), // error-index
    encodeSequence(vbList),
  ]);
  return Buffer.concat([Buffer.from([type]), encodeLength(pduContent.length), pduContent]);
}

function encodeSNMPv2Message(community, pdu) {
  const msg = encodeSequence(Buffer.concat([
    encodeInteger(1), // version: SNMPv2c = 1
    encodeOctetString(community),
    pdu,
  ]));
  return msg;
}

/* ─── BER Decoder ─────────────────────────────────────────────────────────── */
function decodeLength(buf, offset) {
  const first = buf[offset++];
  if (first < 0x80) return { len: first, offset };
  const numBytes = first & 0x7f;
  let len = 0;
  for (let i = 0; i < numBytes; i++) { len = (len << 8) | buf[offset++]; }
  return { len, offset };
}

function decodeOID(buf) {
  const parts = [Math.floor(buf[0] / 40), buf[0] % 40];
  let i = 1;
  while (i < buf.length) {
    let n = 0;
    while (buf[i] & 0x80) { n = (n << 7) | (buf[i++] & 0x7f); }
    n = (n << 7) | buf[i++];
    parts.push(n);
  }
  return parts.join('.');
}

function decodeValue(type, buf) {
  switch (type) {
    case 0x02: { // INTEGER
      let n = 0;
      for (const b of buf) n = (n * 256) + b;
      return n;
    }
    case 0x04: return buf.toString('utf8'); // OCTET STRING
    case 0x06: return decodeOID(buf);       // OID
    case 0x43: { // TIMETICKS
      let t = 0;
      for (const b of buf) t = (t * 256) + b;
      return t; // in hundredths of a second
    }
    case 0x41: // Counter32
    case 0x42: // Gauge32
    case 0x47: // Counter64 (simplified: take last 4 bytes)
    {
      let n = 0;
      const slice = buf.length > 4 ? buf.slice(buf.length - 4) : buf;
      for (const b of slice) n = (n * 256) + b;
      return n;
    }
    case 0x05: return null; // NULL
    default:   return buf.toString('hex');
  }
}

function parseVarBinds(buf) {
  const result = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0x30) break;
    i++;
    const { len: seqLen, offset: so } = decodeLength(buf, i);
    i = so;
    // OID
    if (buf[i] !== 0x06) { i += seqLen; continue; }
    i++;
    const { len: oidLen, offset: oo } = decodeLength(buf, i);
    i = oo;
    const oid = decodeOID(buf.slice(i, i + oidLen));
    i += oidLen;
    // Value
    const valType = buf[i++];
    const { len: valLen, offset: vo } = decodeLength(buf, i);
    i = vo;
    const value = decodeValue(valType, buf.slice(i, i + valLen));
    i += valLen;
    result.push({ oid, value });
  }
  return result;
}

function parseSNMPResponse(buf) {
  // Skip SEQUENCE header
  let i = 1;
  const { len: totalLen, offset: to } = decodeLength(buf, i); i = to;
  void totalLen;
  // Skip version integer
  i++; const { len: verLen, offset: veo } = decodeLength(buf, i); i = veo + verLen;
  // Skip community
  i++;  const { len: comLen, offset: cmo } = decodeLength(buf, i); i = cmo + comLen;
  // PDU type
  const pduType = buf[i++];
  const { len: pduLen, offset: pdo } = decodeLength(buf, i); i = pdo; void pduLen;
  // Skip requestId, errorStatus, errorIndex
  for (let x = 0; x < 3; x++) {
    i++; const { len: l, offset: o } = decodeLength(buf, i); i = o + l;
  }
  // VarBindList SEQUENCE
  i++; const { len: vbl, offset: vbo } = decodeLength(buf, i); i = vbo;
  const varBinds = parseVarBinds(buf.slice(i, i + vbl));
  return { pduType, varBinds };
}

/* ─── Core SNMP request ───────────────────────────────────────────────────── */
let reqIdCounter = 1;
function snmpGet(host, port, community, oids, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const reqId = reqIdCounter++ & 0x7fffffff;
    const pdu   = encodePDU(0xA0, reqId, oids); // GetRequest
    const msg   = encodeSNMPv2Message(community, pdu);

    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error(`SNMP timeout for ${host}:${port}`));
    }, timeoutMs);

    sock.on('message', (data) => {
      clearTimeout(timer);
      sock.close();
      try { resolve(parseSNMPResponse(data)); }
      catch (e) { reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(timer); sock.close(); reject(e); });
    sock.send(msg, port, host, (e) => { if (e) { clearTimeout(timer); sock.close(); reject(e); } });
  });
}

function snmpGetBulk(host, port, community, rootOid, maxRepetitions = 30, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const results = [];
    const reqId   = reqIdCounter++ & 0x7fffffff;

    // GetBulkRequest PDU (type 0xA5)
    const vbSeq = encodeSequence(Buffer.concat([encodeOID(rootOid), encodeNull()]));
    const vbList = encodeSequence(vbSeq);
    const pduContent = Buffer.concat([
      encodeInteger(reqId),
      encodeInteger(0),                    // non-repeaters
      encodeInteger(maxRepetitions),       // max-repetitions
      vbList,
    ]);
    const pdu = Buffer.concat([Buffer.from([0xA5]), encodeLength(pduContent.length), pduContent]);
    const msg = encodeSNMPv2Message(community, pdu);

    const sock  = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); resolve(results); }, timeoutMs);

    sock.on('message', (data) => {
      clearTimeout(timer);
      sock.close();
      try {
        const { varBinds } = parseSNMPResponse(data);
        varBinds.forEach(vb => {
          // Stop when OID leaves the requested subtree
          if (vb.oid.startsWith(rootOid + '.') || vb.oid === rootOid) {
            results.push(vb);
          }
        });
        resolve(results);
      } catch (e) { resolve(results); }
    });
    sock.on('error', (e) => { clearTimeout(timer); sock.close(); resolve([]); });
    sock.send(msg, port, host, (e) => {
      if (e) { clearTimeout(timer); sock.close(); resolve([]); }
    });
  });
}

/* ─── High-level helpers ──────────────────────────────────────────────────── */
async function getSystemInfo(host, port, community) {
  try {
    const { varBinds } = await snmpGet(host, port, community, [
      OID.sysDescr, OID.sysUpTime, OID.sysName,
    ]);
    const map = {};
    varBinds.forEach(vb => { map[vb.oid] = vb.value; });
    const ticks   = map[OID.sysUpTime] || 0;
    const seconds = Math.floor(ticks / 100);
    return {
      descr:    map[OID.sysDescr]  || '',
      name:     map[OID.sysName]   || '',
      uptime:   ticks,
      uptime_s: seconds,
      uptime_fmt: fmtUptime(seconds),
    };
  } catch (e) { return { error: e.message }; }
}

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${d}d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

async function walkInterfaces(host, port, community) {
  const [descrList, typeList, statusList, inList, outList, aliasList, speedList] = await Promise.all([
    snmpGetBulk(host, port, community, OID.ifDescr, 50),
    snmpGetBulk(host, port, community, OID.ifType, 50),
    snmpGetBulk(host, port, community, OID.ifOperStatus, 50),
    snmpGetBulk(host, port, community, OID.ifInOctets, 50),
    snmpGetBulk(host, port, community, OID.ifOutOctets, 50),
    snmpGetBulk(host, port, community, OID.ifAlias, 50),
    snmpGetBulk(host, port, community, OID.ifHighSpeed, 50),
  ]);

  // Index by interface number (last OID component)
  const byIdx = {};
  const idxOf = (vb, base) => vb.oid.slice(base.length + 1);

  descrList.forEach(vb  => { const i = idxOf(vb, OID.ifDescr);    (byIdx[i] ||= {}).idx = i; byIdx[i].name   = vb.value; });
  typeList.forEach(vb   => { const i = idxOf(vb, OID.ifType);     (byIdx[i] ||= {}).idx = i; byIdx[i].type   = vb.value; });
  statusList.forEach(vb => { const i = idxOf(vb, OID.ifOperStatus);(byIdx[i]||= {}).idx = i; byIdx[i].status = vb.value === 1 ? 'up' : 'down'; });
  inList.forEach(vb     => { const i = idxOf(vb, OID.ifInOctets); (byIdx[i] ||= {}).idx = i; byIdx[i].rxOctets = vb.value; });
  outList.forEach(vb    => { const i = idxOf(vb, OID.ifOutOctets);(byIdx[i] ||= {}).idx = i; byIdx[i].txOctets = vb.value; });
  aliasList.forEach(vb  => { const i = idxOf(vb, OID.ifAlias);    (byIdx[i] ||= {}).idx = i; byIdx[i].alias  = vb.value; });
  speedList.forEach(vb  => { const i = idxOf(vb, OID.ifHighSpeed);(byIdx[i] ||= {}).idx = i; byIdx[i].speed  = vb.value; });

  return Object.values(byIdx).sort((a, b) => Number(a.idx) - Number(b.idx));
}

/* ─── Routes ──────────────────────────────────────────────────────────────── */

/** GET /api/snmp/devices — list all configured SNMP devices */
router.get('/devices', (req, res) => {
  const devices = loadDevices();
  res.json(Object.values(devices).map(d => ({
    key: d.key, label: d.label, host: d.host, port: d.port,
  })));
});

/** GET /api/snmp/sysinfo/:key — system description, name, uptime */
router.get('/sysinfo/:key', async (req, res) => {
  const devices = loadDevices();
  const dev = devices[req.params.key.toUpperCase()];
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  const info = await getSystemInfo(dev.host, dev.port, dev.community);
  res.json({ device: { key: dev.key, label: dev.label, host: dev.host }, ...info });
});

/** GET /api/snmp/interfaces/:key — walk all interfaces of a device */
router.get('/interfaces/:key', async (req, res) => {
  const devices = loadDevices();
  const dev = devices[req.params.key.toUpperCase()];
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  try {
    const [sysinfo, ifaces] = await Promise.all([
      getSystemInfo(dev.host, dev.port, dev.community),
      walkInterfaces(dev.host, dev.port, dev.community),
    ]);
    res.json({ device: { key: dev.key, label: dev.label, host: dev.host }, sysinfo, interfaces: ifaces });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/** GET /api/snmp/all — all devices' sysinfo in one shot */
router.get('/all', async (req, res) => {
  const devices = loadDevices();
  const results = await Promise.all(
    Object.values(devices).map(async dev => {
      const info = await getSystemInfo(dev.host, dev.port, dev.community);
      return { key: dev.key, label: dev.label, host: dev.host, ...info };
    })
  );
  res.json(results);
});

module.exports = router;
