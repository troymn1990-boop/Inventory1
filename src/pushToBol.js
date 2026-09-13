const db = require('./db');
const bol = require('./bolClient');

/**
 * بيبعت آخر بيانات المنتج لكل الـ EANs (العروض) المرتبطة بيه على bol.com:
 * - نفس المخزون المشترك بيتبعت لكل EAN مرتبط (المنصة هي مصدر الحقيقة للمخزون)
 * - كل EAN بياخد سعره الخاص بيه
 * - كل EAN بياخد الـ reference (SKU) الخاص بيه
 */
async function pushProductToBol(product) {
  const offers = db
    .prepare(
      `SELECT o.*, a.name as account_name, a.client_id, a.client_secret
       FROM product_offers o
       LEFT JOIN bol_accounts a ON a.id = o.account_id
       WHERE o.product_id = ? AND o.active = 1 AND o.bol_offer_id IS NOT NULL AND o.bol_offer_id != ''`
    )
    .all(product.id);

  if (!offers.length) {
    throw new Error('المنتج ده لسه مالوش أي EAN مربوط بـ Offer ID على bol.com');
  }

  const results = [];

  for (const offer of offers) {
    const offerResult = { ean: offer.ean, bol_offer_id: offer.bol_offer_id, account: offer.account_name };

    if (!offer.account_id || !offer.client_id) {
      offerResult.price = offerResult.stock = offerResult.sku = 'فشل ❌: الـ EAN ده مش مربوط بأي حساب bol.com';
      results.push(offerResult);
      continue;
    }

    const account = { id: offer.account_id, client_id: offer.client_id, client_secret: offer.client_secret };

    try {
      await bol.updateOfferPrice(account, offer.bol_offer_id, offer.sell_price);
      offerResult.price = 'تم ✅';
    } catch (e) {
      offerResult.price = 'فشل ❌: ' + (e.response?.data?.detail || e.message);
    }

    try {
      await bol.updateOfferStock(account, offer.bol_offer_id, product.stock_qty);
      offerResult.stock = 'تم ✅';
    } catch (e) {
      offerResult.stock = 'فشل ❌: ' + (e.response?.data?.detail || e.message);
    }

    if (offer.reference) {
      try {
        await bol.updateOfferReference(account, offer.bol_offer_id, offer.reference);
        offerResult.sku = 'تم ✅';
      } catch (e) {
        offerResult.sku = 'فشل ❌: ' + (e.response?.data?.detail || e.message);
      }
    }

    results.push(offerResult);
  }

  return results;
}

// ---------- المزامنة الجماعية (كل المنتجات المربوطة بـ bol.com) ----------
let currentPushJob = { status: 'idle' };

function getPushJobStatus() {
  return currentPushJob;
}

function startPushAllJob() {
  if (currentPushJob.status === 'running') {
    return currentPushJob;
  }
  currentPushJob = { status: 'running', processed: 0, total: 0, startedAt: new Date().toISOString() };

  (async () => {
    try {
      const products = db
        .prepare(
          `SELECT DISTINCT p.* FROM products p
           JOIN product_offers o ON o.product_id = p.id
           WHERE o.bol_offer_id IS NOT NULL AND o.bol_offer_id != '' AND o.active = 1 AND p.active = 1`
        )
        .all();
      currentPushJob.total = products.length;

      const errors = [];
      for (const product of products) {
        try {
          const results = await pushProductToBol(product);
          for (const r of results) {
            const failed = Object.entries(r).filter(([k, v]) => typeof v === 'string' && v.startsWith('فشل'));
            if (failed.length) {
              errors.push(`${product.sku} (${r.ean}): ${failed.map(([k, v]) => `${k} - ${v}`).join(' | ')}`);
            }
          }
        } catch (e) {
          errors.push(`${product.sku}: ${e.message}`);
        }
        currentPushJob.processed++;
      }

      currentPushJob = {
        status: 'success',
        finishedAt: new Date().toISOString(),
        total: products.length,
        processed: products.length,
        errors
      };
    } catch (e) {
      currentPushJob = { status: 'error', finishedAt: new Date().toISOString(), error: e.message };
    }
  })();

  return currentPushJob;
}

module.exports = { pushProductToBol, startPushAllJob, getPushJobStatus };
