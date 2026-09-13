const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { runSync } = require('../sync');
const { importOffersFromBol, startImportJob, getImportJobStatus } = require('../importOffers');

const router = express.Router();
router.use(requireAuth);

router.post('/run', async (req, res) => {
  const result = await runSync();
  res.json(result);
});

// بيبدأ استيراد العروض من bol.com في الخلفية ويرجع فورًا (مش بيستنى لحد ما يخلص)
router.post('/import-from-bol', (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ error: 'لازم تحدد الحساب اللي عايز تستورد منه' });
  const job = startImportJob(accountId);
  res.json({ ok: true, status: job.status });
});

// المتصفح بيسأل بالحالة دي كل شوية لحد ما العملية تخلص
router.get('/import-from-bol/status', (req, res) => {
  res.json(getImportJobStatus());
});

router.get('/log', (req, res) => {
  const logs = db.prepare('SELECT * FROM sync_log ORDER BY ran_at DESC LIMIT 20').all();
  res.json({ logs });
});

module.exports = router;
