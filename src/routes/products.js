const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(requireAuth);

// جلب المنتجات مع بحث وترقيم صفحات (عشان 500+ صنف)
router.get('/', (req, res) => {
  const { search = '', page = 1, pageSize = 50, lowStockOnly } = req.query;
  const offset = (Number(page) - 1) * Number(pageSize);

  let where = 'WHERE (sku LIKE ? OR name LIKE ? OR ean LIKE ?)';
  const params = [`%${search}%`, `%${search}%`, `%${search}%`];

  if (lowStockOnly === 'true') {
    where += ' AND stock_qty <= low_stock_threshold';
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM products ${where}`).get(...params).c;
  const rows = db
    .prepare(`SELECT * FROM products ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), offset);

  res.json({ total, page: Number(page), pageSize: Number(pageSize), products: rows });
});

router.post('/', (req, res) => {
  const { sku, ean, bol_offer_id, name, cost_price, sell_price, stock_qty, low_stock_threshold, category } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'SKU والاسم مطلوبين' });

  try {
    const info = db
      .prepare(
        `INSERT INTO products (sku, ean, bol_offer_id, name, cost_price, sell_price, stock_qty, low_stock_threshold, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sku,
        ean || null,
        bol_offer_id || null,
        name,
        Number(cost_price) || 0,
        Number(sell_price) || 0,
        Number(stock_qty) || 0,
        Number(low_stock_threshold) || 5,
        category || null
      );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'SKU ده موجود قبل كده' });
  }
});

router.put('/:id', (req, res) => {
  const { name, ean, bol_offer_id, cost_price, sell_price, stock_qty, low_stock_threshold, category, active } = req.body;
  db.prepare(
    `UPDATE products SET
      name = COALESCE(?, name),
      ean = ?,
      bol_offer_id = ?,
      cost_price = COALESCE(?, cost_price),
      sell_price = COALESCE(?, sell_price),
      stock_qty = COALESCE(?, stock_qty),
      low_stock_threshold = COALESCE(?, low_stock_threshold),
      category = ?,
      active = COALESCE(?, active),
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    name,
    ean || null,
    bol_offer_id || null,
    cost_price,
    sell_price,
    stock_qty,
    low_stock_threshold,
    category || null,
    active,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// استيراد CSV جماعي - أعمدة متوقعة: sku,name,ean,bol_offer_id,cost_price,sell_price,stock_qty,category
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'مفيش ملف' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: 'الملف مش CSV صحيح: ' + e.message });
  }

  const insert = db.prepare(
    `INSERT INTO products (sku, ean, bol_offer_id, name, cost_price, sell_price, stock_qty, category)
     VALUES (@sku, @ean, @bol_offer_id, @name, @cost_price, @sell_price, @stock_qty, @category)
     ON CONFLICT(sku) DO UPDATE SET
       ean = excluded.ean,
       bol_offer_id = excluded.bol_offer_id,
       name = excluded.name,
       cost_price = excluded.cost_price,
       sell_price = excluded.sell_price,
       stock_qty = excluded.stock_qty,
       category = excluded.category,
       updated_at = CURRENT_TIMESTAMP`
  );

  let imported = 0;
  const errors = [];
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      if (!row.sku || !row.name) {
        errors.push(`صف ناقص sku/name: ${JSON.stringify(row)}`);
        continue;
      }
      insert.run({
        sku: row.sku,
        ean: row.ean || null,
        bol_offer_id: row.bol_offer_id || null,
        name: row.name,
        cost_price: Number(row.cost_price) || 0,
        sell_price: Number(row.sell_price) || 0,
        stock_qty: Number(row.stock_qty) || 0,
        category: row.category || null
      });
      imported++;
    }
  });
  tx(records);

  res.json({ ok: true, imported, total: records.length, errors });
});

module.exports = router;
