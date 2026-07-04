'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const logger = require('../logger');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    logger.warn('LOGIN_FAIL', { username, ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    logger.warn('LOGIN_FAIL', { username, ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  let token;
  try {
    token = jwt.sign(
      { id: user.id, username: user.username, is_admin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
  } catch (err) {
    return res.status(500).json({ error: 'Token generation failed: ' + err.message });
  }

  logger.info('LOGIN_OK', { user_id: user.id, username: user.username, ip: req.ip });
  res.json({ token, user: { id: user.id, username: user.username, is_admin: user.is_admin } });
});

// POST /api/auth/change-password
router.post('/change-password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'new_password must be at least 8 characters' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const ok = await bcrypt.compare(current_password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(new_password, 12);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(hash, req.user.id);

  logger.info('CHANGE_PASSWORD_OK', { user_id: req.user.id, username: req.user.username });
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  const { id, username, is_admin } = req.user;
  res.json({ user: { id, username, is_admin } });
});

module.exports = router;
