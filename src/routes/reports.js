const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ملخص عام: إجمالي قيمة المخزون، عدد الأصناف، تنبيهات نقص المخزون
router.get('/inventory-summary', (req, res) => {
  const totals = db
    .prepare(
      `SELECT
        COUNT(*) as total_products,
        SUM(stock_qty) as total_units,
        SUM(stock_qty * cost_price) as inventory_cost_value,
        SUM(stock_qty * sell_price) as inventory_retail_value
       FROM products WHERE active = 1`
    )
    .get();

  const lowStock = db
    .prepare('SELECT id, sku, name, stock_qty, low_stock_threshold FROM products WHERE stock_qty <= low_stock_threshold AND active = 1 ORDER BY stock_qty ASC LIMIT 20')
    .all();

  res.json({ totals, lowStock });
});

// تقرير الأرباح خلال فترة زمنية
router.get('/profit', (req, res) => {
  const { from, to } = req.query;
  const start = from || '1970-01-01';
  const end = to || '2100-01-01';

  const summary = db
    .prepare(
      `SELECT
        COUNT(*) as total_sales,
        SUM(quantity) as total_units_sold,
        SUM(quantity * sale_price) as revenue,
        SUM(quantity * cost_price) as cost,
        SUM(quantity * (sale_price - cost_price)) as profit
       FROM sales WHERE sold_at BETWEEN ? AND ?`
    )
    .get(start, end);

  const byProduct = db
    .prepare(
      `SELECT
        p.sku, p.name,
        SUM(s.quantity) as units_sold,
        SUM(s.quantity * s.sale_price) as revenue,
        SUM(s.quantity * (s.sale_price - s.cost_price)) as profit
       FROM sales s
       JOIN products p ON p.id = s.product_id
       WHERE s.sold_at BETWEEN ? AND ?
       GROUP BY p.id
       ORDER BY profit DESC
       LIMIT 50`
    )
    .all(start, end);

  const byDay = db
    .prepare(
      `SELECT
        date(sold_at) as day,
        SUM(quantity * sale_price) as revenue,
        SUM(quantity * (sale_price - cost_price)) as profit
       FROM sales
       WHERE sold_at BETWEEN ? AND ?
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(start, end);

  res.json({ summary, byProduct, byDay });
});

// تسجيل عملية بيع يدوية (مش من bol.com)
router.post('/manual-sale', (req, res) => {
  const { product_id, quantity, sale_price } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(404).json({ error: 'المنتج مش موجود' });
  if (product.stock_qty < quantity) return res.status(400).json({ error: 'الكمية في المخزون مش كفاية' });

  db.prepare(
    `INSERT INTO sales (product_id, quantity, sale_price, cost_price, source) VALUES (?, ?, ?, ?, 'manual')`
  ).run(product_id, quantity, sale_price ?? product.sell_price, product.cost_price);

  db.prepare('UPDATE products SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    quantity,
    product_id
  );

  res.json({ ok: true });
});

module.exports = router;
