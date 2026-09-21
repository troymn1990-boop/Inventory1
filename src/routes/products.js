const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pushProductToBol, startPushAllJob, getPushJobStatus } = require('../pushToBol');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// صور المنتجات بنخزنها في مجلد data (نفس مكان قاعدة البيانات على الـ Persistent Disk)
// عشان متتمسحش مع كل نشر جديد على Render
const uploadsDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `product-${req.params.id}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB أقصى حجم
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('الملف لازم يكون صورة'));
    cb(null, true);
  }
});

router.use(requireAuth);

// ================= المنتجات الأساسية (الشجرة) =================

// جلب المنتجات مع بحث وترقيم صفحات - البحث بيدوّر في اسم/SKU المنتج وكمان EAN أي عرض مرتبط بيه
router.get('/', (req, res) => {
  const { search = '', page = 1, pageSize = 50, lowStockOnly } = req.query;
  const offset = (Number(page) - 1) * Number(pageSize);

  let where = `WHERE (p.sku LIKE ? OR p.name LIKE ? OR EXISTS (
    SELECT 1 FROM product_offers o WHERE o.product_id = p.id AND (o.ean LIKE ? OR o.reference LIKE ?)
  ))`;
  const params = [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`];

  if (lowStockOnly === 'true') {
    where += ' AND p.stock_qty <= p.low_stock_threshold';
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM products p ${where}`).get(...params).c;
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM product_offers o WHERE o.product_id = p.id AND o.active = 1) as offers_count
       FROM products p ${where} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, Number(pageSize), offset);

  res.json({ total, page: Number(page), pageSize: Number(pageSize), products: rows });
});

router.post('/', (req, res) => {
  const { sku, name, cost_price, stock_qty, low_stock_threshold, category, image_url } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'SKU والاسم مطلوبين' });

  try {
    const info = db
      .prepare(
        `INSERT INTO products (sku, name, cost_price, stock_qty, low_stock_threshold, category, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sku,
        name,
        Number(cost_price) || 0,
        Number(stock_qty) || 0,
        Number(low_stock_threshold) || 5,
        category || null,
        image_url || null
      );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'SKU ده موجود قبل كده' });
  }
});

