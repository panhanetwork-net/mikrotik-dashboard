'use strict';
const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data.json');
const DEFAULT_ADMIN_USER = (process.env.DASHBOARD_USER || 'admin').trim();
const DEFAULT_ADMIN_PASS = process.env.DASHBOARD_PASS || 'Panhanet213';

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
  const hash = bcrypt.hashSync(DEFAULT_ADMIN_PASS, 12);
  _db.users.push({
    id:            1,
    username:      DEFAULT_ADMIN_USER,
    password_hash: hash,
    role:          'admin',
    created_at:    new Date().toISOString(),
  });
  saveDB(_db);
  console.log(`[DB] Default admin created from .env: ${DEFAULT_ADMIN_USER}`);
} else {
  const envAdmin = _db.users.find(u => u.username === DEFAULT_ADMIN_USER);
  if (envAdmin && !bcrypt.compareSync(DEFAULT_ADMIN_PASS, envAdmin.password_hash)) {
    envAdmin.password_hash = bcrypt.hashSync(DEFAULT_ADMIN_PASS, 12);
    saveDB(_db);
    console.log(`[DB] Admin password synced from .env for user: ${DEFAULT_ADMIN_USER}`);
  }
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
