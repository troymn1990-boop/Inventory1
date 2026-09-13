const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// بنرجّع client_secret مقصوص عشان الأمان (مش هنعرضه كامل في الواجهة بعد أول مرة)
function maskAccount(account) {
  return {
    ...account,
    client_secret: account.client_secret ? '••••••••' + account.client_secret.slice(-4) : ''
  };
}

router.get('/', (req, res) => {
  const accounts = db.prepare('SELECT * FROM bol_accounts ORDER BY id ASC').all();
  res.json({ accounts: accounts.map(maskAccount) });
});

router.post('/', (req, res) => {
  const { name, client_id, client_secret } = req.body;
  if (!name || !client_id || !client_secret) {
    return res.status(400).json({ error: 'الاسم والـ Client ID والـ Client Secret كلهم مطلوبين' });
  }
  const info = db
    .prepare('INSERT INTO bol_accounts (name, client_id, client_secret) VALUES (?, ?, ?)')
    .run(name, client_id, client_secret);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { name, client_id, client_secret, active } = req.body;
  const current = db.prepare('SELECT * FROM bol_accounts WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'الحساب مش موجود' });

  db.prepare(
    `UPDATE bol_accounts SET
      name = COALESCE(?, name),
      client_id = COALESCE(?, client_id),
      client_secret = ?,
      active = COALESCE(?, active)
     WHERE id = ?`
  ).run(
    name,
    client_id,
    // لو المستخدم سايب حقل الـ secret فاضي، نفضل نحتفظ بالقديم (عشان مش هنعرضه كامل في الواجهة)
    client_secret && !client_secret.startsWith('••••') ? client_secret : current.client_secret,
    active,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const linkedOffers = db.prepare('SELECT COUNT(*) as c FROM product_offers WHERE account_id = ?').get(req.params.id).c;
  if (linkedOffers > 0) {
    return res.status(400).json({
      error: `الحساب ده مربوط بـ ${linkedOffers} EAN. فك ربطهم أو انقلهم لحساب تاني الأول قبل الحذف.`
    });
  }
  db.prepare('DELETE FROM bol_accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
