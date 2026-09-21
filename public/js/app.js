// ---------- التحقق من تسجيل الدخول ----------
(async function checkAuth() {
  const res = await fetch('/api/auth/me');
  const data = await res.json();
  if (!data.loggedIn) {
    window.location.href = '/index.html';
  } else {
    document.getElementById('username-display').textContent = '👤 ' + data.username;
  }
})();

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/index.html';
});

// ---------- التنقل بين التابات ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'overview') loadOverview();
    if (btn.dataset.tab === 'products') loadProducts();
    if (btn.dataset.tab === 'sync') { loadSyncLog(); loadAccountsForImportSelect(); }
    if (btn.dataset.tab === 'accounts') loadAccounts();
  });
});

const money = (n) => (Number(n) || 0).toLocaleString('ar-EG', { style: 'currency', currency: 'EUR' });

// ================= نظرة عامة =================
async function loadOverview() {
  const res = await fetch('/api/reports/inventory-summary');
  const { totals, lowStock } = await res.json();

  document.getElementById('summaryCards').innerHTML = `
    <div class="stat-card"><div class="label">عدد المنتجات الأساسية</div><div class="value">${totals.total_products || 0}</div></div>
    <div class="stat-card"><div class="label">عدد EANs المرتبطة</div><div class="value">${totals.total_offers || 0}</div></div>
    <div class="stat-card"><div class="label">إجمالي الوحدات بالمخزون</div><div class="value">${totals.total_units || 0}</div></div>
    <div class="stat-card accent"><div class="label">قيمة المخزون (تكلفة)</div><div class="value">${money(totals.inventory_cost_value)}</div></div>
  `;

  const tbody = document.querySelector('#lowStockTable tbody');
  tbody.innerHTML = lowStock.length
    ? lowStock.map(p => `<tr><td>${p.sku}</td><td>${p.name}</td><td>${p.stock_qty}</td><td>${p.low_stock_threshold}</td></tr>`).join('')
    : '<tr><td colspan="4">مفيش منتجات ناقصة دلوقتي 🎉</td></tr>';
}

// ================= المنتجات (الشجرة) =================
let productsState = { page: 1, pageSize: 50, search: '', lowStockOnly: false };

async function loadProducts() {
  const params = new URLSearchParams({
    search: productsState.search,
    page: productsState.page,
    pageSize: productsState.pageSize,
    lowStockOnly: productsState.lowStockOnly
  });
  const res = await fetch('/api/products?' + params.toString());
  const data = await res.json();

  const tbody = document.querySelector('#productsTable tbody');
  tbody.innerHTML = data.products.map(p => `
    <tr class="${p.stock_qty <= p.low_stock_threshold ? 'low-stock-row' : ''}">
      <td>${p.image_url ? `<img src="${p.image_url}" class="product-thumb">` : `<div class="product-thumb-placeholder">📦</div>`}</td>
      <td>${p.sku}</td>
      <td>${p.name}</td>
      <td>${money(p.cost_price)}</td>
      <td>${p.stock_qty}</td>
      <td><span class="badge">${p.offers_count} EAN</span></td>
      <td>
        <button class="icon-btn" onclick="openOffersModal(${p.id}, '${p.sku.replace(/'/g, "\\'")}')" title="إدارة الـ EANs المرتبطة">🔗</button>
        <button class="icon-btn" onclick="mergeProductInto(${p.id}, '${p.sku.replace(/'/g, "\\'")}')" title="دمج الشجرة دي كاملة في منتج تاني">🔀</button>
        <button class="icon-btn" onclick="syncProductToBol(${p.id})" title="مزامنة مع bol.com">🔄</button>
        <button class="icon-btn" onclick="editProduct(${p.id})">✏️</button>
        <button class="icon-btn" onclick="deleteProduct(${p.id})">🗑️</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7">مفيش نتائج</td></tr>';

  const totalPages = Math.max(1, Math.ceil(data.total / productsState.pageSize));
  const pag = document.getElementById('pagination');
  let html = '';
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - productsState.page) <= 2) {
      html += `<button class="${i === productsState.page ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
    } else if (html.slice(-3) !== '...') {
      html += '...';
    }
  }
  pag.innerHTML = html;
}
window.goToPage = (p) => { productsState.page = p; loadProducts(); };

let searchTimeout;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    productsState.search = e.target.value;
    productsState.page = 1;
    loadProducts();
  }, 300);
});
document.getElementById('lowStockFilter').addEventListener('change', (e) => {
  productsState.lowStockOnly = e.target.checked;
  productsState.page = 1;
  loadProducts();
});

