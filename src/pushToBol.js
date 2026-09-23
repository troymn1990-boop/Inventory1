const db = require('./db');
const bol = require('./bolClient');

// بنجيب أدق تفاصيل ممكنة من رد bol.com بالغلط، عشان منتوهش وراء رسالة عامة زي "Bad request"
function extractBolError(e) {
  const data = e.response?.data;
  if (!data) return e.message;
  const parts = [];
  if (data.detail) parts.push(data.detail);
  if (data.title && data.title !== data.detail) parts.push(data.title);
  if (Array.isArray(data.violations) && data.violations.length) {
    parts.push(data.violations.map((v) => v.message || v.rule || JSON.stringify(v)).join('; '));
  }
  return parts.length ? parts.join(' - ') : JSON.stringify(data);
}

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
      offerResult.price = 'فشل ❌: ' + extractBolError(e);
    }

    try {
      const unitsPerSale = offer.units_per_sale || 1;
      let availableForThisOffer = Math.floor(product.stock_qty / unitsPerSale);

      const components = db.prepare('SELECT * FROM offer_components WHERE offer_id = ?').all(offer.id);
      for (const comp of components) {
        const compProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(comp.product_id);
        if (!compProduct) continue;
        availableForThisOffer = Math.min(availableForThisOffer, Math.floor(compProduct.stock_qty / comp.quantity));
      }

      await bol.updateOfferStock(account, offer.bol_offer_id, availableForThisOffer);
      offerResult.stock = 'تم ✅';
    } catch (e) {
      offerResult.stock = 'فشل ❌: ' + extractBolError(e);
    }

    if (offer.reference) {
      try {
        await bol.updateOfferReference(account, offer.bol_offer_id, offer.reference);
        offerResult.sku = 'تم ✅';
      } catch (e) {
        offerResult.sku = 'فشل ❌: ' + extractBolError(e);
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
        // تأخير بسيط بين كل منتج والتاني عشان منضغطش على bol.com ونتفادى خطأ 429
        await new Promise((r) => setTimeout(r, 200));
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
