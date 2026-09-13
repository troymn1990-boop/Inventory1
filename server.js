require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./src/routes/auth');
const productsRoutes = require('./src/routes/products');
const reportsRoutes = require('./src/routes/reports');
const syncRoutes = require('./src/routes/sync');
const accountsRoutes = require('./src/routes/accounts');
const { runSync } = require('./src/sync');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// صور المنتجات المرفوعة بنعرضها من مجلد data (على الـ Persistent Disk، مش بيتمسح مع النشر الجديد)
const uploadsDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

app.use('/api/auth', authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/accounts', accountsRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- المزامنة الدورية مع bol.com ----------
// كل 5 دقايق (تقدر تغيّر الفترة من متغير البيئة SYNC_CRON)
// بتشتغل تلقائيًا على كل الحسابات المسجلة في تاب "حسابات bol.com" - مفيش داعي لمتغيرات بيئة تانية
const syncSchedule = process.env.SYNC_CRON || '*/5 * * * *';
cron.schedule(syncSchedule, async () => {
  console.log('[مزامنة تلقائية] بدأت...');
  const result = await runSync();
  console.log('[مزامنة تلقائية] النتيجة:', result.status);
});
console.log(`[إعداد] المزامنة التلقائية مفعّلة كل جدول: ${syncSchedule}`);

app.listen(PORT, () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