// ---- Modal إضافة/تعديل منتج أساسي ----
const modal = document.getElementById('productModal');
document.getElementById('addProductBtn').addEventListener('click', () => openModal());
document.getElementById('cancelModalBtn').addEventListener('click', () => modal.classList.add('hidden'));

let currentEditingProductId = null;

function openModal(product = null) {
  document.getElementById('modalTitle').textContent = product ? 'تعديل المنتج الأساسي' : 'إضافة منتج أساسي جديد';
  document.getElementById('productId').value = product?.id || '';
  document.getElementById('f_sku').value = product?.sku || '';
  document.getElementById('f_sku').disabled = !!product;
  document.getElementById('f_name').value = product?.name || '';
  document.getElementById('f_cost').value = product?.cost_price ?? '';
  document.getElementById('f_stock').value = product?.stock_qty ?? '';
  document.getElementById('f_threshold').value = product?.low_stock_threshold ?? 5;

  currentEditingProductId = product?.id || null;
  const imageSection = document.getElementById('imageSection');
  const preview = document.getElementById('productImagePreview');
  document.getElementById('f_image_file').value = '';
  document.getElementById('f_image_url').value = '';
  document.getElementById('imageUploadStatus').textContent = '';

  if (product) {
    imageSection.style.display = 'block';
    if (product.image_url) {
      preview.src = product.image_url;
      preview.style.display = 'block';
    } else {
      preview.style.display = 'none';
    }
  } else {
    // المنتج لسه مش متحفظ - لازم نحفظه الأول قبل ما نقدر نرفعله صورة
    imageSection.style.display = 'none';
  }

  modal.classList.remove('hidden');
}

document.getElementById('uploadImageBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('f_image_file');
  const statusEl = document.getElementById('imageUploadStatus');
  statusEl.style.color = 'var(--muted)';
  if (!fileInput.files[0]) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = '⚠️ اختار ملف صورة الأول'; return; }
  if (!currentEditingProductId) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = '⚠️ احفظ المنتج الأول قبل ما ترفع صورة'; return; }

  const formData = new FormData();
  formData.append('image', fileInput.files[0]);
  statusEl.textContent = '⏳ جاري الرفع...';

  try {
    const res = await fetch(`/api/products/${currentEditingProductId}/image`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = '❌ ' + (data.error || 'فشل الرفع (كود ' + res.status + ')'); return; }
    document.getElementById('productImagePreview').src = data.image_url + '?t=' + Date.now();
    document.getElementById('productImagePreview').style.display = 'block';
    statusEl.style.color = 'var(--primary)';
    statusEl.textContent = '✅ تم رفع الصورة بنجاح';
    loadProducts();
  } catch (e) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = '❌ مشكلة في الاتصال بالسيرفر: ' + e.message;
  }
});

