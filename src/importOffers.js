const { parse } = require('csv-parse/sync');
const db = require('./db');
const bol = require('./bolClient');

/**
 * بيسحب كل عروضك من bol.com ويحطها في النظام:
 * - لو الـ EAN موجود عندك بالفعل كعرض مرتبط بمنتج -> يحدّث السعر والـ Offer ID بس (مبيلمسش المخزون المحلي)
 * - لو الـ EAN جديد كليًا بس الـ SKU (referenceCode) بتاعه بيطابق منتج أساسي عندك -> بيضيفه كـ EAN جديد على نفس المنتج (تجميع تلقائي للشجرة)
 * - لو مفيش تطابق خالص -> بيعمل منتج أساسي جديد مستقل بيه EAN واحد (وتقدر تدموجه يدويًا مع منتج تاني بعدين)
 *
 * ملحوظة: bol.com مبيرجعش اسم المنتج في ملف التصدير، فالمنتجات الجديدة بتتضاف باسم مؤقت.
 */
async function importOffersFromBol() {
  const exportRequest = await bol.requestOfferExport();
  const processStatusId = exportRequest.processStatusId;
  if (!processStatusId) {
    throw new Error('bol.com مردتش processStatusId - راجع رد الـ API');
  }

  const reportId = await bol.waitForExportReady(processStatusId);
  const csvText = await bol.downloadOfferExportCsv(reportId);

  const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

  let offersUpdated = 0;
  let offersAddedToExisting = 0;
  let productsCreated = 0;
  const errors = [];

  const findOfferByEan = db.prepare('SELECT * FROM product_offers WHERE ean = ?');
  const findProductBySku = db.prepare('SELECT * FROM products WHERE sku = ?');
  const updateOfferStmt = db.prepare(
    `UPDATE product_offers SET bol_offer_id = ?, sell_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  const insertOfferStmt = db.prepare(
    `INSERT INTO product_offers (product_id, ean, bol_offer_id, reference, sell_price) VALUES (?, ?, ?, ?, ?)`
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

        const existingOffer = findOfferByEan.get(ean);
        if (existingOffer) {
          updateOfferStmt.run(offerId, sellPrice, existingOffer.id);
          offersUpdated++;
          continue;
        }

        // مفيش عرض بنفس الـ EAN - نشوف هل الـ SKU بتاعه بيطابق منتج أساسي موجود
        let product = sku ? findProductBySku.get(sku) : null;

        if (product) {
          insertOfferStmt.run(product.id, ean, offerId, sku, sellPrice);
          offersAddedToExisting++;
        } else {
          const finalSku = sku || `bol-${ean}`;
          const tempName = `(بدون اسم - عدّله) ${sku || ean}`;
          try {
            const info = insertProductStmt.run(finalSku, tempName, stockQty);
            insertOfferStmt.run(info.lastInsertRowid, ean, offerId, sku, sellPrice);
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

function startImportJob() {
  if (currentJob.status === 'running') {
    return currentJob;
  }
  currentJob = { status: 'running', startedAt: new Date().toISOString() };

  importOffersFromBol()
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
