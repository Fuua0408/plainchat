'use strict';

const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();
router.use(authMiddleware);

const MAX_LEN = 20000;

// GET /api/settings
router.get('/', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT system_prompt FROM users WHERE id = ?').get(req.user.id);
  res.json({ system_prompt: user?.system_prompt || '' });
});

// PUT /api/settings
router.put('/', (req, res) => {
  const { system_prompt } = req.body || {};
  if (typeof system_prompt !== 'string' || system_prompt.length > MAX_LEN) {
    return res.status(400).json({ error: `system_prompt must be a string up to ${MAX_LEN} characters` });
  }

  const value = system_prompt === '' ? null : system_prompt;
  const db = getDb();
  db.prepare("UPDATE users SET system_prompt = ?, updated_at = datetime('now') WHERE id = ?")
    .run(value, req.user.id);
  res.json({ system_prompt: value || '' });
});

module.exports = router;
