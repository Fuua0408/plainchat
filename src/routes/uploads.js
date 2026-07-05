'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const logger = require('../logger');
const { DATA_DIR, UPLOAD_ROOT, resolveAttachmentFilePath } = require('../attachmentStorage');

const router = express.Router();
router.use(authMiddleware);

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_ROOT, String(req.user.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const base = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 60);
    const random = crypto.randomBytes(4).toString('hex');
    cb(null, `${Date.now()}_${random}_${base}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    const err = new Error('unsupported mime type');
    err.code = 'UNSUPPORTED_MIME_TYPE';
    return cb(err);
  }
  cb(null, true);
}

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });

// POST /api/uploads/image
router.post('/image', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      logger.warn('uploads: rejected file', { error: err.code || err.message });
      return res.status(400).json({ error: 'image must be jpeg/png/webp/gif and 10MB or smaller' });
    }

    const cleanupAndRespond = (status, body) => {
      if (req.file) fs.unlink(req.file.path, () => {});
      res.status(status).json(body);
    };

    if (!req.file) {
      return cleanupAndRespond(400, { error: 'image is required' });
    }

    const conversationId = Number(req.body.conversation_id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return cleanupAndRespond(400, { error: 'conversation_id is required' });
    }

    const db = getDb();
    const conversation = db
      .prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
      .get(conversationId, req.user.id);
    if (!conversation) {
      return cleanupAndRespond(404, { error: 'Not found' });
    }

    const relPath = path.relative(DATA_DIR, req.file.path).split(path.sep).join('/');
    const result = db
      .prepare(
        `INSERT INTO attachments (user_id, conversation_id, message_id, kind, mime, size, path, original_name)
         VALUES (?, ?, NULL, 'image', ?, ?, ?, ?)`
      )
      .run(req.user.id, conversationId, req.file.mimetype, req.file.size, relPath, req.file.originalname);

    res.status(201).json({ id: result.lastInsertRowid, url: `/api/uploads/image/${result.lastInsertRowid}` });
  });
});

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'id must be a number' });
  }
  req.params.id = Number(id);
  next();
});

// GET /api/uploads/image/:id
router.get('/image/:id', (req, res) => {
  const db = getDb();
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!attachment || attachment.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }

  const filePath = resolveAttachmentFilePath(attachment);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', attachment.mime);
  res.sendFile(filePath);
});

module.exports = router;