document.getElementById('saveImageUrlBtn').addEventListener('click', async () => {
  const urlInput = document.getElementById('f_image_url');
  const statusEl = document.getElementById('imageUploadStatus');
  if (!urlInput.value.trim()) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = '⚠️ الصق رابط صورة الأول'; return; }
  if (!currentEditingProductId) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = '⚠️ احفظ المنتج الأول قبل ما تضيف صورة'; return; }

  try {
    const res = await fetch(`/api/products/${currentEditingProductId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: urlInput.value.trim() })
    });
    const data = await res.json();
    if (!res.ok) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = '❌ ' + (data.error || 'فشل الحفظ'); return; }
    document.getElementById('productImagePreview').src = urlInput.value.trim();
    document.getElementById('productImagePreview').style.display = 'block';
    statusEl.style.color = 'var(--primary)';
    statusEl.textContent = '✅ تم حفظ الرابط';
    loadProducts();
  } catch (e) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = '❌ مشكلة في الاتصال بالسيرفر: ' + e.message;
  }
});

let allProductsCache = [];
window.mergeProductInto = async (productId, sku) => {
  const targetSku = prompt(`دمج "${sku}" داخل منتج تاني - اكتب SKU المنتج الهدف:`);
  if (!targetSku) return;

  const unitsPerSaleInput = prompt(
    'كام قطعة من المخزون بتتاخد مع كل عملية بيع من EANs المنتج ده؟\n(مثلاً: لو ده عرض "طقم 10" اكتب 10 - أو سيبه فاضي لو عايز تحافظ على القيم الحالية لكل EAN)'
  );
  const unitsPerSale = unitsPerSaleInput && unitsPerSaleInput.trim() ? Number(unitsPerSaleInput.trim()) : null;

  try {
    const res = await fetch(`/api/products/${productId}/merge-into`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSku, unitsPerSale })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'فشل الدمج'); return; }
    alert(`تم! ${data.movedOffers} EAN اتنقلوا لـ "${data.targetProduct.name}" (${data.targetProduct.sku}) ✅\nالمنتج "${sku}" بقى فاضي، تقدر تمسحه دلوقتي لو حبيت.`);
    loadProducts();
  } catch (e) {
    alert('مشكلة في الاتصال بالسيرفر');
  }
};

window.editProduct = async (id) => {
  const res = await fetch('/api/products?search=&page=1&pageSize=1000');
  const data = await res.json();
  allProductsCache = data.products;
  const product = data.products.find(p => p.id === id);
  if (product) openModal(product);
};

window.deleteProduct = async (id) => {
  if (!confirm('متأكد إنك عايز تمسح المنتج الأساسي ده؟ هيتمسح معاه كل الـ EANs المرتبطة بيه.')) return;
  await fetch('/api/products/' + id, { method: 'DELETE' });
  loadProducts();
};

document.getElementById('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('productId').value;
  const body = {
    sku: document.getElementById('f_sku').value,
    name: document.getElementById('f_name').value,
    cost_price: document.getElementById('f_cost').value,
    stock_qty: document.getElementById('f_stock').value,
    low_stock_threshold: document.getElementById('f_threshold').value
  };

  const url = id ? '/api/products/' + id : '/api/products';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'حصل خطأ'); return; }

  if (!id) {
    // منتج جديد اتحفظ - نفضل المودال مفتوح ونوريله قسم رفع الصورة على طول
    currentEditingProductId = data.id;
    document.getElementById('productId').value = data.id;
    document.getElementById('f_sku').disabled = true;
    document.getElementById('modalTitle').textContent = 'تم الحفظ! تقدر تضيف صورة دلوقتي';
    document.getElementById('imageSection').style.display = 'block';
    loadProducts();
    return;
  }

  modal.classList.add('hidden');
  loadProducts();
});

// ---- Modal إدارة الـ EANs المرتبطة بمنتج ----
const offersModal = document.getElementById('offersModal');
let currentOffersProductId = null;

window.openOffersModal = async (productId, sku) => {
  currentOffersProductId = productId;
  document.getElementById('offersModalTitle').textContent = `EANs المرتبطة بـ ${sku}`;
  await populateAccountSelect(document.getElementById('o_account'));
  await loadOffers();
  offersModal.classList.remove('hidden');
};

document.getElementById('closeOffersModalBtn').addEventListener('click', () => {
  offersModal.classList.add('hidden');
  loadProducts(); // نحدّث عدد الـ EANs في الجدول بعد القفل
});

async function populateAccountSelect(selectEl, selectedId = null) {
  const res = await fetch('/api/accounts');
  const { accounts } = await res.json();
  selectEl.innerHTML =
    '<option value="">بدون حساب</option>' +
    accounts.map(a => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${a.name}</option>`).join('');
}

