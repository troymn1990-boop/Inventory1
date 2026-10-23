const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pushProductToBol, startPushAllJob, getPushJobStatus } = require('../pushToBol');
const bol = require('../bolClient');

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

// الـ SKU التلقائي للـ EAN: SKU الشجرة + عدد القطع (مثلاً SPEZ001S + 4 = SPEZ001S4)
// لو العرض قطعة واحدة بس، بياخد SKU الشجرة زي ما هو
function autoReference(sku, units) {
  const n = Number(units) || 1;
  return n > 1 ? `${sku}${n}` : sku;
}

// عروض الكومبو (طباخ + قناني): الصيغة الموحدة = SKU الطباخ + GASS + عدد القناني (مثلاً DGK1GASS10)
// الصيغة القديمة كانت مقلوبة: DGK + عدد القناني + GASS + موديل الطباخ (مثلاً DGK10GASS1)
const GAS_TREE_SKU = process.env.GAS_TREE_SKU || 'BUT227S1';
const GASS_REGEX = /^([A-Za-z]+)(\d+)GASS(\d+)$/i;
// الصيغة الموحدة الحالية: SKU الطباخ + SKU شجرة القناني + عدد القناني (مثلاً DGK1BUT227S4)
// الجزء الثابت من SKU القناني: BUT227S1 -> BUT227S (الرقم الأخير = قطعة واحدة، فبنستبدله بعدد القناني)
const GAS_COMBO_PREFIX = process.env.GAS_COMBO_PREFIX || GAS_TREE_SKU.replace(/1$/, '');
function comboRef(cookerSku, cans) { return `${cookerSku}${GAS_COMBO_PREFIX}${Number(cans)}`; }
// لو الـ reference بالصيغة الموحدة بيرجع { prefix, cans }
function parseComboRef(ref) {
  const s = String(ref || '');
  const g = GAS_COMBO_PREFIX.toUpperCase();
  const up = s.toUpperCase();
  const idx = up.lastIndexOf(g);
  if (idx <= 0) return null;
  const tail = s.slice(idx + g.length);
  if (!/^[1-9]\d*$/.test(tail)) return null;
  return { prefix: s.slice(0, idx), cans: Number(tail) };
}

