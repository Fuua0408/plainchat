'use strict';

const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();

router.use(authMiddleware);

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'id must be a number' });
  }
  req.params.id = Number(id);
  next();
});

function findOwnConversation(db, id, userId) {
  return db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
}

// GET /api/conversations
router.get('/', (req, res) => {
  const db = getDb();
  const conversations = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);
  res.json({ conversations });
});

// POST /api/conversations
router.post('/', (req, res) => {
  const { title } = req.body || {};
  const db = getDb();

  let result;
  if (typeof title === 'string' && title.trim() !== '') {
    result = db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)').run(req.user.id, title);
  } else {
    result = db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(req.user.id);
  }

  const conversation = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?')
    .get(result.lastInsertRowid);
  res.status(201).json({ conversation });
});

// PATCH /api/conversations/:id
router.patch('/:id', (req, res) => {
  const { title } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '' || title.length > 200) {
    return res.status(400).json({ error: 'title is required and must be 1-200 characters' });
  }

  const db = getDb();
  const existing = findOwnConversation(db, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title, req.params.id);

  const conversation = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?')
    .get(req.params.id);
  res.json({ conversation });
});

// DELETE /api/conversations/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const existing = findOwnConversation(db, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/conversations/:id/messages
router.get('/:id/messages', (req, res) => {
  const db = getDb();
  const existing = findOwnConversation(db, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const messages = db
    .prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(req.params.id);
  res.json({ messages });
});

module.exports = router;
