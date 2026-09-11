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

// جلب كل العروض (Offers) بتاعة الحساب - مفيد للمزامنة الأولى
async function getOffers(page = 1) {
  return bolRequest('get', '/offers', { params: { page } });
}

module.exports = {
  getAccessToken,
  getOpenOrders,
  getOrderDetails,
  updateOfferStock,
  getOffers
};
