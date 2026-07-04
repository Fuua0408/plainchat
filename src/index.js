'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const logger = require('./logger');
const { initDb } = require('./db');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 18091;

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'plainchat' });
});

app.use('/api/auth', authRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

initDb();

app.listen(PORT, () => {
  logger.info(`plainchat server listening on port ${PORT}`);
});