async function loadOffers() {
  const res = await fetch(`/api/products/${currentOffersProductId}/offers`);
  const { offers } = await res.json();
  const accountsRes = await fetch('/api/accounts');
  const { accounts } = await accountsRes.json();
  const accountOptions = (selectedId) =>
    '<option value="">بدون حساب</option>' +
    accounts.map(a => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${a.name}</option>`).join('');

  document.querySelector('#offersTable tbody').innerHTML = offers.map(o => `
    <tr>
      <td><select onchange="updateOfferField(${o.id}, 'account_id', this.value)" style="width:110px">${accountOptions(o.account_id)}</select></td>
      <td><input type="text" value="${o.ean || ''}" onchange="updateOfferField(${o.id}, 'ean', this.value)" style="width:110px"></td>
      <td><input type="text" value="${o.bol_offer_id || ''}" onchange="updateOfferField(${o.id}, 'bol_offer_id', this.value)" style="width:110px"></td>
      <td><input type="text" value="${o.reference || ''}" onchange="updateOfferField(${o.id}, 'reference', this.value)" style="width:100px"></td>
      <td><input type="number" step="0.01" value="${o.sell_price}" onchange="updateOfferField(${o.id}, 'sell_price', this.value)" style="width:80px"></td>
      <td><input type="number" min="1" value="${o.units_per_sale || 1}" onchange="updateOfferField(${o.id}, 'units_per_sale', this.value)" style="width:60px"></td>
      <td>
        <button class="icon-btn" onclick="moveOfferToProduct(${o.id})" title="نقل لمنتج تاني">➡️</button>
        <button class="icon-btn" onclick="deleteOffer(${o.id})">🗑️</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7">مفيش EANs مرتبطة لسه - ضيف واحد تحت</td></tr>';
}

window.updateOfferField = async (offerId, field, value) => {
  await fetch(`/api/products/${currentOffersProductId}/offers/${offerId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [field]: value })
  });
};

window.moveOfferToProduct = async (offerId) => {
  const targetSku = prompt('اكتب SKU المنتج الأساسي اللي عايز تنقل الـ EAN ده ليه:');
  if (!targetSku) return;

  try {
    const res = await fetch(`/api/products/${currentOffersProductId}/offers/${offerId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSku })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'فشل النقل'); return; }
    alert(`تم النقل لـ "${data.movedTo.name}" (${data.movedTo.sku}) ✅`);
    loadOffers();
  } catch (e) {
    alert('مشكلة في الاتصال بالسيرفر');
  }
};

window.deleteOffer = async (offerId) => {
  if (!confirm('متأكد إنك عايز تفك ربط الـ EAN ده؟')) return;
  await fetch(`/api/products/${currentOffersProductId}/offers/${offerId}`, { method: 'DELETE' });
  loadOffers();
};

