const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'store.db');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- الجداول ----------
// products = "الشجرة الرئيسية" - المنتج الأساسي بمخزون واحد مشترك
// product_offers = كل الـ EANs/العروض المرتبطة بالشجرة، كل واحد بسعره الخاص على bol.com
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,             -- SKU الداخلي للمنتج الأساسي (الشجرة)
  name TEXT NOT NULL,
  cost_price REAL NOT NULL DEFAULT 0,
  stock_qty INTEGER NOT NULL DEFAULT 0, -- المخزون المشترك بين كل الـ EANs المرتبطة
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  category TEXT,
  image_url TEXT,                       -- رابط صورة المنتج (مرفوعة عندنا أو رابط خارجي)
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bol_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  account_id INTEGER,                   -- أي حساب bol.com العرض ده تابع له
  ean TEXT,
  bol_offer_id TEXT,
  units_per_sale INTEGER NOT NULL DEFAULT 1, -- كام قطعة بتتاخد من المخزون المشترك مع كل عملية بيع (مثلاً: طقم 10 = 10)
  reference TEXT,                       -- الـ SKU/reference الظاهر على bol.com للعرض ده تحديدًا
  sell_price REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES bol_accounts(id)
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  offer_id INTEGER,                     -- أي EAN بالظبط اتباع (ممكن يبقى فاضي في البيع اليدوي)
  bol_order_id TEXT,
  bol_order_item_id TEXT UNIQUE,
  quantity INTEGER NOT NULL,
  sale_price REAL NOT NULL,
  cost_price REAL NOT NULL,
  source TEXT DEFAULT 'bol',
  sold_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (offer_id) REFERENCES product_offers(id)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT,
  orders_processed INTEGER DEFAULT 0,
  stock_pushed INTEGER DEFAULT 0,
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_offers_ean ON product_offers(ean);
CREATE INDEX IF NOT EXISTS idx_offers_product ON product_offers(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);
`);

// ---------- ترحيل تلقائي من التصميم القديم (لو موجود) ----------
// النسخة القديمة كانت فيها ean/bol_offer_id/sell_price جوه جدول products نفسه.
// لو لقينا الأعمدة دي لسه موجودة، بننقل بياناتها لجدول product_offers الجديد مرة واحدة بس.
function migrateLegacyOffersIfNeeded() {
  const columns = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
  const hasLegacyColumns = columns.includes('ean') || columns.includes('bol_offer_id');
  if (!hasLegacyColumns) return;

  const alreadyMigrated = db.prepare('SELECT COUNT(*) as c FROM product_offers').get().c > 0;
  if (alreadyMigrated) return;

  const legacyProducts = db
    .prepare('SELECT * FROM products WHERE ean IS NOT NULL OR bol_offer_id IS NOT NULL')
    .all();

  if (!legacyProducts.length) return;

  const insert = db.prepare(
    `INSERT INTO product_offers (product_id, ean, bol_offer_id, reference, sell_price) VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      insert.run(p.id, p.ean || null, p.bol_offer_id || null, p.sku, p.sell_price || 0);
    }
  });
  tx(legacyProducts);
  console.log(`[ترحيل] تم نقل ${legacyProducts.length} عرض من التصميم القديم لجدول product_offers`);
}
migrateLegacyOffersIfNeeded();

// ---------- ترحيل: إضافة عمود account_id لو كان الجدول موجود من قبل بدونه ----------
function migrateAccountIdColumnIfNeeded() {
  const columns = db.prepare("PRAGMA table_info(product_offers)").all().map((c) => c.name);
  if (!columns.includes('account_id')) {
    db.exec('ALTER TABLE product_offers ADD COLUMN account_id INTEGER REFERENCES bol_accounts(id)');
    console.log('[ترحيل] تم إضافة عمود account_id لجدول product_offers');
  }
}
migrateAccountIdColumnIfNeeded();

// ---------- ترحيل: إضافة عمود image_url لو الجدول كان موجود من قبل بدونه ----------
function migrateImageUrlColumnIfNeeded() {
  const columns = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
  if (!columns.includes('image_url')) {
    db.exec('ALTER TABLE products ADD COLUMN image_url TEXT');
    console.log('[ترحيل] تم إضافة عمود image_url لجدول products');
  }
}
migrateImageUrlColumnIfNeeded();

// ---------- ترحيل: إضافة عمود units_per_sale لو الجدول كان موجود من قبل بدونه ----------
function migrateUnitsPerSaleColumnIfNeeded() {
  const columns = db.prepare("PRAGMA table_info(product_offers)").all().map((c) => c.name);
  if (!columns.includes('units_per_sale')) {
    db.exec("ALTER TABLE product_offers ADD COLUMN units_per_sale INTEGER NOT NULL DEFAULT 1");
    console.log('[ترحيل] تم إضافة عمود units_per_sale لجدول product_offers');
  }
}
migrateUnitsPerSaleColumnIfNeeded();

// ---------- ترحيل: لو فيه حساب bol.com قديم متسجل في متغيرات البيئة، نحوّله لحساب في الجدول ----------
function ensureDefaultAccountFromEnv() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return;

  const existingCount = db.prepare('SELECT COUNT(*) as c FROM bol_accounts').get().c;
  if (existingCount > 0) return; // فيه حسابات متسجلة بالفعل، متعملش حاجة

  const info = db
    .prepare('INSERT INTO bol_accounts (name, client_id, client_secret) VALUES (?, ?, ?)')
    .run('الحساب الرئيسي', clientId, clientSecret);

  // أي عرض قديم من غير حساب محدد، بنربطه بالحساب الافتراضي ده
  db.prepare('UPDATE product_offers SET account_id = ? WHERE account_id IS NULL').run(info.lastInsertRowid);
  console.log('[ترحيل] تم إنشاء حساب bol.com افتراضي من متغيرات البيئة وربط العروض القديمة بيه');
}
ensureDefaultAccountFromEnv();

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
