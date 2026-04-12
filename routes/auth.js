const express = require('express');
const { findUser, verifyPassword } = require('../db/database');
const router = express.Router();

// Router IP dikonfigurasi dari .env, bukan dari form login
const ROUTER_HOST = process.env.MIKROTIK_HOST || '';

// POST /api/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const envUser = (process.env.DASHBOARD_USER || '').trim();
  const envPass = process.env.DASHBOARD_PASS || '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi.' });
  }

  let authUser = null;
  const uname = username.trim();

  // Primary auth source: .env credentials (if configured)
  if (envUser && envPass) {
    if (uname !== envUser || password !== envPass) {
      return res.status(401).json({ error: 'Username atau password salah.' });
    }
    authUser = {
      id: 1,
      username: envUser,
      role: 'admin',
    };
  } else {
    // Legacy fallback: JSON user store
    const user = findUser(uname);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Username atau password salah.' });
    }
    authUser = user;
  }

  // Simpan session — routerIp diambil dari .env
  req.session.userId   = authUser.id;
  req.session.username = authUser.username;
  req.session.role     = authUser.role;
  req.session.routerIp = ROUTER_HOST;


  return res.json({
    ok: true,
    username: authUser.username,
    role: authUser.role,
    routerIp: req.session.routerIp,
  });
});

// POST /api/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    return res.json({ ok: true });
  });
});

// GET /api/me — cek session aktif
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.json({
    ok: true,
    username: req.session.username,
    role: req.session.role,
    routerIp: req.session.routerIp,
  });
});

module.exports = router;