document.getElementById('offerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    account_id: document.getElementById('o_account').value || null,
    ean: document.getElementById('o_ean').value,
    bol_offer_id: document.getElementById('o_offer').value,
    reference: document.getElementById('o_reference').value,
    sell_price: document.getElementById('o_price').value,
    units_per_sale: document.getElementById('o_units').value
  };
  const res = await fetch(`/api/products/${currentOffersProductId}/offers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'حصل خطأ'); return; }
  e.target.reset();
  loadOffers();
});

// ---- استيراد CSV ----
document.getElementById('csvInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/products/import', { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'فشل الاستيراد'); return; }
  alert(
    `تم! منتجات جديدة: ${data.productsCreated} | منتجات اتحدّثت: ${data.productsUpdated} | EANs جديدة: ${data.offersCreated} | EANs اتحدّثت: ${data.offersUpdated}` +
    (data.errors?.length ? `\nتحذيرات: ${data.errors.length} (شوف الـ console)` : '')
  );
  if (data.errors?.length) console.warn('تحذيرات الاستيراد:', data.errors);
  loadProducts();
  e.target.value = '';
});

// ---- مزامنة فردية مع bol.com (بتبعت لكل الـ EANs المرتبطة بالمنتج) ----
window.syncProductToBol = async (id) => {
  try {
    const res = await fetch(`/api/products/${id}/push-to-bol`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      alert('فشلت المزامنة: ' + (data.error || 'خطأ غير معروف'));
      return;
    }
    const lines = data.results.map(r => {
      const parts = [`EAN ${r.ean || '?'}:`];
      if (r.price) parts.push('السعر ' + r.price);
      if (r.stock) parts.push('المخزون ' + r.stock);
      if (r.sku) parts.push('SKU ' + r.sku);
      return parts.join(' | ');
    });
    alert('نتيجة المزامنة:\n' + lines.join('\n'));
  } catch (e) {
    alert('مشكلة في الاتصال بالسيرفر');
  }
};

// ---- مزامنة جماعية مع bol.com ----
let pushAllInterval = null;

document.getElementById('pushAllBtn').addEventListener('click', async () => {
  const btn = document.getElementById('pushAllBtn');
  btn.disabled = true;
  btn.textContent = '⏳ جاري البدء...';

  try {
    const res = await fetch('/api/products/push-all-to-bol', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      alert('تعذّر بدء المزامنة: ' + (data.error || ''));
      btn.disabled = false;
      btn.textContent = '🔄 مزامنة الكل مع bol.com';
      return;
    }
    pollPushAllStatus();
  } catch (e) {
    alert('مشكلة في الاتصال بالسيرفر');
    btn.disabled = false;
    btn.textContent = '🔄 مزامنة الكل مع bol.com';
  }
});

function pollPushAllStatus() {
  const btn = document.getElementById('pushAllBtn');
  if (pushAllInterval) clearInterval(pushAllInterval);

  pushAllInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/products/push-all-to-bol/status');
      const job = await res.json();

      if (job.status === 'running') {
        btn.textContent = `⏳ جاري المزامنة... (${job.processed || 0}/${job.total || '?'})`;
      } else if (job.status === 'success') {
        clearInterval(pushAllInterval);
        btn.disabled = false;
        btn.textContent = '🔄 مزامنة الكل مع bol.com';
        alert(`تمت مزامنة ${job.processed} منتج` + (job.errors?.length ? `\nتحذيرات: ${job.errors.length} (شوف الـ console)` : ''));
        if (job.errors?.length) console.warn('تحذيرات المزامنة الجماعية:', job.errors);
      } else if (job.status === 'error') {
        clearInterval(pushAllInterval);
        btn.disabled = false;
        btn.textContent = '🔄 مزامنة الكل مع bol.com';
        alert('حصل خطأ: ' + job.error);
      }
    } catch (e) {
      // تجاهل وحاول تاني الدورة الجاية
    }
  }, 3000);
}

// ================= التقارير =================
let profitChartInstance = null;

document.getElementById('loadReportBtn').addEventListener('click', loadReport);

async function loadReport() {
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to + ' 23:59:59');

  const res = await fetch('/api/reports/profit?' + params.toString());
  const { summary, byProduct, byDay } = await res.json();

  document.getElementById('profitCards').innerHTML = `
    <div class="stat-card"><div class="label">عدد عمليات البيع</div><div class="value">${summary.total_sales || 0}</div></div>
    <div class="stat-card"><div class="label">الوحدات المباعة</div><div class="value">${summary.total_units_sold || 0}</div></div>
    <div class="stat-card accent"><div class="label">الإيراد</div><div class="value">${money(summary.revenue)}</div></div>
    <div class="stat-card"><div class="label">التكلفة</div><div class="value">${money(summary.cost)}</div></div>
    <div class="stat-card ${summary.profit < 0 ? 'warn' : ''}"><div class="label">صافي الربح</div><div class="value">${money(summary.profit)}</div></div>
  `;

  const ctx = document.getElementById('profitChart');
  if (profitChartInstance) profitChartInstance.destroy();
  profitChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: byDay.map(d => d.day),
      datasets: [
        { label: 'الإيراد', data: byDay.map(d => d.revenue), borderColor: '#d98e3f', tension: 0.3 },
        { label: 'الربح', data: byDay.map(d => d.profit), borderColor: '#1f6f5c', tension: 0.3 }
      ]
    },
    options: { responsive: true }
  });

  document.querySelector('#topProductsTable tbody').innerHTML = byProduct.map(p => `
    <tr><td>${p.sku}</td><td>${p.name}</td><td>${p.units_sold}</td><td>${money(p.revenue)}</td><td>${money(p.profit)}</td></tr>
  `).join('') || '<tr><td colspan="5">مفيش مبيعات في الفترة دي</td></tr>';
}

// ================= استيراد من bol.com =================
let importPollInterval = null;

document.getElementById('importFromBolBtn').addEventListener('click', async () => {
  const btn = document.getElementById('importFromBolBtn');
  const statusEl = document.getElementById('importStatus');
  const accountId = document.getElementById('importAccountSelect').value;
  if (!accountId) { statusEl.textContent = '❌ اختار الحساب الأول'; return; }

  btn.disabled = true;
  statusEl.textContent = '⏳ جاري بدء الاستيراد...';

  try {
    const res = await fetch('/api/sync/import-from-bol', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      statusEl.textContent = '❌ تعذّر بدء الاستيراد: ' + (data.error || 'خطأ غير معروف');
      btn.disabled = false;
      return;
    }
    statusEl.textContent = '⏳ الاستيراد شغال في الخلفية... ممكن ياخد دقيقة أو دقيقتين، تقدر تفضل مستخدم المنصة عادي.';
    pollImportStatus();
  } catch (e) {
    statusEl.textContent = '❌ مشكلة في الاتصال بالسيرفر';
    btn.disabled = false;
  }
});

async function loadAccountsForImportSelect() {
  await populateAccountSelect(document.getElementById('importAccountSelect'));
}

function pollImportStatus() {
  const btn = document.getElementById('importFromBolBtn');
  const statusEl = document.getElementById('importStatus');
  if (importPollInterval) clearInterval(importPollInterval);

  importPollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/sync/import-from-bol/status');
      const job = await res.json();

      if (job.status === 'running') {
        statusEl.textContent = '⏳ الاستيراد لسه شغال... استنى شوية.';
      } else if (job.status === 'success') {
        const r = job.result;
        statusEl.textContent =
          `✅ تم! إجمالي العروض: ${r.totalRows} | اتحدّث: ${r.offersUpdated} | ` +
          `EANs اتضافت لمنتجات موجودة: ${r.offersAddedToExisting} | منتجات جديدة اتعملت: ${r.productsCreated}` +
          (r.errors?.length ? ` | تحذيرات: ${r.errors.length} (شوف الـ console)` : '');
        if (r.errors?.length) console.warn('تحذيرات الاستيراد:', r.errors);
        clearInterval(importPollInterval);
        btn.disabled = false;
        loadProducts();
      } else if (job.status === 'error') {
        statusEl.textContent = '❌ فشل الاستيراد: ' + job.error;
        clearInterval(importPollInterval);
        btn.disabled = false;
      }
    } catch (e) {
      // تجاهل الخطأ ده وحاول تاني في الدورة الجاية
    }
  }, 3000);
}

// ================= المزامنة =================
document.getElementById('runSyncBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('syncStatus');
  statusEl.textContent = 'جاري المزامنة...';
  const res = await fetch('/api/sync/run', { method: 'POST' });
  const data = await res.json();
  statusEl.textContent = `النتيجة: ${data.status} | طلبات: ${data.ordersProcessed || 0} | تحديثات مخزون: ${data.stockPushed || 0}`;
  if (data.errors?.length) statusEl.textContent += ' | أخطاء: ' + data.errors.join(' - ');
  loadSyncLog();
});

async function loadSyncLog() {
  const res = await fetch('/api/sync/log');
  const { logs } = await res.json();
  document.querySelector('#syncLogTable tbody').innerHTML = logs.map(l => `
    <tr><td>${new Date(l.ran_at).toLocaleString('ar-EG')}</td><td>${l.status}</td><td>${l.orders_processed}</td><td>${l.stock_pushed}</td><td>${l.message || '-'}</td></tr>
  `).join('') || '<tr><td colspan="5">مفيش سجل مزامنة لسه</td></tr>';
}

// ================= حسابات bol.com =================
async function loadAccounts() {
  const res = await fetch('/api/accounts');
  const { accounts } = await res.json();
  document.querySelector('#accountsTable tbody').innerHTML = accounts.map(a => `
    <tr>
      <td>${a.name}</td>
      <td>${a.client_id}</td>
      <td>${a.client_secret}</td>
      <td>${a.active ? 'نشط ✅' : 'متوقف ⏸️'}</td>
      <td>
        <button class="icon-btn" onclick="editAccount(${a.id})">✏️</button>
        <button class="icon-btn" onclick="deleteAccount(${a.id})">🗑️</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="5">مفيش حسابات مضافة لسه</td></tr>';
}

