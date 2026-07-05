'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const logger = require('./logger');
const { initDb } = require('./db');
const authRoutes = require('./routes/auth');
const conversationsRoutes = require('./routes/conversations');
const chatRoutes = require('./routes/chat');
const settingsRoutes = require('./routes/settings');
const uploadsRoutes = require('./routes/uploads');

const app = express();
const PORT = process.env.PORT || 18091;

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'plainchat' });
});

app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/conversations', chatRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/uploads', uploadsRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

initDb();

app.listen(PORT, () => {
  logger.info(`plainchat server listening on port ${PORT}`);
});
