/**
 * عميل الاتصال بـ bol.com Retailer API
 * التوثيق الرسمي: https://api.bol.com/retailer/public/Retailer-API/
 *
 * ملحوظة مهمة: bol.com بتحدّث نسخة الـ API بين وقت وتاني (v10, v11...).
 * لو حصل خطأ 406/415 من الـ API، افتح رابط التوثيق فوق وحدّث قيمة API_VERSION تحت.
 */
const axios = require('axios');

const TOKEN_URL = 'https://login.bol.com/token?grant_type=client_credentials';
const BASE_URL = 'https://api.bol.com/retailer';
const SHARED_BASE_URL = 'https://api.bol.com/shared'; // مسار process-status مختلف عن باقي الـ retailer endpoints
const API_VERSION = process.env.BOL_API_VERSION || 'v10';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 15000) {
    return cachedToken;
  }

  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('BOL_CLIENT_ID أو BOL_CLIENT_SECRET مش متحددين في متغيرات البيئة');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await axios.post(TOKEN_URL, null, {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: 'application/json'
    }
  });

  cachedToken = res.data.access_token;
  tokenExpiresAt = now + (res.data.expires_in || 299) * 1000;
  return cachedToken;
}

async function bolRequest(method, path, { params, data, accept } = {}) {
  const token = await getAccessToken();
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

// جلب الطلبات المفتوحة (اللي لسه محتاجة شحن) - المصدر الأساسي لتحديث المخزون
async function getOpenOrders() {
  return bolRequest('get', '/orders', { params: { status: 'OPEN', page: 1 } });
}

// جلب تفاصيل أوردر معين (بيحتوي على المنتجات والكميات)
async function getOrderDetails(orderId) {
  return bolRequest('get', `/orders/${orderId}`);
}

// تحديث المخزون لعرض (offer) معين على bol.com
async function updateOfferStock(offerId, stockQty) {
  return bolRequest('put', `/offers/${offerId}/stock`, {
    data: {
      amount: stockQty,
      managedByRetailer: true
    }
  });
}

// تحديث السعر لعرض (offer) معين على bol.com
async function updateOfferPrice(offerId, price) {
  return bolRequest('put', `/offers/${offerId}/price`, {
    data: {
      pricing: {
        bundlePrices: [{ quantity: 1, unitPrice: Number(price) }]
      }
    }
  });
}

// جلب تفاصيل عرض معين - مستخدمة لمعرفة onHoldByRetailer الحالية قبل تحديث الـ reference
async function getOfferById(offerId) {
  return bolRequest('get', `/offers/${offerId}`);
}

// تحديث الـ reference (اللي بنستخدمه كـ SKU/EAN reference) لعرض معين
// endpoint "Update an offer" بيحدّث reference و onHoldByRetailer بس (مش كل بيانات العرض)
// فمحتاجينش نجيب العرض كامل أو نخاف نمسح economicOperatorId أو أي حاجة تانية
async function updateOfferReference(offerId, reference, onHoldByRetailer) {
  let holdValue = onHoldByRetailer;
  if (holdValue === undefined) {
    const current = await getOfferById(offerId);
    holdValue = current.onHoldByRetailer ?? false;
  }
  return bolRequest('put', `/offers/${offerId}`, {
    data: { reference, onHoldByRetailer: holdValue }
  });
}

// جلب كل العروض (Offers) بتاعة الحساب - مفيد للمزامنة الأولى
async function getOffers(page = 1) {
  return bolRequest('get', '/offers', { params: { page } });
}

// ---------- استيراد كل عروضي من bol.com (Offer Export) ----------
// الخطوات: 1) نطلب تصدير  2) نستنى لحد ما يخلص (process-status)  3) ننزّل ملف الـ CSV
async function requestOfferExport() {
  const token = await getAccessToken();
  const res = await axios.post(
    `${BASE_URL}/offers/export`,
    { format: 'CSV' },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: `application/vnd.retailer.${API_VERSION}+json`,
        'Content-Type': `application/vnd.retailer.${API_VERSION}+json`
      }
    }
  );
  return res.data; // فيها processStatusId
}

async function getProcessStatus(processStatusId) {
  // مسار process-status بيعيش تحت /shared مش تحت /retailer (تغيير من bol.com من v7)
  const token = await getAccessToken();
  const res = await axios.get(`${SHARED_BASE_URL}/process-status/${processStatusId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: `application/vnd.retailer.${API_VERSION}+json`
    }
  });
  return res.data;
}

// بننتظر لحد ما يخلص التصدير (بيرجع الـ report-id لما يخلص)
async function waitForExportReady(processStatusId, { maxAttempts = 30, delayMs = 4000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const status = await getProcessStatus(processStatusId);
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

async function downloadOfferExportCsv(reportId) {
  const token = await getAccessToken();
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
  getOffers,
  requestOfferExport,
  getProcessStatus,
  waitForExportReady,
  downloadOfferExportCsv
};