const accountModal = document.getElementById('accountModal');
document.getElementById('addAccountBtn').addEventListener('click', () => openAccountModal());
document.getElementById('cancelAccountModalBtn').addEventListener('click', () => accountModal.classList.add('hidden'));

function openAccountModal(account = null) {
  document.getElementById('accountModalTitle').textContent = account ? 'تعديل الحساب' : 'إضافة حساب bol.com جديد';
  document.getElementById('a_id').value = account?.id || '';
  document.getElementById('a_name').value = account?.name || '';
  document.getElementById('a_client_id').value = account?.client_id || '';
  document.getElementById('a_client_secret').value = '';
  accountModal.classList.remove('hidden');
}

window.editAccount = async (id) => {
  const res = await fetch('/api/accounts');
  const { accounts } = await res.json();
  const account = accounts.find(a => a.id === id);
  if (account) openAccountModal(account);
};

window.deleteAccount = async (id) => {
  if (!confirm('متأكد إنك عايز تمسح الحساب ده؟')) return;
  const res = await fetch('/api/accounts/' + id, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'حصل خطأ'); return; }
  loadAccounts();
};

document.getElementById('accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('a_id').value;
  const body = {
    name: document.getElementById('a_name').value,
    client_id: document.getElementById('a_client_id').value,
    client_secret: document.getElementById('a_client_secret').value
  };
  const url = id ? '/api/accounts/' + id : '/api/accounts';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'حصل خطأ'); return; }
  accountModal.classList.add('hidden');
  loadAccounts();
});

// تحميل أولي
loadOverview();
