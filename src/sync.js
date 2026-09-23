const db = require('./db');
const bol = require('./bolClient');

let isSyncing = false;

/**
 * بتلف على كل حسابات bol.com النشطة، ولكل حساب:
 * 1. تجيب الطلبات المفتوحة
 * 2. أي عنصر أوردر جديد -> تلاقي الـ EAN في جدول العروض (لنفس الحساب ده)، تعرف المنتج الأساسي،
 *    وتنزّل من المخزون المشترك بتاعه
 * 3. تبعت المخزون المحدّث لكل الـ EANs بتاعة كل الحسابات المرتبطة بنفس المنتج
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
    const accounts = db.prepare('SELECT * FROM bol_accounts WHERE active = 1').all();

    if (!accounts.length) {
      errors.push('مفيش أي حساب bol.com مضاف لسه - روح تاب "حسابات bol.com" وضيف واحد');
    }

    for (const account of accounts) {
      let ordersData;
      try {
        ordersData = await bol.getOpenOrders(account);
      } catch (e) {
        errors.push(`فشل جلب الطلبات لحساب "${account.name}": ` + (e.response?.data?.detail || e.message));
        continue;
      }

      const orders = ordersData?.orders || [];

      for (const orderSummary of orders) {
        try {
          const order = await bol.getOrderDetails(account, orderSummary.orderId);
          const items = order.orderItems || [];

          for (const item of items) {
            const orderItemId = item.orderItemId;
            const ean = item.product?.ean;
            const quantity = item.quantity || 1;
            const unitPrice = item.unitPrice || 0;

            const alreadyRecorded = db.prepare('SELECT id FROM sales WHERE bol_order_item_id = ?').get(orderItemId);
            if (alreadyRecorded) continue;

            const offer = db.prepare('SELECT * FROM product_offers WHERE ean = ? AND account_id = ?').get(ean, account.id);
            if (!offer) {
              errors.push(`EAN ${ean} من طلب حساب "${account.name}" مش مربوط بأي منتج عندك - اتجاهل`);
              continue;
            }

            const product = db.prepare('SELECT * FROM products WHERE id = ?').get(offer.product_id);
            if (!product) continue;

            // كل عملية بيع من العرض ده بتاخد units_per_sale قطعة من المخزون الأساسي المشترك
            // + أي مكونات إضافية من منتجات تانية (لعروض الكومبو زي "طباخ + 4 قناني غاز")
            const unitsPerSale = offer.units_per_sale || 1;
            const totalUnitsDeducted = quantity * unitsPerSale;
            let trueCostPrice = product.cost_price * unitsPerSale;

            const newStock = Math.max(0, product.stock_qty - totalUnitsDeducted);
            db.prepare('UPDATE products SET stock_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
              newStock,
              product.id
            );

            const components = db.prepare('SELECT * FROM offer_components WHERE offer_id = ?').all(offer.id);
            for (const comp of components) {
              const compProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(comp.product_id);
              if (!compProduct) continue;

              const compDeducted = quantity * comp.quantity;
              trueCostPrice += compProduct.cost_price * comp.quantity;

              const compNewStock = Math.max(0, compProduct.stock_qty - compDeducted);
              db.prepare('UPDATE products SET stock_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
                compNewStock,
                compProduct.id
              );
            }

            db.prepare(
              `INSERT INTO sales (product_id, offer_id, bol_order_id, bol_order_item_id, quantity, sale_price, cost_price, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'bol')`
            ).run(product.id, offer.id, orderSummary.orderId, orderItemId, quantity, unitPrice, trueCostPrice);

            ordersProcessed++;
          }
        } catch (e) {
          errors.push(`خطأ في معالجة أوردر ${orderSummary.orderId} (حساب "${account.name}"): ${e.message}`);
        }
      }
    }

    // دفع المخزون المحدّث لكل الـ EANs المرتبطة بأي منتج نشط، على أي حساب كانوا
    const productsToPush = db
      .prepare(
        `SELECT DISTINCT p.* FROM products p
         JOIN product_offers o ON o.product_id = p.id
         WHERE o.bol_offer_id IS NOT NULL AND o.bol_offer_id != '' AND o.active = 1 AND p.active = 1`
      )
      .all();

    const accountsById = new Map(accounts.map((a) => [a.id, a]));

    for (const product of productsToPush) {
      const offers = db
        .prepare(
          `SELECT * FROM product_offers WHERE product_id = ? AND bol_offer_id IS NOT NULL AND bol_offer_id != '' AND active = 1`
        )
        .all(product.id);

      for (const offer of offers) {
        const account = accountsById.get(offer.account_id);
        if (!account) {
          errors.push(`EAN ${offer.ean} مش مربوط بحساب bol.com نشط - اتجاهل من المزامنة`);
          continue;
        }
        try {
          const unitsPerSale = offer.units_per_sale || 1;
          let availableForThisOffer = Math.floor(product.stock_qty / unitsPerSale);

          // لو العرض ده كومبو (زي "طباخ + 4 قناني غاز")، الكمية المتاحة الحقيقية
          // هي أقل رقم بين المنتج الأساسي وكل المكونات الإضافية
          const components = db.prepare('SELECT * FROM offer_components WHERE offer_id = ?').all(offer.id);
          for (const comp of components) {
            const compProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(comp.product_id);
            if (!compProduct) continue;
            const compAvailable = Math.floor(compProduct.stock_qty / comp.quantity);
            availableForThisOffer = Math.min(availableForThisOffer, compAvailable);
          }

          await bol.updateOfferStock(account, offer.bol_offer_id, availableForThisOffer);
          stockPushed++;
        } catch (e) {
          errors.push(
            `فشل تحديث مخزون ${product.sku} (EAN: ${offer.ean}, حساب: ${account.name}): ${e.response?.data?.detail || e.message}`
          );
        }
        // تأخير بسيط بين كل تحديث والتاني عشان منضغطش على bol.com ونتفادى خطأ 429
        await new Promise((r) => setTimeout(r, 200));
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
