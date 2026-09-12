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
    if (btn.dataset.tab === 'sync') loadSyncLog();
  });
});

const money = (n) => (Number(n) || 0).toLocaleString('ar-EG', { style: 'currency', currency: 'EUR' });

// ================= نظرة عامة =================
async function loadOverview() {
  const res = await fetch('/api/reports/inventory-summary');
  const { totals, lowStock } = await res.json();

  document.getElementById('summaryCards').innerHTML = `
    <div class="stat-card"><div class="label">عدد الأصناف</div><div class="value">${totals.total_products || 0}</div></div>
    <div class="stat-card"><div class="label">إجمالي الوحدات بالمخزون</div><div class="value">${totals.total_units || 0}</div></div>
    <div class="stat-card"><div class="label">قيمة المخزون (تكلفة)</div><div class="value">${money(totals.inventory_cost_value)}</div></div>
    <div class="stat-card accent"><div class="label">قيمة المخزون (سعر بيع)</div><div class="value">${money(totals.inventory_retail_value)}</div></div>
  `;

  const tbody = document.querySelector('#lowStockTable tbody');
  tbody.innerHTML = lowStock.length
    ? lowStock.map(p => `<tr><td>${p.sku}</td><td>${p.name}</td><td>${p.stock_qty}</td><td>${p.low_stock_threshold}</td></tr>`).join('')
    : '<tr><td colspan="4">مفيش أصناف ناقصة دلوقتي 🎉</td></tr>';
}

// ================= المخزون =================
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
      <td>${p.sku}</td>
      <td>${p.name}</td>
      <td>${p.ean || '-'}</td>
      <td>${p.bol_offer_id || '-'}</td>
      <td>${money(p.cost_price)}</td>
      <td>${money(p.sell_price)}</td>
      <td>${p.stock_qty}</td>
      <td>
        <button class="icon-btn" onclick="editProduct(${p.id})">✏️</button>
        <button class="icon-btn" onclick="deleteProduct(${p.id})">🗑️</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="8">مفيش نتائج</td></tr>';

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

// ---- Modal إضافة/تعديل ----
const modal = document.getElementById('productModal');
document.getElementById('addProductBtn').addEventListener('click', () => openModal());
document.getElementById('cancelModalBtn').addEventListener('click', () => modal.classList.add('hidden'));

function openModal(product = null) {
  document.getElementById('modalTitle').textContent = product ? 'تعديل صنف' : 'إضافة صنف جديد';
  document.getElementById('productId').value = product?.id || '';
  document.getElementById('f_sku').value = product?.sku || '';
  document.getElementById('f_sku').disabled = !!product;
  document.getElementById('f_name').value = product?.name || '';
  document.getElementById('f_ean').value = product?.ean || '';
  document.getElementById('f_offer').value = product?.bol_offer_id || '';
  document.getElementById('f_cost').value = product?.cost_price ?? '';
  document.getElementById('f_sell').value = product?.sell_price ?? '';
  document.getElementById('f_stock').value = product?.stock_qty ?? '';
  document.getElementById('f_threshold').value = product?.low_stock_threshold ?? 5;
  modal.classList.remove('hidden');
}

window.editProduct = async (id) => {
  const res = await fetch('/api/products?search=&page=1&pageSize=1000');
  const data = await res.json();
  const product = data.products.find(p => p.id === id);
  if (product) openModal(product);
};

window.deleteProduct = async (id) => {
  if (!confirm('متأكد إنك عايز تمسح الصنف ده؟')) return;
  await fetch('/api/products/' + id, { method: 'DELETE' });
  loadProducts();
};

document.getElementById('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('productId').value;
  const body = {
    sku: document.getElementById('f_sku').value,
    name: document.getElementById('f_name').value,
    ean: document.getElementById('f_ean').value,
    bol_offer_id: document.getElementById('f_offer').value,
    cost_price: document.getElementById('f_cost').value,
    sell_price: document.getElementById('f_sell').value,
    stock_qty: document.getElementById('f_stock').value,
    low_stock_threshold: document.getElementById('f_threshold').value
  };

  const url = id ? '/api/products/' + id : '/api/products';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'حصل خطأ'); return; }

  modal.classList.add('hidden');
  loadProducts();
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
  alert(`تم استيراد ${data.imported} من ${data.total} صنف بنجاح`);
  loadProducts();
  e.target.value = '';
});

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

// تحميل أولي
loadOverview();
