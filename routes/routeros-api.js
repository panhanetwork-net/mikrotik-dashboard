'use strict';
/**
 * Minimal RouterOS Binary API Client
 * Uses Node.js built-in 'net' and 'crypto' — no additional packages needed.
 * Supports RouterOS 6.43+ and RouterOS 7.x login (plain-text + MD5 fallback).
 * READ-ONLY: only sends /print and /monitor commands, never writes config.
 */
const net    = require('net');
const crypto = require('crypto');

/* ─── Protocol Encoding ──────────────────────────────────────────────────── */
function encLen(n) {
  if (n < 0x80)       return Buffer.from([n]);
  if (n < 0x4000)     return Buffer.from([(n >> 8) | 0x80, n & 0xFF]);
  if (n < 0x200000)   return Buffer.from([(n >> 16) | 0xC0, (n >> 8) & 0xFF, n & 0xFF]);
  if (n < 0x10000000) return Buffer.from([(n >> 24) | 0xE0, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]);
  return Buffer.from([0xF0, (n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]);
}

function encWord(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([encLen(b.length), b]);
}

function encSentence(words) {
  return Buffer.concat([...words.map(encWord), Buffer.from([0])]);
}

/* ─── Protocol Decoding ──────────────────────────────────────────────────── */
/**
 * Try to extract complete sentences from a buffer.
 * Returns { sentences: string[][], remainder: Buffer }
 */
function parseBuf(buf) {
  const sentences = [];
  let i = 0;

  outer: while (i < buf.length) {
    const words = [];
    let j = i;

    inner: while (j < buf.length) {
      if (buf[j] === 0) { j++; break inner; }

      // Decode variable-length word
      const fb = buf[j];
      let len = 0, skip = 0;
      if      ((fb & 0x80) === 0)    { len = fb;                                                                     skip = 1; }
      else if ((fb & 0xC0) === 0x80) { if (j + 2 > buf.length) break outer; len = ((fb & 0x3F) << 8) | buf[j+1];   skip = 2; }
      else if ((fb & 0xE0) === 0xC0) { if (j + 3 > buf.length) break outer; len = ((fb & 0x1F) << 16) | (buf[j+1] << 8) | buf[j+2]; skip = 3; }
      else if ((fb & 0xF0) === 0xE0) { if (j + 4 > buf.length) break outer; len = ((fb & 0x0F) << 24) | (buf[j+1] << 16) | (buf[j+2] << 8) | buf[j+3]; skip = 4; }
      else                           { if (j + 5 > buf.length) break outer; len = (buf[j+1] << 24) | (buf[j+2] << 16) | (buf[j+3] << 8) | buf[j+4]; skip = 5; }

      j += skip;
      if (j + len > buf.length) break outer;
      words.push(buf.slice(j, j + len).toString('utf8'));
      j += len;
    }

    if (words.length) sentences.push(words);
    i = j;
  }

  return { sentences, remainder: buf.slice(i) };
}

/* ─── MD5 Login (RouterOS 6.x fallback) ─────────────────────────────────── */
function md5Response(pass, challenge) {
  const h = crypto.createHash('md5');
  h.update(Buffer.from([0]));
  h.update(Buffer.from(pass, 'utf8'));
  h.update(Buffer.from(challenge, 'hex'));
  return '00' + h.digest('hex');
}

/* ─── Core API Function ──────────────────────────────────────────────────── */
/**
 * Run a RouterOS API command and return array of row objects.
 * @param {string}   host
 * @param {number}   port     API port (e.g. 56988)
 * @param {string}   user
 * @param {string}   pass
 * @param {string}   cmd      e.g. '/interface/print'
 * @param {string[]} [extra]  extra words e.g. ['=stats=']
 */
function runCommand(host, port, user, pass, cmd, extra = []) {
  return new Promise((resolve, reject) => {
    const sock   = new net.Socket();
    let   buf    = Buffer.alloc(0);
    const rows   = [];
    let   phase  = 'login';   // 'login' | 'cmd' | 'done'
    let   settled = false;

    const timeout = setTimeout(() => settle(new Error('RouterOS API timeout')), 9000);

    function settle(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      sock.destroy();
      err ? reject(err) : resolve(val);
    }

    function sendCmd() {
      const words = [cmd, ...extra];
      sock.write(encSentence(words));
      phase = 'cmd';
    }

    function handleSentences(sentences) {
      for (const words of sentences) {
        const type = words[0];
        if (phase === 'login') {
          if (type === '!done') {
            // ROS 7.x: login accepted directly
            sendCmd();
          } else if (type === '!re') {
            // ROS 6.x: challenge/response
            const retWord = words.find(w => w.startsWith('=ret='));
            if (retWord) {
              const chal = retWord.split('=')[2];
              sock.write(encSentence(['/login', `=name=${user}`, `=response=${md5Response(pass, chal)}`]));
            }
          } else if (type === '!trap' || type === '!fatal') {
            settle(new Error('RouterOS login failed: ' + (words.find(w => w.startsWith('=message=')) || '').replace('=message=','')));
          }
        } else if (phase === 'cmd') {
          if (type === '!re') {
            const row = {};
            for (const w of words.slice(1)) {
              if (!w.startsWith('=')) continue;
              const idx = w.indexOf('=', 1);
              if (idx < 0) continue;
              row[w.slice(1, idx)] = w.slice(idx + 1);
            }
            rows.push(row);
          } else if (type === '!done') {
            settle(null, rows);
          } else if (type === '!trap') {
            const msg = words.find(w => w.startsWith('=message='));
            settle(new Error(msg ? msg.slice(9) : 'RouterOS command error'));
          } else if (type === '!fatal') {
            settle(new Error('RouterOS fatal error'));
          }
        }
      }
    }

    sock.on('error', err => settle(new Error('RouterOS connect: ' + err.message)));

    sock.connect(port, host, () => {
      // ROS 7.x: send /login with plain password
      sock.write(encSentence(['/login', `=name=${user}`, `=password=${pass}`]));
    });

    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      const { sentences, remainder } = parseBuf(buf);
      buf = remainder;
      if (sentences.length) handleSentences(sentences);
    });
  });
}

/* ─── Exported Helper ────────────────────────────────────────────────────── */
module.exports = { runCommand };
