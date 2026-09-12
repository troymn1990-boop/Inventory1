const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'store.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// ---------- الجداول ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  ean TEXT,                     -- الباركود المستخدم على bol.com
  bol_offer_id TEXT,            -- Offer ID بتاع bol.com
  name TEXT NOT NULL,
  cost_price REAL NOT NULL DEFAULT 0,   -- سعر الشراء/التكلفة
  sell_price REAL NOT NULL DEFAULT 0,   -- سعر البيع
  stock_qty INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  category TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  bol_order_id TEXT,            -- لمنع تسجيل نفس الأوردر مرتين
  bol_order_item_id TEXT UNIQUE,
  quantity INTEGER NOT NULL,
  sale_price REAL NOT NULL,     -- سعر البيع وقت الأوردر
  cost_price REAL NOT NULL,     -- تكلفة المنتج وقت الأوردر (لحساب الربح بدقة)
  source TEXT DEFAULT 'bol',    -- bol / manual
  sold_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT,                  -- success / error
  orders_processed INTEGER DEFAULT 0,
  stock_pushed INTEGER DEFAULT 0,
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_ean ON products(ean);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);
`);

// إنشاء يوزر أدمن افتراضي أول مرة بس (من ENV)
function ensureAdminUser() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.warn('[تحذير] ADMIN_PASSWORD مش متحدد في متغيرات البيئة - مش هينشأ حساب أدمن تلقائي.');
    return;
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!existing) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    console.log(`[إعداد] تم إنشاء حساب الأدمن: ${username}`);
  }
}
ensureAdminUser();

module.exports = db;
