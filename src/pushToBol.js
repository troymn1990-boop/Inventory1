const db = require('./db');
const bol = require('./bolClient');

/**
 * بيبعت آخر بيانات المنتج (السعر + المخزون + الـ SKU) لـ bol.com.
 * المنصة هنا هي "مصدر الحقيقة" - يعني بتاخد من عندنا وتبعت لـ bol، مش العكس.
 */
async function pushProductToBol(product) {
  if (!product.bol_offer_id) {
    throw new Error('المنتج ده لسه مش مربوط بـ Offer ID بتاع bol.com (اكتب الـ Offer ID الأول)');
  }

  const result = {};

  try {
    await bol.updateOfferPrice(product.bol_offer_id, product.sell_price);
    result.price = 'تم ✅';
  } catch (e) {
    result.price = 'فشل ❌: ' + (e.response?.data?.detail || e.message);
  }

  try {
    await bol.updateOfferStock(product.bol_offer_id, product.stock_qty);
    result.stock = 'تم ✅';
  } catch (e) {
    result.stock = 'فشل ❌: ' + (e.response?.data?.detail || e.message);
  }

  try {
    await bol.updateOfferReference(product.bol_offer_id, product.sku);
    result.sku = 'تم ✅';
  } catch (e) {
    result.sku = 'فشل ❌: ' + (e.response?.data?.detail || e.message);
  }

  return result;
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
        .prepare("SELECT * FROM products WHERE bol_offer_id IS NOT NULL AND bol_offer_id != '' AND active = 1")
        .all();
      currentPushJob.total = products.length;

      const errors = [];
      for (const product of products) {
        try {
          const r = await pushProductToBol(product);
          const failed = Object.entries(r).filter(([, v]) => v.startsWith('فشل'));
          if (failed.length) {
            errors.push(`${product.sku}: ${failed.map(([k, v]) => `${k} - ${v}`).join(' | ')}`);
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
