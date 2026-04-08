'use strict';
const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data.json');

// ─── Load / Init JSON store ───────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: [], alertLog: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (_) {
    return { users: [], alertLog: [] };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Seed default admin if no users exist ────────────────────────────────────
let _db = loadDB();
if (_db.users.length === 0) {
  const hash = bcrypt.hashSync('Admin@2Arah', 12);
  _db.users.push({
    id:            1,
    username:      'admin',
    password_hash: hash,
    role:          'admin',
    created_at:    new Date().toISOString(),
  });
  saveDB(_db);
  console.log('[DB] Default admin created: admin / Admin@2Arah');
}

// ─── Exported helpers ─────────────────────────────────────────────────────────
module.exports = {

  /** Find user by username */
  findUser(username) {
    const db = loadDB();
    return db.users.find(u => u.username === username) || null;
  },

  /** Verify plain password against stored hash */
  verifyPassword(plain, hash) {
    return bcrypt.compareSync(plain, hash);
  },

  /** Log an alert event */
  logAlert(type, routerIp, message) {
    const db = loadDB();
    db.alertLog.push({
      id:       Date.now(),
      type,
      router_ip: routerIp,
      message,
      sent_at:  new Date().toISOString(),
    });
    // Keep only last 200 entries
    if (db.alertLog.length > 200) db.alertLog = db.alertLog.slice(-200);
    saveDB(db);
  },

  /** Get recent alerts (last 50) */
  getRecentAlerts() {
    const db = loadDB();
    return [...db.alertLog].reverse().slice(0, 50);
  },
};