router.put('/:id', (req, res) => {
  const { name, cost_price, stock_qty, low_stock_threshold, category, image_url, active } = req.body;
  db.prepare(
    `UPDATE products SET
      name = COALESCE(?, name),
      cost_price = COALESCE(?, cost_price),
      stock_qty = COALESCE(?, stock_qty),
      low_stock_threshold = COALESCE(?, low_stock_threshold),
      category = ?,
      image_url = COALESCE(?, image_url),
      active = COALESCE(?, active),
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(name, cost_price, stock_qty, low_stock_threshold, category || null, image_url, active, req.params.id);
  res.json({ ok: true });
});

// رفع صورة من الجهاز مباشرة لمنتج موجود
router.post('/:id/image', (req, res) => {
  imageUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'مفيش صورة اتبعتت' });

    const imageUrl = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE products SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      imageUrl,
      req.params.id
    );
    res.json({ ok: true, image_url: imageUrl });
  });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id); // الـ offers بتتمسح تلقائيًا (ON DELETE CASCADE)
  res.json({ ok: true });
});

// ================= العروض/الـ EANs المرتبطة بمنتج معين =================

router.get('/:id/offers', (req, res) => {
  const offers = db
    .prepare(
      `SELECT o.*, a.name as account_name
       FROM product_offers o
       LEFT JOIN bol_accounts a ON a.id = o.account_id
       WHERE o.product_id = ? ORDER BY o.id ASC`
    )
    .all(req.params.id);
  res.json({ offers });
});

router.post('/:id/offers', (req, res) => {
  const { ean, bol_offer_id, reference, sell_price, account_id, units_per_sale } = req.body;
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'المنتج الأساسي مش موجود' });

  const info = db
    .prepare(
      `INSERT INTO product_offers (product_id, account_id, ean, bol_offer_id, reference, sell_price, units_per_sale)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.id,
      account_id || null,
      ean || null,
      bol_offer_id || null,
      reference || null,
      Number(sell_price) || 0,
      Number(units_per_sale) || 1
    );

  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/:id/offers/:offerId', (req, res) => {
  const current = db.prepare('SELECT * FROM product_offers WHERE id = ? AND product_id = ?').get(req.params.offerId, req.params.id);
  if (!current) return res.status(404).json({ error: 'الـ EAN مش موجود' });

  const { ean, bol_offer_id, reference, sell_price, active, account_id, units_per_sale } = req.body;
  db.prepare(
    `UPDATE product_offers SET
      ean = ?, bol_offer_id = ?, reference = ?, account_id = ?,
      sell_price = COALESCE(?, sell_price),
      units_per_sale = COALESCE(?, units_per_sale),
      active = COALESCE(?, active),
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND product_id = ?`
  ).run(
    ean !== undefined ? ean || null : current.ean,
    bol_offer_id !== undefined ? bol_offer_id || null : current.bol_offer_id,
    reference !== undefined ? reference || null : current.reference,
    account_id !== undefined ? account_id || null : current.account_id,
    sell_price,
    units_per_sale,
    active,
    req.params.offerId,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/:id/offers/:offerId', (req, res) => {
  db.prepare('DELETE FROM product_offers WHERE id = ? AND product_id = ?').run(req.params.offerId, req.params.id);
  res.json({ ok: true });
});

// نقل EAN (عرض) من منتجه الأساسي الحالي لمنتج أساسي تاني - بالـ SKU بتاع المنتج الهدف
router.post('/:id/offers/:offerId/move', (req, res) => {
  const { targetSku } = req.body;
  if (!targetSku) return res.status(400).json({ error: 'اكتب SKU المنتج اللي عايز تنقل الـ EAN ليه' });

  const offer = db.prepare('SELECT * FROM product_offers WHERE id = ? AND product_id = ?').get(req.params.offerId, req.params.id);
  if (!offer) return res.status(404).json({ error: 'الـ EAN مش موجود' });

  const targetProduct = db.prepare('SELECT * FROM products WHERE sku = ?').get(targetSku.trim());
  if (!targetProduct) return res.status(404).json({ error: `مفيش منتج بالـ SKU: ${targetSku}` });

  if (targetProduct.id === Number(req.params.id)) {
    return res.status(400).json({ error: 'الـ EAN ده أصلاً جوه المنتج ده' });
  }

  db.prepare('UPDATE product_offers SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    targetProduct.id,
    req.params.offerId
  );

  res.json({ ok: true, movedTo: { id: targetProduct.id, sku: targetProduct.sku, name: targetProduct.name } });
});

// ================= مزامنة مع bol.com =================

// مزامنة منتج واحد فوريًا مع bol.com (بيبعت السعر والمخزون والـ SKU لكل EAN مرتبط بيه)
router.post('/:id/push-to-bol', async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'المنتج مش موجود' });
  try {
    const results = await pushProductToBol(product);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// مزامنة كل المنتجات دفعة واحدة - شغالة في الخلفية
router.post('/push-all-to-bol', (req, res) => {
  const job = startPushAllJob();
  res.json({ ok: true, status: job.status });
});

router.get('/push-all-to-bol/status', (req, res) => {
  res.json(getPushJobStatus());
});

// ================= استيراد CSV جماعي بنظام الشجرة =================
// أعمدة متوقعة: sku,name,cost_price,stock_qty,category,ean,bol_offer_id,reference,sell_price,account_id
// ممكن تكرر نفس sku في أكتر من صف عشان تضيف أكتر من EAN لنفس المنتج
// account_id (اختياري): رقم حساب bol.com من تاب "حسابات bol.com" - لو فاضي، الـ EAN بيتضاف من غير ما يتربط بحساب
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'مفيش ملف' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: 'الملف مش CSV صحيح: ' + e.message });
  }

  const findProduct = db.prepare('SELECT * FROM products WHERE sku = ?');
  const insertProduct = db.prepare(
    `INSERT INTO products (sku, name, cost_price, stock_qty, category) VALUES (?, ?, ?, ?, ?)`
  );
  const updateProduct = db.prepare(
    `UPDATE products SET name = ?, cost_price = ?, stock_qty = ?, category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  const findOfferByEan = db.prepare('SELECT * FROM product_offers WHERE product_id = ? AND ean = ?');
  const insertOffer = db.prepare(
    `INSERT INTO product_offers (product_id, account_id, ean, bol_offer_id, reference, sell_price) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const updateOffer = db.prepare(
    `UPDATE product_offers SET bol_offer_id = ?, reference = ?, sell_price = ?, account_id = COALESCE(?, account_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  );

  let productsCreated = 0;
  let productsUpdated = 0;
  let offersCreated = 0;
  let offersUpdated = 0;
  const errors = [];

  const tx = db.transaction((rows) => {
    for (const row of rows) {
      if (!row.sku || !row.name) {
        errors.push(`صف ناقص sku/name: ${JSON.stringify(row)}`);
        continue;
      }

      let product = findProduct.get(row.sku);
      if (product) {
        updateProduct.run(
          row.name,
          Number(row.cost_price) || product.cost_price,
          row.stock_qty !== undefined && row.stock_qty !== '' ? Number(row.stock_qty) : product.stock_qty,
          row.category || product.category,
          product.id
        );
        productsUpdated++;
      } else {
        const info = insertProduct.run(
          row.sku,
          row.name,
          Number(row.cost_price) || 0,
          Number(row.stock_qty) || 0,
          row.category || null
        );
        product = { id: info.lastInsertRowid };
        productsCreated++;
      }

      // لو الصف فيه بيانات EAN، نضيفه أو نحدّثه كعرض مرتبط بالمنتج ده
      if (row.ean) {
        const accountId = row.account_id ? Number(row.account_id) : null;
        const existingOffer = findOfferByEan.get(product.id, row.ean);
        if (existingOffer) {
          updateOffer.run(
            row.bol_offer_id || existingOffer.bol_offer_id,
            row.reference || existingOffer.reference,
            Number(row.sell_price) || existingOffer.sell_price,
            accountId,
            existingOffer.id
          );
          offersUpdated++;
        } else {
          insertOffer.run(
            product.id,
            accountId,
            row.ean,
            row.bol_offer_id || null,
            row.reference || row.sku,
            Number(row.sell_price) || 0
          );
          offersCreated++;
        }
      }
    }
  });
  tx(records);

  res.json({
    ok: true,
    totalRows: records.length,
    productsCreated,
    productsUpdated,
    offersCreated,
    offersUpdated,
    errors
  });
});

module.exports = router;
