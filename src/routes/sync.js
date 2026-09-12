const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { runSync } = require('../sync');

const router = express.Router();
router.use(requireAuth);

router.post('/run', async (req, res) => {
  const result = await runSync();
  res.json(result);
});

router.get('/log', (req, res) => {
  const logs = db.prepare('SELECT * FROM sync_log ORDER BY ran_at DESC LIMIT 20').all();
  res.json({ logs });
});

module.exports = router;
