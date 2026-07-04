'use strict';

const jwt = require('jsonwebtoken');
const logger = require('./logger');

if (!process.env.JWT_SECRET) {
  logger.warn('JWT_SECRET is not set. Authentication will fail on every request.');
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { authMiddleware };
