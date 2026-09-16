const { parse } = require('csv-parse/sync');
const db = require('./db');
const bol = require('./bolClient');

/**
 * بيسحب كل عروض حساب bol.com معين ويحطها في النظام:
 * - لو الـ EAN موجود عندك بالفعل كعرض مرتبط بنفس الحساب ده -> يحدّث السعر والـ Offer ID بس
 * - لو الـ EAN جديد بس الـ SKU (referenceCode) بتاعه بيطابق منتج أساسي عندك -> بيضيفه كـ EAN جديد على نفس المنتج
 * - لو مفيش تطابق خالص -> بيعمل منتج أساسي جديد مستقل بيه EAN واحد
 *
 * ملحوظة: bol.com مبيرجعش اسم المنتج في ملف التصدير، فالمنتجات الجديدة بتتضاف باسم مؤقت.
 */
async function importOffersFromBol(accountId) {
  const account = db.prepare('SELECT * FROM bol_accounts WHERE id = ?').get(accountId);
  if (!account) {
    throw new Error('الحساب المطلوب غير موجود');
  }

  const exportRequest = await bol.requestOfferExport(account);
  const processStatusId = exportRequest.processStatusId;
  if (!processStatusId) {
    throw new Error('bol.com مردتش processStatusId - راجع رد الـ API');
  }

  const reportId = await bol.waitForExportReady(account, processStatusId);
  const csvText = await bol.downloadOfferExportCsv(account, reportId);

  const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

  let offersUpdated = 0;
  let offersAddedToExisting = 0;
  let productsCreated = 0;
  const errors = [];

  const findOfferByEanAndAccount = db.prepare('SELECT * FROM product_offers WHERE ean = ? AND account_id = ?');
  const findAnyOfferByEan = db.prepare('SELECT * FROM product_offers WHERE ean = ? LIMIT 1');
  const findProductBySku = db.prepare('SELECT * FROM products WHERE sku = ?');
  const updateOfferStmt = db.prepare(
    `UPDATE product_offers SET bol_offer_id = ?, sell_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  const insertOfferStmt = db.prepare(
    `INSERT INTO product_offers (product_id, account_id, ean, bol_offer_id, reference, sell_price) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertProductStmt = db.prepare(
    `INSERT INTO products (sku, name, cost_price, stock_qty) VALUES (?, ?, 0, ?)`
  );

  const tx = db.transaction((offerRows) => {
    for (const row of offerRows) {
      try {
        const ean = row.ean?.trim();
        const sku = row.referenceCode?.trim();
        const offerId = row.offerId?.trim();
        const sellPrice = parseFloat(row.bundlePricesPrice) || 0;
        const stockQty = parseInt(row.stockAmount, 10) || 0;

        if (!ean) {
          errors.push(`صف من غير EAN اتجاهل (offerId: ${offerId})`);
          continue;
        }

        const existingOffer = findOfferByEanAndAccount.get(ean, accountId);
        if (existingOffer) {
          updateOfferStmt.run(offerId, sellPrice, existingOffer.id);
          offersUpdated++;
          continue;
        }

        // نفس الـ EAN ده مرتبط بمنتج عندنا بالفعل تحت حساب تاني (نفس القطعة الفعلية بتتباع من حسابين)
        // -> نربطه بنفس المنتج الموجود، مش نعمل واحد جديد
        const sameEanOtherAccount = findAnyOfferByEan.get(ean);
        if (sameEanOtherAccount) {
          insertOfferStmt.run(sameEanOtherAccount.product_id, accountId, ean, offerId, sku, sellPrice);
          offersAddedToExisting++;
          continue;
        }

        // مفيش عرض بنفس الـ EAN خالص - نشوف هل الـ SKU (referenceCode) بيطابق منتج أساسي موجود
        let product = sku ? findProductBySku.get(sku) : null;

        // احتياطي: هل اسم SKU الافتراضي بتاعنا (bol-<ean>) مستخدم من قبل؟ (يحصل لو نفس EAN
        // اتجاب قبل كده من غير referenceCode وعمل منتج مستقل بنفس الاسم الاحتياطي ده)
        const finalSku = sku || `bol-${ean}`;
        if (!product) {
          product = findProductBySku.get(finalSku);
        }

        if (product) {
          insertOfferStmt.run(product.id, accountId, ean, offerId, sku, sellPrice);
          offersAddedToExisting++;
        } else {
          const tempName = `(بدون اسم - عدّله) ${sku || ean}`;
          try {
            const info = insertProductStmt.run(finalSku, tempName, stockQty);
            insertOfferStmt.run(info.lastInsertRowid, accountId, ean, offerId, sku, sellPrice);
            productsCreated++;
          } catch (e) {
            errors.push(`فشل إضافة منتج جديد (SKU: ${finalSku}): ${e.message}`);
          }
        }
      } catch (e) {
        errors.push(`خطأ في معالجة صف: ${e.message}`);
      }
    }
  });

  tx(rows);

  return { totalRows: rows.length, offersUpdated, offersAddedToExisting, productsCreated, errors };
}

let currentJob = { status: 'idle' };

function getImportJobStatus() {
  return currentJob;
}

function startImportJob(accountId) {
  if (currentJob.status === 'running') {
    return currentJob;
  }
  currentJob = { status: 'running', startedAt: new Date().toISOString() };

  importOffersFromBol(accountId)
    .then((result) => {
      currentJob = { status: 'success', finishedAt: new Date().toISOString(), result };
    })
    .catch((e) => {
      currentJob = {
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: e.response?.data?.detail || e.message
      };
    });

  return currentJob;
}

module.exports = { importOffersFromBol, startImportJob, getImportJobStatus };
