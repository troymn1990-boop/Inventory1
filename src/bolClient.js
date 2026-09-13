/**
 * عميل الاتصال بـ bol.com Retailer API
 * التوثيق الرسمي: https://api.bol.com/retailer/public/Retailer-API/
 *
 * كل دالة هنا بتاخد "account" كأول باراميتر - كائن فيه client_id و client_secret
 * (بييجي من جدول bol_accounts) - عشان نقدر نتعامل مع أكتر من حساب bol.com في نفس الوقت.
 *
 * ملحوظة مهمة: bol.com بتحدّث نسخة الـ API بين وقت وتاني (v10, v11...).
 * لو حصل خطأ 406/415 من الـ API، افتح رابط التوثيق فوق وحدّث قيمة API_VERSION تحت.
 */
const axios = require('axios');

const TOKEN_URL = 'https://login.bol.com/token?grant_type=client_credentials';
const BASE_URL = 'https://api.bol.com/retailer';
const SHARED_BASE_URL = 'https://api.bol.com/shared'; // مسار process-status مختلف عن باقي الـ retailer endpoints
const API_VERSION = process.env.BOL_API_VERSION || 'v10';

// كاش توكنات لكل حساب لوحده (مفتاح الماب هو id الحساب)
const tokenCache = new Map(); // accountId -> { token, expiresAt }

async function getAccessToken(account) {
  if (!account?.client_id || !account?.client_secret) {
    throw new Error('بيانات الاتصال بـ bol.com (Client ID/Secret) ناقصة لهذا الحساب');
  }

  const now = Date.now();
  const cached = tokenCache.get(account.id);
  if (cached && now < cached.expiresAt - 15000) {
    return cached.token;
  }

  const basicAuth = Buffer.from(`${account.client_id}:${account.client_secret}`).toString('base64');
  const res = await axios.post(TOKEN_URL, null, {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: 'application/json'
    }
  });

  const token = res.data.access_token;
  const expiresAt = now + (res.data.expires_in || 299) * 1000;
  tokenCache.set(account.id, { token, expiresAt });
  return token;
}

async function bolRequest(account, method, path, { params, data, accept } = {}) {
  const token = await getAccessToken(account);
  const res = await axios({
    method,
    url: `${BASE_URL}${path}`,
    params,
    data,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept || `application/vnd.retailer.${API_VERSION}+json`,
      'Content-Type': data ? `application/vnd.retailer.${API_VERSION}+json` : undefined
    }
  });
  return res.data;
}

// جلب الطلبات المفتوحة (اللي لسه محتاجة شحن) لحساب معين
async function getOpenOrders(account) {
  return bolRequest(account, 'get', '/orders', { params: { status: 'OPEN', page: 1 } });
}

// جلب تفاصيل أوردر معين (بيحتوي على المنتجات والكميات)
async function getOrderDetails(account, orderId) {
  return bolRequest(account, 'get', `/orders/${orderId}`);
}

// تحديث المخزون لعرض (offer) معين على bol.com
async function updateOfferStock(account, offerId, stockQty) {
  return bolRequest(account, 'put', `/offers/${offerId}/stock`, {
    data: {
      amount: stockQty,
      managedByRetailer: true
    }
  });
}

// تحديث السعر لعرض (offer) معين على bol.com
async function updateOfferPrice(account, offerId, price) {
  return bolRequest(account, 'put', `/offers/${offerId}/price`, {
    data: {
      pricing: {
        bundlePrices: [{ quantity: 1, unitPrice: Number(price) }]
      }
    }
  });
}

// جلب تفاصيل عرض معين
async function getOfferById(account, offerId) {
  return bolRequest(account, 'get', `/offers/${offerId}`);
}

// تحديث الـ reference (SKU) لعرض معين
// ملحوظة مهمة: توثيق bol.com الرسمي (ReDoc) بيوضح إن الـ endpoint ده فعليًا بياخد بيانات
// العرض كاملة (مش reference بس)، فبنجيب العرض الحالي ونبعته تاني بالـ reference الجديد بس،
// مع الحفاظ على economicOperatorId لو موجود (لأن حذفه من الطلب بيفك ربطه تلقائيًا)
async function updateOfferReference(account, offerId, reference) {
  const current = await getOfferById(account, offerId);

  const payload = {
    ean: current.ean,
    reference,
    onHoldByRetailer: current.onHoldByRetailer ?? false,
    condition: current.condition,
    pricing: current.pricing,
    stock: {
      amount: current.stock?.amount ?? 0,
      managedByRetailer: current.stock?.managedByRetailer ?? true
    },
    fulfilment: current.fulfilment
  };

  if (current.economicOperatorId) payload.economicOperatorId = current.economicOperatorId;
  if (current.unknownProductTitle) payload.unknownProductTitle = current.unknownProductTitle;

  return bolRequest(account, 'put', `/offers/${offerId}`, { data: payload });
}

// ---------- استيراد كل عروض حساب معين من bol.com (Offer Export) ----------
async function requestOfferExport(account) {
  return bolRequest(account, 'post', '/offers/export', { data: { format: 'CSV' } });
}

async function getProcessStatus(account, processStatusId) {
  // مسار process-status بيعيش تحت /shared مش تحت /retailer (تغيير من bol.com من v7)
  const token = await getAccessToken(account);
  const res = await axios.get(`${SHARED_BASE_URL}/process-status/${processStatusId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: `application/vnd.retailer.${API_VERSION}+json`
    }
  });
  return res.data;
}

// بننتظر لحد ما يخلص التصدير (بيرجع الـ report-id لما يخلص)
async function waitForExportReady(account, processStatusId, { maxAttempts = 30, delayMs = 4000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const status = await getProcessStatus(account, processStatusId);
    if (status.status === 'SUCCESS') {
      return status.entityId; // ده الـ report-id
    }
    if (status.status === 'FAILURE') {
      throw new Error('فشل تجهيز ملف التصدير من bol.com: ' + (status.errorMessage || 'سبب غير معروف'));
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('استغرق تجهيز ملف التصدير وقت طويل جدًا - جرب تاني بعد شوية');
}

async function downloadOfferExportCsv(account, reportId) {
  const token = await getAccessToken(account);
  const res = await axios.get(`${BASE_URL}/offers/export/${reportId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: `application/vnd.retailer.${API_VERSION}+csv`
    },
    responseType: 'text',
    transformResponse: [(data) => data] // نمنع axios يحاول يحوّلها JSON
  });
  return res.data; // نص CSV خام
}

module.exports = {
  getAccessToken,
  getOpenOrders,
  getOrderDetails,
  updateOfferStock,
  updateOfferPrice,
  getOfferById,
  updateOfferReference,
  requestOfferExport,
  getProcessStatus,
  waitForExportReady,
  downloadOfferExportCsv
};
