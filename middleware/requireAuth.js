'use strict';

/**
 * Middleware: hanya izinkan request yang sudah punya session login.
 * Digunakan untuk melindungi semua route /api/mikrotik/* dan /dashboard.
 */
module.exports = function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  // Jika request adalah API, kembalikan 401 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized — silakan login terlebih dahulu.' });
  }
  // Jika browser request, redirect ke login
  return res.redirect('/');
};
