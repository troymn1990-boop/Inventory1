require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const path = require('path');

const authRoutes = require('./src/routes/auth');
const productsRoutes = require('./src/routes/products');
const reportsRoutes = require('./src/routes/reports');
const syncRoutes = require('./src/routes/sync');
const { runSync } = require('./src/sync');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/sync', syncRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- المزامنة الدورية مع bol.com ----------
// كل 5 دقايق (تقدر تغيّر الفترة من متغير البيئة SYNC_CRON)
const syncSchedule = process.env.SYNC_CRON || '*/5 * * * *';
if (process.env.BOL_CLIENT_ID && process.env.BOL_CLIENT_SECRET) {
  cron.schedule(syncSchedule, async () => {
    console.log('[مزامنة تلقائية] بدأت...');
    const result = await runSync();
    console.log('[مزامنة تلقائية] النتيجة:', result.status);
  });
  console.log(`[إعداد] المزامنة التلقائية مفعّلة كل جدول: ${syncSchedule}`);
} else {
  console.warn('[تحذير] BOL_CLIENT_ID/BOL_CLIENT_SECRET مش متحددين - المزامنة التلقائية متوقفة.');
}

app.listen(PORT, () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
