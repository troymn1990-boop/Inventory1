const { parse } = require('csv-parse/sync');
const db = require('./db');
const bol = require('./bolClient');

/**
 * بيسحب كل العروض بتاعتك من bol.com ويطابقها مع المخزون المحلي:
 * - لو لقى منتج بنفس الـ EAN أو نفس الـ SKU (referenceCode) -> يحدّث سعر البيع والمخزون و Offer ID
 * - لو مفيش تطابق -> يضيف صنف جديد (باسم مؤقت، لأن bol.com مبيرجعش اسم المنتج في ملف التصدير)
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

  let updated = 0;
  let created = 0;
  const errors = [];

  const findByEan = db.prepare('SELECT * FROM products WHERE ean = ?');
  const findBySku = db.prepare('SELECT * FROM products WHERE sku = ?');
  const updateStmt = db.prepare(
    `UPDATE products SET
      ean = ?, bol_offer_id = ?, sell_price = ?, stock_qty = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );
  const insertStmt = db.prepare(
    `INSERT INTO products (sku, ean, bol_offer_id, name, cost_price, sell_price, stock_qty)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  );

  const tx = db.transaction((offerRows) => {
    for (const row of offerRows) {
      try {
        const ean = row.ean?.trim();
        const sku = row.referenceCode?.trim();
        const offerId = row.offerId?.trim();
        const sellPrice = parseFloat(row.bundlePricesPrice) || 0;
        const stockQty = parseInt(row.stockAmount, 10) || 0;

        if (!ean && !sku) {
          errors.push(`صف من غير EAN ولا SKU اتجاهل (offerId: ${offerId})`);
          continue;
        }

        let existing = null;
        if (ean) existing = findByEan.get(ean);
        if (!existing && sku) existing = findBySku.get(sku);

        if (existing) {
          updateStmt.run(ean || existing.ean, offerId, sellPrice, stockQty, existing.id);
          updated++;
        } else {
          // مفيش اسم متاح من bol.com في ملف التصدير - بنحط اسم مؤقت لحد ما تعدّله
          const tempName = `(بدون اسم - عدّله) ${sku || ean}`;
          const finalSku = sku || `bol-${ean}`;
          try {
            insertStmt.run(finalSku, ean || null, offerId, tempName, sellPrice, stockQty);
            created++;
          } catch (e) {
            errors.push(`فشل إضافة صنف جديد (SKU: ${finalSku}): ${e.message}`);
          }
        }
      } catch (e) {
        errors.push(`خطأ في معالجة صف: ${e.message}`);
      }
    }
  });

  tx(rows);

  return { totalRows: rows.length, updated, created, errors };
}

let currentJob = { status: 'idle' };

function getImportJobStatus() {
  return currentJob;
}

// بيبدأ الاستيراد في الخلفية من غير ما يخلّي المتصفح مستني رد فوري
// (عشان نتفادى timeout بتاع الاستضافة لو العملية طالت)
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