// بيربط العرض بشجرة القناني: كل بيعة بتسحب cans قناني
function linkGasComponent(offerId, cans) {
  const gas = db.prepare('SELECT id FROM products WHERE sku = ?').get(GAS_TREE_SKU);
  if (!gas) return false;
  db.prepare('DELETE FROM offer_components WHERE offer_id = ? AND product_id = ?').run(offerId, gas.id);
  db.prepare('INSERT INTO offer_components (offer_id, product_id, quantity) VALUES (?, ?, ?)').run(offerId, gas.id, cans);
  return true;
}

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
    const newId = info.lastInsertRowid;

    // ضم تلقائي: أي EAN الـ SKU (reference) بتاعه بيبدأ بـ SKU الشجرة الجديدة، بشرط إن الحرف اللي بعده مش رقم
    // (عشان DGK1 ميمسكش DGK10 أو DGK12). والعروض اللي جوه شجرة SKU بتاعها مطابق تماماً للـ reference مش بتتحرك.
    let adopted = 0;
    let adoptedWithSuffix = 0;
    let adoptedGas = 0;
    let gasLinked = 0;
    const candidates = db
      .prepare(
        `SELECT o.id, o.reference, o.product_id, p.sku AS parent_sku, p.name AS parent_name
         FROM product_offers o JOIN products p ON p.id = o.product_id
         WHERE o.product_id != ? AND o.reference IS NOT NULL
           AND (o.reference LIKE ? ESCAPE '\\' OR o.reference LIKE '%GASS%')`
      )
      .all(newId, String(sku).replace(/[\\%_]/g, '\\$&') + '%');

    const touchedParents = new Set();
    const mirrorParents = new Set();
    const moveOffer = db.prepare('UPDATE product_offers SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    db.transaction(() => {
      for (const c of candidates) {
        // عروض الكومبو بالصيغة القديمة (DGK10GASS1) أو الجديدة (DGK1GASS10)
        const m = GASS_REGEX.exec(c.reference);
        if (m) {
          const [, letters, first, second] = m;
          let newRef = null;
          let cans = null;
          if (letters + second === sku && letters + first !== sku) {
            newRef = comboRef(sku, first); // قديمة -> نقلبها للصيغة الموحدة
            cans = Number(first);
          } else if (letters + first === sku) {
            newRef = comboRef(sku, second);
            cans = Number(second);
          }
          if (newRef) {
            db.prepare('UPDATE product_offers SET product_id = ?, reference = ?, units_per_sale = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newId, newRef, c.id);
            touchedParents.add(c.product_id);
            // الشجرة اللي SKU بتاعها = الـ reference نفسه (نسخة من العرض ده بس) بتتمسح لو فضيت
            if (c.parent_sku === c.reference) mirrorParents.add(c.product_id);
            adopted++;
            adoptedGas++;
            if (linkGasComponent(c.id, cans)) gasLinked++;
            continue;
          }
        }

        if (c.parent_sku === c.reference) continue; // شجرة تانية بنفس الـ SKU بالظبط (مش كومبو)
        if (!c.reference.startsWith(sku)) continue; // LIKE مش حساس لحالة الأحرف
        const rest = c.reference.slice(sku.length);
        if (/^\d/.test(rest)) continue; // الحرف اللي بعد الـ SKU رقم -> موديل تاني
        moveOffer.run(newId, c.id);
        touchedParents.add(c.product_id);
        adopted++;
        const pc = parseComboRef(c.reference);
        if (pc && pc.prefix === sku && sku !== GAS_TREE_SKU) {
          db.prepare('UPDATE product_offers SET units_per_sale = 1 WHERE id = ?').run(c.id);
          adoptedGas++;
          if (linkGasComponent(c.id, pc.cans)) gasLinked++;
        } else if (rest) adoptedWithSuffix++;
      }

      // الأشجار المؤقتة (اللي اتعملت من الاستيراد باسم "بدون اسم") اللي فضيت بعد النقل بتتمسح تلقائي
      for (const pid of touchedParents) {
        const left = db.prepare('SELECT COUNT(*) AS c FROM product_offers WHERE product_id = ?').get(pid).c;
        const salesLeft = db.prepare('SELECT COUNT(*) AS c FROM sales WHERE product_id = ?').get(pid).c;
        const parent = db.prepare('SELECT name FROM products WHERE id = ?').get(pid);
        if (left === 0 && salesLeft === 0 && parent && (parent.name.startsWith('(بدون اسم') || mirrorParents.has(pid))) {
          db.prepare('DELETE FROM products WHERE id = ?').run(pid);
        }
      }
    })();

    res.json({ ok: true, id: newId, adopted, adoptedWithSuffix, adoptedGas, gasLinked, gasTreeSku: GAS_TREE_SKU });
  } catch (e) {
    res.status(400).json({ error: 'SKU ده موجود قبل كده' });
  }
});

router.put('/:id', (req, res) => {
  const { sku, name, cost_price, stock_qty, low_stock_threshold, category, image_url, active } = req.body;
  const newSku = typeof sku === 'string' ? sku.trim() : '';
  if (newSku) {
    const current = db.prepare('SELECT sku FROM products WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'المنتج مش موجود' });
    if (current.sku !== newSku) {
      const dup = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(newSku, req.params.id);
      if (dup) return res.status(400).json({ error: 'SKU ده موجود قبل كده' });
      db.prepare('UPDATE products SET sku = ? WHERE id = ?').run(newSku, req.params.id);
    }
  }
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
  try {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id); // الـ offers بتتمسح تلقائيًا (ON DELETE CASCADE)
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'تعذّر حذف المنتج: ' + e.message });
  }
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
  const product = db.prepare('SELECT id, sku FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'المنتج الأساسي مش موجود' });

  // لو مكتبتش Reference بإيدك، بيتولد تلقائي: SKU الشجرة + عدد القطع
  const finalReference = reference && String(reference).trim() ? String(reference).trim() : autoReference(product.sku, units_per_sale);

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
      finalReference,
      Number(sell_price) || 0,
      Number(units_per_sale) || 1
    );

  res.json({ ok: true, id: info.lastInsertRowid, reference: finalReference });
});

