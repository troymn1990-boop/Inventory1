const db = require('./db');
const bol = require('./bolClient');

let isSyncing = false;

/**
 * خطوات المزامنة:
 * 1. نجيب الطلبات المفتوحة من bol.com
 * 2. أي عنصر أوردر لسه ما تسجلش عندنا -> نلاقي الـ EAN في جدول العروض، نعرف المنتج الأساسي بتاعه،
 *    وننزّل من المخزون المشترك للمنتج ده (مش من العرض نفسه)
 * 3. أي منتج اتغيّر مخزونه -> نبعت المخزون الجديد لكل الـ EANs المرتبطة بيه على bol.com
 */
async function runSync() {
  if (isSyncing) {
    return { status: 'skipped', message: 'في مزامنة شغالة بالفعل' };
  }
  isSyncing = true;

  let ordersProcessed = 0;
  let stockPushed = 0;
  const errors = [];

  try {
    let ordersData;
    try {
      ordersData = await bol.getOpenOrders();
    } catch (e) {
      errors.push('فشل جلب الطلبات من bol.com: ' + (e.response?.data?.detail || e.message));
      ordersData = null;
    }

    const orders = ordersData?.orders || [];

    for (const orderSummary of orders) {
      try {
        const order = await bol.getOrderDetails(orderSummary.orderId);
        const items = order.orderItems || [];

        for (const item of items) {
          const orderItemId = item.orderItemId;
          const ean = item.product?.ean;
          const quantity = item.quantity || 1;
          const unitPrice = item.unitPrice || 0;

          const alreadyRecorded = db
            .prepare('SELECT id FROM sales WHERE bol_order_item_id = ?')
            .get(orderItemId);
          if (alreadyRecorded) continue;

          const offer = db.prepare('SELECT * FROM product_offers WHERE ean = ?').get(ean);
          if (!offer) {
            errors.push(`EAN ${ean} من أوردر bol.com مش مربوط بأي منتج عندك - اتجاهل`);
            continue;
          }

          const product = db.prepare('SELECT * FROM products WHERE id = ?').get(offer.product_id);
          if (!product) {
            errors.push(`المنتج الأساسي بتاع EAN ${ean} مش موجود - اتجاهل`);
            continue;
          }

          db.prepare(
            `INSERT INTO sales (product_id, offer_id, bol_order_id, bol_order_item_id, quantity, sale_price, cost_price, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'bol')`
          ).run(product.id, offer.id, orderSummary.orderId, orderItemId, quantity, unitPrice, product.cost_price);

          const newStock = Math.max(0, product.stock_qty - quantity);
          db.prepare('UPDATE products SET stock_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
            newStock,
            product.id
          );

          ordersProcessed++;
        }
      } catch (e) {
        errors.push(`خطأ في معالجة أوردر ${orderSummary.orderId}: ${e.message}`);
      }
    }

    // دفع المخزون المحدّث لكل الـ EANs المرتبطة بأي منتج نشط
    const productsToPush = db
      .prepare(
        `SELECT DISTINCT p.* FROM products p
         JOIN product_offers o ON o.product_id = p.id
         WHERE o.bol_offer_id IS NOT NULL AND o.bol_offer_id != '' AND o.active = 1 AND p.active = 1`
      )
      .all();

    for (const product of productsToPush) {
      const offers = db
        .prepare(
          `SELECT * FROM product_offers WHERE product_id = ? AND bol_offer_id IS NOT NULL AND bol_offer_id != '' AND active = 1`
        )
        .all(product.id);

      for (const offer of offers) {
        try {
          await bol.updateOfferStock(offer.bol_offer_id, product.stock_qty);
          stockPushed++;
        } catch (e) {
          errors.push(`فشل تحديث مخزون ${product.sku} (EAN: ${offer.ean}) على bol.com: ${e.response?.data?.detail || e.message}`);
        }
      }
    }

    const status = errors.length ? 'partial' : 'success';
    db.prepare(
      `INSERT INTO sync_log (status, orders_processed, stock_pushed, message) VALUES (?, ?, ?, ?)`
    ).run(status, ordersProcessed, stockPushed, errors.join(' | ') || null);

    return { status, ordersProcessed, stockPushed, errors };
  } catch (e) {
    db.prepare(`INSERT INTO sync_log (status, message) VALUES ('error', ?)`).run(e.message);
    return { status: 'error', message: e.message };
  } finally {
    isSyncing = false;
  }
}

module.exports = { runSync };