router.put('/:id/offers/:offerId', (req, res) => {
  const current = db.prepare('SELECT * FROM product_offers WHERE id = ? AND product_id = ?').get(req.params.offerId, req.params.id);
  if (!current) return res.status(404).json({ error: 'الـ EAN مش موجود' });

  const { ean, bol_offer_id, sell_price, active, account_id, units_per_sale } = req.body;
  let { reference } = req.body;

  // لو غيّرت عدد القطع ومغيّرتش الـ Reference بإيدك، الـ SKU بيتحدّث تلقائي
  if (units_per_sale !== undefined && reference === undefined) {
    const parent = db.prepare('SELECT sku FROM products WHERE id = ?').get(req.params.id);
    if (parent) reference = autoReference(parent.sku, units_per_sale);
  }

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

// توحيد الـ SKU لكل EANs الشجرة: كل واحد بيبقى SKU الشجرة + عدد القطع (SPEZ001S، SPEZ001S4، SPEZ001S10...)
router.post('/:id/normalize-references', (req, res) => {
  const product = db.prepare('SELECT id, sku FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'المنتج الأساسي مش موجود' });

  const offers = db.prepare('SELECT id, reference, units_per_sale FROM product_offers WHERE product_id = ?').all(product.id);
  const upd = db.prepare('UPDATE product_offers SET reference = ?, units_per_sale = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const gas = db.prepare('SELECT id FROM products WHERE sku = ?').get(GAS_TREE_SKU);
  const gasComp = db.prepare('SELECT quantity FROM offer_components WHERE offer_id = ? AND product_id = ?');
  let changed = 0;
  let combos = 0;
  let unitsReset = 0;
  db.transaction(() => {
    for (const o of offers) {
      const comp = gas ? gasComp.get(o.id, gas.id) : null;
      let newRef, newUnits;
      if (comp) {
        // عرض كومبو (طباخ + قناني): SKU الشجرة + SKU شجرة القناني + عدد القناني (DGK1BUT227S4)، وقطعة طباخ واحدة بس لكل بيعة
        newRef = comboRef(product.sku, comp.quantity);
        newUnits = 1;
        combos++;
        if ((o.units_per_sale || 1) !== 1) unitsReset++;
      } else {
        newRef = autoReference(product.sku, o.units_per_sale);
        newUnits = o.units_per_sale || 1;
      }
      if (o.reference !== newRef || (o.units_per_sale || 1) !== newUnits) {
        upd.run(newRef, newUnits, o.id);
        changed++;
      }
    }
  })();

  res.json({ ok: true, total: offers.length, changed, combos, unitsReset });
});

router.delete('/:id/offers/:offerId', (req, res) => {
  try {
    db.transaction(() => {
      // المبيعات القديمة بتفضل محفوظة (للتقارير) بس بتتفك من العرض المحذوف - وده كان سبب إن الحذف بيفشل
      db.prepare('UPDATE sales SET offer_id = NULL WHERE offer_id = ?').run(req.params.offerId);
      db.prepare('DELETE FROM product_offers WHERE id = ? AND product_id = ?').run(req.params.offerId, req.params.id);
    })();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'تعذّر حذف الـ EAN: ' + e.message });
  }
});

// دمج منتج أساسي كامل (كل EANs بتاعته) جوه منتج أساسي تاني دفعة واحدة
// مفيد لما يكون عندك شجرة منفصلة لعرض "طقم" وعايز تخليها تسحب من نفس مخزون الشجرة الرئيسية
router.post('/:id/merge-into', (req, res) => {
  const { targetSku, unitsPerSale } = req.body;
  if (!targetSku) return res.status(400).json({ error: 'اكتب SKU المنتج اللي عايز تدمج فيه' });

  const sourceProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!sourceProduct) return res.status(404).json({ error: 'المنتج مش موجود' });

  const targetProduct = db.prepare('SELECT * FROM products WHERE sku = ?').get(targetSku.trim());
  if (!targetProduct) return res.status(404).json({ error: `مفيش منتج بالـ SKU: ${targetSku}` });

  if (targetProduct.id === sourceProduct.id) {
    return res.status(400).json({ error: 'مينفعش تدمج المنتج في نفسه' });
  }

  const offersCount = db.prepare('SELECT COUNT(*) as c FROM product_offers WHERE product_id = ?').get(sourceProduct.id).c;
  const salesCount = db.prepare('SELECT COUNT(*) as c FROM sales WHERE product_id = ?').get(sourceProduct.id).c;
  if (offersCount === 0 && salesCount === 0) {
    return res.status(400).json({ error: 'المنتج ده مالوش أي EANs ولا مبيعات أصلًا عشان تدمجه' });
  }

  // كل الخطوات في transaction واحدة: لو أي خطوة فشلت، مفيش حاجة بتتغير
  const doMerge = db.transaction(() => {
    if (offersCount > 0) {
      // الـ EANs المنقولة بتاخد SKU الشجرة الهدف + عدد القطع (مثلاً SPEZ001S4) تلقائيًا
      const gasCans = Number(req.body.gasCans) > 0 ? Number(req.body.gasCans) : null;
      const gasTree = db.prepare('SELECT id FROM products WHERE sku = ?').get(GAS_TREE_SKU);
      const srcAll = db.prepare('SELECT id, units_per_sale FROM product_offers WHERE product_id = ?').all(sourceProduct.id);
      const existingGas = db.prepare('SELECT quantity FROM offer_components WHERE offer_id = ? AND product_id = ?');
      if (gasCans || (gasTree && srcAll.some((o) => existingGas.get(o.id, gasTree.id)))) {
        // عروض كومبو (طباخ + قناني): SKU = الطباخ + BUT227S + عدد القناني، وقطعة طباخ واحدة بس لكل بيعة
        const updCombo = db.prepare(
          'UPDATE product_offers SET product_id = ?, reference = ?, units_per_sale = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        for (const o of srcAll) {
          const comp = gasTree ? existingGas.get(o.id, gasTree.id) : null;
          const cans = gasCans || (comp && comp.quantity);
          if (cans) {
            if (gasCans) linkGasComponent(o.id, gasCans);
            updCombo.run(targetProduct.id, comboRef(targetProduct.sku, cans), 1, o.id);
          } else {
            updCombo.run(targetProduct.id, autoReference(targetProduct.sku, o.units_per_sale), o.units_per_sale || 1, o.id);
          }
        }
      } else if (unitsPerSale) {
        db.prepare(
          'UPDATE product_offers SET product_id = ?, reference = ?, units_per_sale = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?'
        ).run(targetProduct.id, autoReference(targetProduct.sku, unitsPerSale), Number(unitsPerSale), sourceProduct.id);
      } else {
        const srcOffers = db.prepare('SELECT id, units_per_sale FROM product_offers WHERE product_id = ?').all(sourceProduct.id);
        const upd = db.prepare(
          'UPDATE product_offers SET product_id = ?, reference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        for (const o of srcOffers) {
          upd.run(targetProduct.id, autoReference(targetProduct.sku, o.units_per_sale), o.id);
        }
      }
    }

    // ننقل سجل المبيعات القديم عشان تقارير الأرباح تفضل سليمة
    if (salesCount > 0) {
      db.prepare('UPDATE sales SET product_id = ? WHERE product_id = ?').run(targetProduct.id, sourceProduct.id);
    }

    // لو المنتج المصدر كان مستخدم كـ "مكوّن إضافي" في عروض كومبو، ننقل الربط للشجرة الهدف
    db.prepare('UPDATE offer_components SET product_id = ? WHERE product_id = ?').run(targetProduct.id, sourceProduct.id);

    // المنتج المصدر بقى فاضي بالكامل - نمسحه تلقائي
    db.prepare('DELETE FROM products WHERE id = ?').run(sourceProduct.id);
  });

  try {
    doMerge();
  } catch (e) {
    return res.status(400).json({ error: 'فشل الدمج: ' + e.message });
  }

  res.json({
    ok: true,
    movedOffers: offersCount,
    movedSales: salesCount,
    sourceDeleted: true,
    targetProduct: { id: targetProduct.id, sku: targetProduct.sku, name: targetProduct.name }
  });
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

  // الـ EAN المنقول بياخد SKU الشجرة الهدف تلقائيًا
  db.prepare('UPDATE product_offers SET product_id = ?, reference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    targetProduct.id,
    autoReference(targetProduct.sku, offer.units_per_sale),
    req.params.offerId
  );

  res.json({ ok: true, movedTo: { id: targetProduct.id, sku: targetProduct.sku, name: targetProduct.name } });
});

// ================= مكونات إضافية (لعروض الكومبو زي "طباخ + 4 قناني غاز") =================

router.get('/:id/offers/:offerId/components', (req, res) => {
  const components = db
    .prepare(
      `SELECT c.*, p.sku as product_sku, p.name as product_name
       FROM offer_components c JOIN products p ON p.id = c.product_id
       WHERE c.offer_id = ?`
    )
    .all(req.params.offerId);
  res.json({ components });
});

router.post('/:id/offers/:offerId/components', (req, res) => {
  const { componentSku, quantity } = req.body;
  if (!componentSku || !quantity) return res.status(400).json({ error: 'SKU المنتج والكمية مطلوبين' });

  const offer = db.prepare('SELECT * FROM product_offers WHERE id = ? AND product_id = ?').get(req.params.offerId, req.params.id);
  if (!offer) return res.status(404).json({ error: 'الـ EAN مش موجود' });

  const componentProduct = db.prepare('SELECT * FROM products WHERE sku = ?').get(componentSku.trim());
  if (!componentProduct) return res.status(404).json({ error: `مفيش منتج بالـ SKU: ${componentSku}` });

  if (componentProduct.id === Number(req.params.id)) {
    return res.status(400).json({ error: 'المنتج ده أصلاً المنتج الأساسي بتاع الـ EAN ده' });
  }

  const qty = Number(quantity);
  if (!(qty > 0)) return res.status(400).json({ error: 'الكمية لازم تكون رقم أكبر من صفر' });

  // applyToAll: نفس المكون بنفس الكمية يتضاف لكل EANs الشجرة (ولو EAN عنده المكون ده قبل كده بيتحدث بالكمية الجديدة)
  const targets = req.body.applyToAll
    ? db.prepare('SELECT id FROM product_offers WHERE product_id = ?').all(req.params.id).map((o) => o.id)
    : [offer.id];
  const del = db.prepare('DELETE FROM offer_components WHERE offer_id = ? AND product_id = ?');
  const ins = db.prepare('INSERT INTO offer_components (offer_id, product_id, quantity) VALUES (?, ?, ?)');
  let lastId = null;
  db.transaction(() => {
    for (const oid of targets) {
      del.run(oid, componentProduct.id);
      lastId = ins.run(oid, componentProduct.id, qty).lastInsertRowid;
    }
  })();

  res.json({ ok: true, id: lastId, applied: targets.length });
});

router.delete('/:id/offers/:offerId/components/:componentId', (req, res) => {
  db.prepare('DELETE FROM offer_components WHERE id = ? AND offer_id = ?').run(req.params.componentId, req.params.offerId);
  res.json({ ok: true });
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

// ================= سحب صور المنتجات من bol.com =================
// بيدوّر على كل منتج مالوش صورة، ياخد أول EAN ليه (بحساب bol.com مربوط)، يسحب الصورة الأساسية من الكتالوج ويحفظ رابطها.
// المنتجات اللي ليها صورة (مرفوعة أو رابط بإيدك) مش بيتلمس.
let imageJob = { status: 'idle' };
async function runFetchImages(force) {
  const rows = db
    .prepare(
      `SELECT p.id, p.sku, o.ean, o.account_id
       FROM products p JOIN product_offers o ON o.product_id = p.id
       WHERE ${force ? '1=1' : "(p.image_url IS NULL OR p.image_url = '')"} AND o.ean IS NOT NULL AND o.ean != '' AND o.account_id IS NOT NULL
       ORDER BY p.id, o.id`
    )
    .all();
  const seen = new Set();
  const todo = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  imageJob = { status: 'running', total: todo.length, done: 0, found: 0, missing: 0, failed: 0 };
  const accounts = new Map();
  const setImg = db.prepare('UPDATE products SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  for (const r of todo) {
    try {
      if (!accounts.has(r.account_id)) accounts.set(r.account_id, db.prepare('SELECT * FROM bol_accounts WHERE id = ?').get(r.account_id));
      const account = accounts.get(r.account_id);
      const url = account ? await bol.getProductImageUrl(account, r.ean) : null;
      if (url) { setImg.run(url, r.id); imageJob.found++; } else imageJob.missing++;
    } catch (e) {
      imageJob.failed++;
      imageJob.lastError = e.response?.data?.detail || e.response?.data?.title || e.message;
    }
    imageJob.done++;
    await new Promise((res) => setTimeout(res, 250));
  }
  imageJob.status = 'done';
}

router.post('/fetch-images', (req, res) => {
  if (imageJob.status === 'running') return res.json({ ok: true, job: imageJob });
  runFetchImages(!!req.body?.force).catch((e) => { imageJob = { status: 'error', error: e.message }; });
  res.json({ ok: true, job: { status: 'running', total: 0, done: 0 } });
});
// تلقائي: بعد تشغيل السيرفر بنص دقيقة، وبعدها كل 6 ساعات - بيكمّل صور المنتجات الجديدة اللي لسه ملهاش صورة
const autoImages = () => { if (imageJob.status !== 'running') runFetchImages(false).catch(() => {}); };
setTimeout(autoImages, 30000);
setInterval(autoImages, 6 * 60 * 60 * 1000);
router.get('/fetch-images/status', (req, res) => res.json({ job: imageJob }));

// تحويل كل عروض الكومبو (طباخ + قناني) الموجودة: يقلب الـ SKU القديم للصيغة الموحدة،
// ينقل العرض لشجرة الطباخ، ويربطه بشجرة القناني بالعدد المناسب
router.post('/convert-gass-skus', (req, res) => {
  const findTree = db.prepare('SELECT id, sku, name FROM products WHERE sku = ?');
  const offers = db
    .prepare('SELECT id, product_id, reference FROM product_offers WHERE reference IS NOT NULL')
    .all()
    .filter((o) => GASS_REGEX.test(o.reference) || parseComboRef(o.reference));

  const stats = { found: offers.length, converted: 0, moved: 0, linked: 0, alreadyOk: 0 };
  const skipped = [];
  let gasMissing = false;
  const touchedParents = new Set();
  const mirrorParents = new Set();

  db.transaction(() => {
    for (const o of offers) {
      const gm = GASS_REGEX.exec(o.reference);
      let tree, newRef, cans;

      if (gm) {
        const [, letters, first, second] = gm;
        const oldTree = findTree.get(letters + second); // DGK4GASS1 -> شجرة DGK1، 4 قناني
        const newTree = findTree.get(letters + first); // DGK1GASS4 -> شجرة DGK1، 4 قناني
        if (oldTree && newTree) { skipped.push(`${o.reference} (ملتبس: الشجرتين ${oldTree.sku} و ${newTree.sku} موجودين)`); continue; }
        if (oldTree) { tree = oldTree; cans = Number(first); }
        else if (newTree) { tree = newTree; cans = Number(second); }
        else { skipped.push(`${o.reference} (مفيش شجرة طباخ بـ SKU مناسب)`); continue; }
      } else {
        const pc = parseComboRef(o.reference); // DGK1BUT227S4
        tree = pc && findTree.get(pc.prefix);
        if (!tree) { skipped.push(`${o.reference} (مفيش شجرة طباخ بـ SKU مناسب)`); continue; }
        cans = pc.cans;
      }
      newRef = comboRef(tree.sku, cans);

      if (tree.sku === GAS_TREE_SKU) { skipped.push(`${o.reference} (الشجرة هي شجرة القناني نفسها)`); continue; }

      const changedRef = newRef !== o.reference;
      const changedTree = o.product_id !== tree.id;
      db.prepare('UPDATE product_offers SET product_id = ?, reference = ?, units_per_sale = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(tree.id, newRef, o.id);
      if (changedRef) stats.converted++;
      if (changedTree) {
        stats.moved++;
        touchedParents.add(o.product_id);
        const src = db.prepare('SELECT sku FROM products WHERE id = ?').get(o.product_id);
        if (src && src.sku === o.reference) mirrorParents.add(o.product_id); // شجرة نسخة من العرض ده بس
      }
      if (!changedRef && !changedTree) stats.alreadyOk++;
      if (linkGasComponent(o.id, cans)) stats.linked++;
      else gasMissing = true;
    }

    // الأشجار المؤقتة اللي فضيت بعد النقل بتتمسح تلقائي
    for (const pid of touchedParents) {
      const left = db.prepare('SELECT COUNT(*) AS c FROM product_offers WHERE product_id = ?').get(pid).c;
      const salesLeft = db.prepare('SELECT COUNT(*) AS c FROM sales WHERE product_id = ?').get(pid).c;
      const parent = db.prepare('SELECT name FROM products WHERE id = ?').get(pid);
      if (left === 0 && salesLeft === 0 && parent && (parent.name.startsWith('(بدون اسم') || mirrorParents.has(pid))) {
        db.prepare('DELETE FROM products WHERE id = ?').run(pid);
      }
    }
  })();

  res.json({ ok: true, ...stats, skipped: skipped.slice(0, 30), skippedCount: skipped.length, gasMissing, gasTreeSku: GAS_TREE_SKU });
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
