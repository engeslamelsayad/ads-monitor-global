// لوحة الإعلانات — واجهة بدون build، كل النصوص الديناميكية بتعدّي على esc()

const $app = document.getElementById('app');
const $dlg = document.getElementById('dialog');

const state = {
  me: null,
  tab: (location.hash || '#overview').slice(1),
  days: 1,
  productFilter: null,
  overview: null,
  products: null,
  discovery: null,
  logsView: 'actions'
};

// ==================== أدوات ====================
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bdi = (v) => `<bdi>${esc(v)}</bdi>`;
const n0 = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en'));
const n2 = (v) => (v == null ? '—' : Number(v).toLocaleString('en', { maximumFractionDigits: 2, minimumFractionDigits: 0 }));
const cur = () => esc(state.me?.tenant?.currency || '');
const tz = () => state.me?.tenant?.timezone || 'Africa/Cairo';

function relTime(ms) {
  if (!ms) return 'لم يحدث';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'دلوقتي';
  if (m < 60) return `من ${m} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 24) return `من ${h} ساعة`;
  return `من ${Math.round(h / 24)} يوم`;
}
function fmtWhen(ms) {
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: tz(), day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Requested-With': 'dashboard' };
  const tenant = localStorage.getItem('tenant');
  if (tenant && state.me?.role === 'admin') headers['X-Tenant'] = tenant;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { renderLogin(data.error); throw new Error(data.error || 'غير مسجل'); }
  if (!res.ok) throw new Error(data.error || `خطأ ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 6000 : 3500);
}

async function run(btn, fn) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
  try { return await fn(); } catch (e) { toast(e.message, true); return null; } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}

// ==================== مقياس CPP ====================
// المحور من 0 لـ 160% من Max: منطقة Scale ← ضمن الحد ← قريب من الحد (buffer) ← تجاوز
function zoneOf(cpp, max) {
  const s = state.overview?.settings || { bufferPct: 110, scalePct: 60 };
  if (cpp == null || !max) return 'none';
  if (cpp < max * s.scalePct / 100) return 'scale';
  if (cpp <= max) return 'ok';
  if (cpp <= max * s.bufferPct / 100) return 'near';
  return 'over';
}
const ZONE_LABEL = { scale: 'فرصة Scale', ok: 'ضمن الحد', near: 'قريب من الحد', over: 'فوق الحد', none: 'لا مبيعات' };

function gauge(cpp, max, sm = false) {
  const s = state.overview?.settings || { bufferPct: 110, scalePct: 60 };
  const z = zoneOf(cpp, max);
  if (!max) return `<span class="num">${n2(cpp)}</span>`;
  const axis = max * 1.6;
  const w = (v) => `${Math.max(0, Math.min(100, (v / axis) * 100))}%`;
  const scaleW = (s.scalePct / 160) * 100, okW = ((100 - s.scalePct) / 160) * 100,
    nearW = ((s.bufferPct - 100) / 160) * 100, overW = 100 - scaleW - okW - nearW;
  const fill = cpp == null ? 0 : Math.min(cpp, axis);
  return `<div class="gauge ${z}${sm ? ' sm' : ''}" title="${ZONE_LABEL[z]} — Max ${n2(max)}">
    <span class="val num">${cpp == null ? '—' : n2(cpp)}</span>
    <span class="bar">
      <span class="zones"><i style="width:${scaleW}%;background:var(--z-scale)"></i><i style="width:${okW}%;background:var(--z-ok)"></i><i style="width:${nearW}%;background:var(--z-near)"></i><i style="width:${overW}%;background:var(--z-over)"></i></span>
      <span class="fill" style="width:${w(fill)}"></span>
      <span class="max" style="left:${w(max)}"></span>
    </span>
  </div>`;
}

const plat = (p) => `<span class="plat ${p === 'tiktok' ? 'tiktok' : 'meta'}">${p === 'tiktok' ? 'TikTok' : 'Meta'}</span>`;

// ==================== الهيكل ====================
const TABS = [
  ['overview', 'الأداء'],
  ['products', 'المنتجات'],
  ['discovery', 'الاكتشاف'],
  ['accounts', 'الحسابات'],
  ['settings', 'الإعدادات'],
  ['team', 'الفريق'],
  ['logs', 'السجل']
];

function renderShell() {
  const t = state.me.tenant;
  const admin = state.me.role === 'admin';
  const tenantSel = admin && state.me.tenants?.length
    ? `<select class="input" data-change="tenant" aria-label="العميل">${state.me.tenants.map(x =>
      `<option value="${esc(x.id)}" ${x.id === t?.id ? 'selected' : ''}>${esc(x.name)}${x.ready ? '' : ' (غير مكتمل)'}</option>`).join('')}</select>`
    : '';
  const unmatched = state.overview?.unmatched?.length || 0;
  $app.innerHTML = `
    <header class="top">
      <div class="top-row">
        <div class="brand">
          <h1>${esc(t?.name || 'لوحة الإعلانات')}</h1>
          ${t?.botUsername ? `<span class="bot num">@${esc(t.botUsername)}</span>` : ''}
          ${admin ? '<span class="badge">أدمن</span>' : ''}
        </div>
        <div class="top-actions">
          ${tenantSel}
          <button class="btn ghost sm" data-action="logout">تسجيل خروج</button>
        </div>
      </div>
      <nav class="tabs" role="tablist">
        ${TABS.map(([id, label]) => `<button class="tab" role="tab" aria-selected="${state.tab === id}" data-tab="${id}">${label}${
          id === 'discovery' && unmatched ? ` <span class="badge warn num">${unmatched}</span>` : ''}</button>`).join('')}
      </nav>
    </header>
    <main id="main"></main>`;
  if (!t) {
    document.getElementById('main').innerHTML = `<div class="empty"><p>لا يوجد عملاء بعد.</p><p class="muted">ضيف أول عميل من بوت الأدمن: /new_tenant</p></div>`;
    return;
  }
  renderTab();
}

async function renderTab() {
  const main = document.getElementById('main');
  if (!main) return;
  const fn = { overview: viewOverview, products: viewProducts, discovery: viewDiscovery, accounts: viewAccounts, settings: viewSettings, team: viewTeam, logs: viewLogs }[state.tab] || viewOverview;
  try { await fn(main); } catch (e) { main.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; }
}

function renderLogin(message) {
  const expired = new URLSearchParams(location.search).has('expired');
  $app.innerHTML = `
    <div class="login">
      <h1>لوحة الإعلانات</h1>
      <p class="muted">${expired ? 'اللينك ده اتستخدم قبل كده أو انتهت صلاحيته.' : esc(message || 'الدخول بيتم من بوت Telegram.')}</p>
      <ol class="steps">
        <li>افتح بوت الحساب على Telegram</li>
        <li>اكتب <code>/dashboard</code></li>
        <li>اضغط على اللينك اللي هيوصلك — صالح 15 دقيقة ومرة واحدة</li>
      </ol>
    </div>`;
}

// ==================== الأداء ====================
async function loadOverview() {
  state.overview = await api(`/overview?days=${state.days}`);
  return state.overview;
}

async function viewOverview(main) {
  main.innerHTML = '<div class="boot">جاري تحميل الأرقام…</div>';
  const o = await loadOverview();
  const t = state.me.tenant;

  if (!t.ready) {
    main.innerHTML = `<div class="notice"><b>الإعداد غير مكتمل.</b>
      <span>${!t.setup.meta && !t.setup.tiktok ? 'اربط Meta أو TikTok من البوت بأمر /setup.' : 'ضيف المنتجات من تبويب الاكتشاف أو المنتجات.'}</span>
      ${t.setup.meta || t.setup.tiktok ? '<button class="btn primary sm" data-tab="discovery">ابدأ الاكتشاف</button>' : ''}</div>`;
    return;
  }

  const maxSpend = Math.max(...o.daily.map(d => d.spend), 1);
  const periods = [[1, 'اليوم'], [3, '3 أيام'], [7, '7 أيام'], [14, '14 يوم'], [30, '30 يوم']];
  const products = o.products;
  const adsets = state.productFilter ? o.adsets.filter(a => a.product === state.productFilter) : o.adsets;

  main.innerHTML = `
    <section>
      <div class="sec-head">
        <div class="seg" role="group" aria-label="الفترة">${periods.map(([d, l]) =>
          `<button aria-pressed="${state.days === d}" data-days="${d}">${l}</button>`).join('')}</div>
        <span class="spacer"></span>
        <span class="muted small">آخر فحص ${relTime(o.lastCycle)}</span>
        <button class="btn sm" data-action="check">${o.cycleRunning ? '<span class="spin"></span> فحص شغال' : 'فحص الآن'}</button>
      </div>
      <div class="totals">
        <div class="t"><b class="num">${n0(o.totals.spend)}</b><span>الإنفاق (${cur()})</span></div>
        <div class="t"><b class="num">${n0(o.totals.purchases)}</b><span>المبيعات</span></div>
        <div class="t"><b class="num">${n2(o.totals.cpp)}</b><span>متوسط CPP</span></div>
        <div class="meta-line">${o.range.days > 1 ? `من <span class="num">${esc(o.range.from)}</span> إلى <span class="num">${esc(o.range.to)}</span>` : `<span class="num">${esc(o.range.to)}</span>`}</div>
        ${o.daily.length > 1 ? `<div class="days" style="width:100%">${o.daily.map(d =>
          `<div class="d" style="height:${Math.max(4, (d.spend / maxSpend) * 100)}%" data-tip="${esc(d.date)}: ${n0(d.spend)} ${cur()} — CPP ${n2(d.cpp)}"></div>`).join('')}</div>` : ''}
      </div>
    </section>

    ${o.unmatched.length ? `<section><div class="notice"><b>${o.unmatched.length} حملة بتصرف من غير مراقبة</b>
      <span class="muted num">${n0(o.unmatched.reduce((a, c) => a + c.spend, 0))} ${cur()} النهارده</span>
      <button class="btn sm" data-tab="discovery">اكتشف منتجاتها</button></div></section>` : ''}

    <section>
      <div class="sec-head"><h2>المنتجات</h2><span class="spacer"></span>
        <div class="legend"><span><i style="background:var(--z-scale)"></i>فرصة Scale</span><span><i style="background:var(--z-ok)"></i>ضمن الحد</span><span><i style="background:var(--z-near)"></i>قريب من الحد</span><span><i style="background:var(--z-over)"></i>فوق الحد</span><span><i style="background:var(--ink);width:3px"></i>Max CPP</span></div>
      </div>
      <div class="panel table-wrap">${products.length ? `<table>
        <thead><tr><th>المنتج</th><th>CPP مقابل الحد</th><th class="hide-sm">Max</th><th>الإنفاق</th><th>المبيعات</th><th class="hide-sm">Meta CPP</th><th class="hide-sm">TikTok CPP</th></tr></thead>
        <tbody>${products.map(p => `<tr class="clickable ${state.productFilter === p.name ? 'selected' : ''}" data-filter="${esc(p.name)}">
          <td class="name"><span class="main">${bdi(p.name)}</span><span class="sub">Max <span class="num">${n2(p.maxCpp)}</span> — <span class="num">${p.adsets}</span> Ad Set</span></td>
          <td>${gauge(p.cpp, p.maxCpp)}</td>
          <td class="num hide-sm">${n2(p.maxCpp)}</td>
          <td class="num">${n0(p.spend)}</td>
          <td class="num">${n0(p.purchases)}</td>
          <td class="num hide-sm">${p.metaSpend ? n2(p.metaCpp) : '<span class="muted">—</span>'}</td>
          <td class="num hide-sm">${p.tiktokSpend ? n2(p.tiktokCpp) : '<span class="muted">—</span>'}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty"><p>مفيش إنفاق في الفترة دي.</p></div>`}</div>
    </section>

    <section>
      <div class="sec-head"><h2>Ad Sets${state.productFilter ? ` — ${bdi(state.productFilter)}` : ''}</h2>
        ${state.productFilter ? '<button class="btn ghost sm" data-action="clear-filter">عرض الكل</button>' : ''}
        <span class="spacer"></span><span class="muted small num">${adsets.length}</span></div>
      <div class="panel table-wrap">${adsets.length ? `<table class="stack">
        <thead><tr><th>Ad Set</th><th>CPP</th><th>الإنفاق</th><th>المبيعات</th><th>الميزانية</th><th>العمر</th><th></th></tr></thead>
        <tbody>${adsets.map(a => `<tr>
          <td class="name"><span class="main">${plat(a.platform)} ${bdi(a.name)}</span><span class="sub">${bdi(a.product)} — ${bdi(a.campaign)}</span></td>
          <td>${gauge(a.cpp, a.maxCpp, true)}</td>
          <td class="num" data-label="الإنفاق">${n0(a.spend)}</td>
          <td class="num" data-label="المبيعات">${n0(a.purchases)}</td>
          <td class="num" data-label="الميزانية">${a.budget ? n0(a.budget) : '<span class="muted small">CBO</span>'}</td>
          <td data-label="العمر">${a.ageDays == null ? '<span class="muted">—</span>' : `<span class="badge num ${a.ageDays >= 21 ? 'warn' : ''}">${a.ageDays} يوم</span>`}</td>
          <td class="actions">${a.activeToday ? `
            <button class="btn sm" data-action="budget" data-id="${esc(a.id)}">الميزانية</button>
            <button class="btn sm danger" data-action="pause" data-id="${esc(a.id)}">إيقاف</button>` : '<span class="muted small">مش شغال النهارده</span>'}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty"><p>مفيش Ad Sets في الفترة دي.</p></div>`}</div>
    </section>`;
}

// ---------- حوار الإيقاف ----------
function findAdset(id) { return state.overview?.adsets.find(a => a.id === id); }

function openDialog(html) {
  $dlg.innerHTML = html;
  $dlg.showModal();
}

function pauseDialog(id) {
  const a = findAdset(id);
  openDialog(`
    <div class="dlg-head"><h3>إيقاف ${a.platform === 'tiktok' ? 'Ad Group' : 'Ad Set'}</h3></div>
    <div class="dlg-body"><p><b>${bdi(a.name)}</b><br><span class="muted small">${bdi(a.campaign)}</span></p>
      <p class="muted small">هيتضاف "claude edit" لاسمه، وفريقك هيتبلغ على Telegram.</p></div>
    <div class="dlg-foot"><button class="btn danger" data-action="confirm-pause" data-id="${esc(id)}">إيقاف</button>
      <button class="btn ghost" data-action="close">إلغاء</button></div>`);
}

// ---------- حوار الميزانية ----------
async function budgetDialog(id) {
  const a = findAdset(id);
  openDialog(`<div class="dlg-head"><h3>ميزانية ${bdi(a.name)}</h3></div><div class="dlg-body"><p class="muted"><span class="spin"></span> جاري جلب الميزانية الحالية…</p></div>
    <div class="dlg-foot"><button class="btn ghost" data-action="close">إغلاق</button></div>`);
  let b;
  try { b = await api(`/adsets/${encodeURIComponent(id)}/budget`); } catch (e) {
    $dlg.querySelector('.dlg-body').innerHTML = `<p>${esc(e.message)}</p>`; return;
  }
  if (b.isCBO) {
    $dlg.querySelector('.dlg-body').innerHTML = `<p>الميزانية على مستوى الحملة (CBO) — عدّلها من Ads Manager.</p>`; return;
  }
  const pcts = [-50, -30, -20, 20, 40, 60, 100];
  $dlg.innerHTML = `
    <div class="dlg-head"><h3>ميزانية ${bdi(a.name)}</h3></div>
    <div class="dlg-body">
      <p class="muted small">الحالية <b class="num">${n2(b.budget)} ${cur()}</b> يومياً — الحد الأدنى <span class="num">${n2(b.floor)}</span></p>
      <div class="pct-grid">${pcts.map(p => `<button class="btn ${p < 0 ? 'down' : 'up'}" data-pct="${p}"><bdi class="num">${p > 0 ? '+' : '−'}${Math.abs(p)}%</bdi></button>`).join('')}
        <input class="input num" type="number" min="-90" max="200" step="1" placeholder="نسبة" data-custom-pct aria-label="نسبة مخصصة"></div>
      <div class="preview" data-preview>اختار نسبة</div>
    </div>
    <div class="dlg-foot"><button class="btn primary" data-action="confirm-budget" data-id="${esc(id)}" disabled>تطبيق</button>
      <button class="btn ghost" data-action="close">إلغاء</button></div>`;
  $dlg.dataset.budget = b.budget;
  $dlg.dataset.floor = b.floor;
}

function setBudgetPct(pct) {
  const base = parseFloat($dlg.dataset.budget), floor = parseFloat($dlg.dataset.floor);
  const btn = $dlg.querySelector('[data-action="confirm-budget"]');
  $dlg.querySelectorAll('[data-pct]').forEach(b => b.setAttribute('aria-pressed', String(parseInt(b.dataset.pct) === pct)));
  const prev = $dlg.querySelector('[data-preview]');
  if (!pct || pct < -90 || pct > 200) { prev.textContent = 'النسبة من -90% لـ +200%'; btn.disabled = true; return; }
  const next = base * (1 + pct / 100);
  const low = pct < 0 && next < floor;
  prev.innerHTML = `${pct > 0 ? 'رفع' : 'تقليل'} <span class="num">${Math.abs(pct)}%</span>: من <span class="num">${n2(base)}</span> إلى <b class="num">${n2(next)}</b> ${cur()} يومياً${low ? '<br><span style="color:var(--z-over)">أقل من الحد الأدنى للميزانية</span>' : ''}`;
  btn.disabled = low;
  btn.dataset.pct = pct;
}

// ==================== المنتجات ====================
async function viewProducts(main) {
  const { products } = await api('/products');
  state.products = products;
  main.innerHTML = `
    <section>
      <div class="sec-head"><h2>إضافة منتج</h2></div>
      <form class="panel pad" data-form="add-product" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div class="field"><label for="np-name">الاسم</label><input id="np-name" class="input" name="name" required maxlength="60" placeholder="كلمة موجودة في اسم الحملة"></div>
        <div class="field"><label for="np-max">Max CPP</label><input id="np-max" class="input num" name="maxCpp" type="number" step="any" min="1" required></div>
        <div class="field" style="flex:1;min-width:200px"><label for="np-al">أسماء بديلة (اختياري)</label><input id="np-al" class="input" name="aliases" placeholder="مفصولة بفاصلة، مثلاً: wart cream, الزوائد" style="width:100%"></div>
        <button class="btn primary" type="submit">إضافة</button>
      </form>
      <p class="muted small">المنتج بيتطابق مع أي حملة اسمها فيه الاسم أو أي اسم بديل. أسهل طريقة لإضافة منتجات كتير: تبويب الاكتشاف.</p>
    </section>
    <section>
      <div class="sec-head"><h2>المنتجات</h2><span class="muted small num">${products.length}</span></div>
      <div class="panel table-wrap">${products.length ? `<table>
        <thead><tr><th>الاسم</th><th>Max CPP</th><th>الأسماء البديلة</th><th></th></tr></thead>
        <tbody>${products.map((p, i) => `<tr data-row="${i}">
          <td><input class="input" value="${esc(p.name)}" data-field="name" maxlength="60" aria-label="الاسم"></td>
          <td><input class="input num" type="number" step="any" min="1" value="${esc(p.maxCpp)}" data-field="maxCpp" aria-label="Max CPP"></td>
          <td><div class="chips" data-chips>${(p.aliases || []).map(a => `<span class="chip">${esc(a)}<button type="button" data-action="rm-alias" data-alias="${esc(a)}" aria-label="حذف">×</button></span>`).join('')}
            <input class="chip-input" placeholder="+ اسم بديل" data-add-alias aria-label="إضافة اسم بديل"></div></td>
          <td class="actions"><button class="btn sm primary" data-action="save-product" data-i="${i}" hidden>حفظ</button>
            <button class="btn sm ghost danger" data-action="del-product" data-i="${i}">حذف</button></td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty"><p>مفيش منتجات لسه.</p><button class="btn primary" data-tab="discovery">اكتشف من الحملات</button></div>`}</div>
    </section>`;
}

function rowProduct(tr) {
  const i = parseInt(tr.dataset.row);
  const orig = state.products[i];
  return {
    orig,
    name: tr.querySelector('[data-field="name"]').value.trim(),
    maxCpp: parseFloat(tr.querySelector('[data-field="maxCpp"]').value),
    aliases: [...tr.querySelectorAll('.chip')].map(c => c.firstChild.textContent)
  };
}
function markDirty(tr) { tr.querySelector('[data-action="save-product"]').hidden = false; }

// ==================== الاكتشاف ====================
async function viewDiscovery(main) {
  const d = state.discovery;
  const t = state.me.tenant;
  if (!t.setup.meta && !t.setup.tiktok) {
    main.innerHTML = `<div class="notice"><b>اربط Meta أو TikTok الأول</b><span>من البوت بأمر /setup</span></div>`;
    return;
  }
  const opts = [7, 14, 30, 60, 90];
  main.innerHTML = `
    <section>
      <div class="sec-head"><h2>اكتشاف المنتجات من الحملات</h2></div>
      <div class="panel pad">
        <p style="margin-top:0">بيراجع الحملات اللي صرفت في الفترة، ويجمّع الحملات الجديدة في منتجات، ويقترح Max CPP من الأداء الفعلي (+10%).</p>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <label for="dv-days">الفترة</label>
          <select id="dv-days" class="input" data-dv-days>${opts.map(o => `<option value="${o}" ${(d?.days || 14) === o ? 'selected' : ''}>آخر ${o} يوم</option>`).join('')}</select>
          <button class="btn primary" data-action="run-discovery">ابدأ الاكتشاف</button>
          <span class="muted small">بياخد من نص دقيقة لدقيقتين</span>
        </div>
      </div>
    </section>
    <section id="dv-results">${d ? discoveryResults(d) : ''}</section>`;
}

function discoveryResults(d) {
  if (d.error) return `<div class="notice">${esc(d.error)}</div>`;
  if (!d.total) return `<div class="empty"><p>مفيش حملات صرفت آخر ${d.days} يوم.</p></div>`;
  if (!d.unmatchedCount) return `<div class="notice info"><b>كل الحملات (${d.total}) متطابقة مع منتجاتك.</b></div>`;
  if (!d.groups.length) return `<div class="notice">مقدرتش أحدد منتجات واضحة من أسماء الحملات — ضيفها يدوياً من تبويب المنتجات.</div>`;
  const products = state.me.productNames || [];
  return `
    <div class="sec-head"><h2>${d.groups.length} منتج مقترح</h2>
      <span class="muted small num">${d.total} حملة: ${d.matched} متطابقة و ${d.unmatchedCount} جديدة — آخر ${d.days} يوم</span>
      <span class="spacer"></span><button class="btn primary" data-action="apply-discovery">اعتماد المختار</button></div>
    <div class="panel table-wrap"><table>
      <thead><tr><th></th><th>المنتج</th><th>كلمات المطابقة</th><th>الحملات</th><th>الإنفاق</th><th>المبيعات</th><th>CPP الفعلي</th><th>Max CPP</th><th>الإجراء</th></tr></thead>
      <tbody>${d.groups.map((g, i) => {
        const link = !!g.existing;
        const on = link || (g.suggested && g.keys.length);
        return `<tr data-dv="${i}">
          <td><input type="checkbox" data-dv-on ${on ? 'checked' : ''} aria-label="اختيار"></td>
          <td><input class="input" data-dv-name value="${esc(g.name)}" maxlength="60" aria-label="اسم المنتج" style="width:140px"></td>
          <td><div class="chips">${g.keys.length ? g.keys.map(k => `<span class="chip" style="padding-left:10px">${esc(k)}</span>`).join('') : '<span class="badge warn">مفيش كلمة مميزة — غيّر الاسم</span>'}</div></td>
          <td><details><summary class="num">${g.campaigns.length}</summary><ul class="small" style="margin:6px 0;padding-inline-start:16px">${g.campaigns.map(c => `<li>${plat(c.platform)} ${esc(c.name)}${c.covered ? '' : ' <span class="badge warn">مش متطابقة</span>'}</li>`).join('')}</ul></details></td>
          <td class="num">${n0(g.spend)}</td>
          <td class="num">${n0(g.purchases)}</td>
          <td class="num">${g.purchases ? n2(g.cpp) : '—'}</td>
          <td><input class="input num" type="number" step="any" min="1" data-dv-max value="${g.suggested ?? ''}" placeholder="${g.suggested ? '' : 'حدده'}" aria-label="Max CPP"></td>
          <td><select class="input" data-dv-action aria-label="الإجراء">
            <option value="add" ${link ? '' : 'selected'}>منتج جديد</option>
            ${products.map(p => `<option value="link:${esc(p)}" ${g.existing === p ? 'selected' : ''}>ربط بـ ${esc(p)}</option>`).join('')}
          </select></td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
}

// ==================== الحسابات ====================
async function viewAccounts(main) {
  const acc = await api('/accounts');
  const block = (key, title) => {
    const a = acc[key];
    if (key === 'tiktok' && !a.available) return '';
    return `<section>
      <div class="sec-head"><h2>${title}</h2>
        ${a.connected ? `<span class="badge good">مربوط</span><span class="muted small num">توكن ${esc(a.token)}</span>` : '<span class="badge">مش مربوط</span>'}
        <span class="spacer"></span>
        ${a.connected ? `<button class="btn sm" data-action="edit-accounts" data-platform="${key}">تعديل الحسابات</button>` : ''}</div>
      <div class="panel pad" data-acc="${key}">
        ${a.connected ? (a.ids.length ? `<div class="chips">${a.ids.map(id => `<span class="chip" style="padding-left:10px">${esc(acc.names[id] || id)} <span class="muted num small">${esc(id)}</span></span>`).join('')}</div>`
          : '<p style="margin:0">مفيش حسابات مختارة — اضغط "تعديل الحسابات".</p>')
          : `<p style="margin:0">الربط بيتم من البوت عشان التوكن ما يعدّيش على المتصفح: اكتب <b>/setup</b>.</p>`}
      </div></section>`;
  };
  main.innerHTML = block('meta', 'Meta') + block('tiktok', 'TikTok') +
    `<p class="muted small">لإعادة الربط بتوكن جديد: /setup من البوت.</p>`;
}

async function editAccounts(platform, btn) {
  const box = document.querySelector(`[data-acc="${platform}"]`);
  const r = await run(btn, () => api(`/accounts/available?platform=${platform}`));
  if (!r) return;
  box.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input class="input" placeholder="بحث بالاسم أو رقم الحساب" data-acc-search style="flex:1;min-width:200px" aria-label="بحث">
      <span class="muted small" data-acc-count></span>
      <button class="btn primary" data-action="save-accounts" data-platform="${platform}">حفظ</button>
      <button class="btn ghost" data-action="reload">إلغاء</button>
    </div>
    <div class="pick-list">${r.accounts.sort((a, b) => (b.selected - a.selected) || ((b.active !== false) - (a.active !== false)) || String(a.name).localeCompare(String(b.name)))
      .map(a => `<label class="pick" data-search="${esc(`${a.name} ${a.id}`.toLowerCase())}">
        <input type="checkbox" value="${esc(a.id)}" ${a.selected ? 'checked' : ''}>
        <span>${esc(a.name || a.id)}${a.active === false ? ' <span class="badge">غير نشط</span>' : ''}</span>
        <span class="id num">${esc(a.id)}</span></label>`).join('')}</div>`;
  updateAccCount(box);
}
function updateAccCount(box) {
  const n = box.querySelectorAll('.pick input:checked').length;
  box.querySelector('[data-acc-count]').textContent = `${n} مختار`;
}

// ==================== الإعدادات ====================
async function viewSettings(main) {
  const { fields } = await api('/settings');
  main.innerHTML = `
    <section>
      <div class="sec-head"><h2>إعدادات التنبيه والتقارير</h2></div>
      <form class="panel pad" data-form="settings">
        <div class="form-grid">${fields.map(f => `
          <div class="field">
            <label for="s-${f.name}">${esc(f.label)}</label>
            <div class="row">
              <input id="s-${f.name}" class="input ${f.type === 'number' ? 'num' : ''}" name="${esc(f.name)}" value="${esc(f.value)}"
                ${f.type === 'number' ? `type="number" step="any" min="${f.min}" max="${f.max}"` : f.type === 'time' ? 'type="time"' : 'type="text"'}
                data-orig="${esc(f.value)}">
              ${f.unit ? `<span class="muted small">${esc(f.unit)}</span>` : ''}
            </div>
            ${f.type === 'number' ? `<div class="hint num">من ${f.min} لـ ${f.max}</div>` : ''}
          </div>`).join('')}</div>
        <div style="margin-top:20px"><button class="btn primary" type="submit">حفظ الإعدادات</button></div>
      </form>
      <p class="muted small">نفس الإعدادات اللي بتتغير من البوت بأمر /set — أي تعديل هنا بيظهر هناك فوراً.</p>
    </section>`;
}

// ==================== الفريق ====================
async function viewTeam(main) {
  const { users, me } = await api('/users');
  main.innerHTML = `
    <section>
      <div class="sec-head"><h2>المستخدمون</h2><span class="muted small num">${users.length}</span><span class="spacer"></span>
        <button class="btn primary sm" data-action="invite">لينك دعوة</button></div>
      <div class="panel" data-invite></div>
      <div class="panel table-wrap" style="margin-top:10px"><table>
        <thead><tr><th>Telegram ID</th><th></th></tr></thead>
        <tbody>${users.map(u => `<tr><td class="num">${esc(u)} ${u === me ? '<span class="badge">أنت</span>' : ''}</td>
          <td class="actions">${u === me || users.length <= 1 ? '' : `<button class="btn sm ghost danger" data-action="rm-user" data-id="${esc(u)}">حذف</button>`}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">كل المستخدمين بيستقبلوا التنبيهات والتقارير على Telegram، وبيقدروا يتحكموا في الحملات ويدخلوا الداشبورد بأمر /dashboard.</p>
    </section>`;
}

// ==================== السجل ====================
const ACTION_TEXT = {
  pause: (a) => `إيقاف ${bdi(a.adset)}`,
  budget_up: (a) => `رفع ميزانية ${bdi(a.adset)} ${a.pct}% — من ${n2(a.from)} إلى ${n2(a.to)}`,
  budget_down: (a) => `تقليل ميزانية ${bdi(a.adset)} ${Math.abs(a.pct)}% — من ${n2(a.from)} إلى ${n2(a.to)}`,
  product_add: (a) => `إضافة منتج ${bdi(a.product)} — Max ${n2(a.maxCpp)}${a.via_discovery ? ' (من الاكتشاف)' : ''}`,
  product_cpp: (a) => `تعديل حد ${bdi(a.product)} من ${n2(a.from)} إلى ${n2(a.to)}`,
  product_edit: (a) => `تعديل ${bdi(a.product)}${a.renamedFrom ? ` (كان ${bdi(a.renamedFrom)})` : ''}: Max من ${n2(a.from)} إلى ${n2(a.to)}`,
  product_remove: (a) => `حذف منتج ${bdi(a.product)}`,
  alias_add: (a) => `اسم بديل لـ ${bdi(a.product)}: ${bdi(a.alias)}`,
  alias_remove: (a) => `حذف اسم بديل من ${bdi(a.product)}: ${bdi(a.alias)}`,
  setting: (a) => `إعداد ${bdi(a.name)} = ${bdi(a.value)}`,
  accounts: (a) => `تحديث حسابات ${a.platform === 'tiktok' ? 'TikTok' : 'Meta'} (${a.count})`,
  user_remove: (a) => `حذف مستخدم ${bdi(a.user)}`
};
const ALERT_TEXT = { hourly: 'تنبيه تجاوز', scale: 'فرصة Scale' };
const REASON_TEXT = { high_cpp: 'CPP فوق الحد', high_spend_low_purchases: 'إنفاق بدون مبيعات', scale_opportunity: 'CPP تحت الحد بكتير' };

async function viewLogs(main) {
  const { actions, alerts } = await api('/logs');
  const isA = state.logsView === 'actions';
  main.innerHTML = `
    <section>
      <div class="sec-head"><div class="seg"><button aria-pressed="${isA}" data-logs="actions">الإجراءات</button><button aria-pressed="${!isA}" data-logs="alerts">التنبيهات</button></div></div>
      <div class="panel">${isA
        ? (actions.length ? `<ul class="log">${actions.map(a => `<li><span class="when">${esc(fmtWhen(a.at))}</span>
            <span>${(ACTION_TEXT[a.action] || (() => esc(a.action)))(a)}</span>
            <span class="who num">${a.via === 'dashboard' ? 'الداشبورد' : 'Telegram'} — ${esc(a.by)}</span></li>`).join('')}</ul>`
          : '<div class="empty"><p>مفيش إجراءات لسه.</p></div>')
        : (alerts.length ? `<ul class="log">${alerts.map(a => `<li><span class="when">${esc(fmtWhen(a.sent_at))}</span>
            <span>${a.alert_type === 'scale' ? '<span class="badge good">فرصة Scale</span>' : '<span class="badge bad">تجاوز</span>'} ${esc(a.product_name)} — <span class="muted small">${esc(REASON_TEXT[a.reason] || a.reason || '')}</span></span>
            <span class="who num">${esc(a.adset_id)}</span></li>`).join('')}</ul>`
          : '<div class="empty"><p>مفيش تنبيهات لسه.</p></div>')}
      </div>
    </section>`;
}

// ==================== الأحداث ====================
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-tab],[data-action],[data-days],[data-filter],[data-pct],[data-logs]');
  if (!el) return;

  if (el.dataset.tab) {
    state.tab = el.dataset.tab; location.hash = state.tab;
    if ($dlg.open) $dlg.close();
    return renderShell();
  }
  if (el.dataset.days) { state.days = parseInt(el.dataset.days); return renderTab(); }
  if (el.dataset.filter && !e.target.closest('button')) {
    state.productFilter = state.productFilter === el.dataset.filter ? null : el.dataset.filter;
    return renderTab();
  }
  if (el.dataset.pct) { $dlg.querySelector('[data-custom-pct]').value = ''; return setBudgetPct(parseInt(el.dataset.pct)); }
  if (el.dataset.logs) { state.logsView = el.dataset.logs; return renderTab(); }

  const a = el.dataset.action;
  const id = el.dataset.id;
  switch (a) {
    case 'close': return $dlg.close();
    case 'reload': return renderTab();
    case 'logout':
      await api('/logout', { method: 'POST' }).catch(() => {});
      return renderLogin('اتسجل خروجك.');
    case 'clear-filter': state.productFilter = null; return renderTab();
    case 'check': {
      const r = await run(el, () => api('/check', { method: 'POST' }));
      if (r) { toast(`انتهى الفحص: ${r.alerts || 0} تنبيه، ${r.scales || 0} فرصة Scale`); renderTab(); }
      return;
    }
    case 'pause': return pauseDialog(id);
    case 'confirm-pause': {
      const r = await run(el, () => api(`/adsets/${encodeURIComponent(id)}/pause`, { method: 'POST' }));
      if (r) { $dlg.close(); toast('اتوقف — وفريقك اتبلغ على Telegram'); renderTab(); }
      return;
    }
    case 'budget': return budgetDialog(id);
    case 'confirm-budget': {
      const pct = parseInt(el.dataset.pct);
      const r = await run(el, () => api(`/adsets/${encodeURIComponent(id)}/budget`, { method: 'POST', body: { pct } }));
      if (r) { $dlg.close(); toast(`الميزانية بقت ${n2(r.to)} ${state.me.tenant.currency}`); renderTab(); }
      return;
    }
    case 'rm-alias': {
      const tr = el.closest('tr'); el.closest('.chip').remove(); markDirty(tr); return;
    }
    case 'save-product': {
      const tr = el.closest('tr');
      const p = rowProduct(tr);
      const r = await run(el, () => api(`/products/${encodeURIComponent(p.orig.name)}`, { method: 'PUT', body: { name: p.name, maxCpp: p.maxCpp, aliases: p.aliases } }));
      if (r) { toast(`اتحفظ ${p.name}`); renderTab(); }
      return;
    }
    case 'del-product': {
      const p = state.products[parseInt(el.dataset.i)];
      openDialog(`<div class="dlg-head"><h3>حذف ${esc(p.name)}</h3></div>
        <div class="dlg-body"><p>النظام هيوقف مراقبة حملاته وتنبيهاتها. بياناته القديمة هتفضل في التقارير.</p></div>
        <div class="dlg-foot"><button class="btn danger" data-action="confirm-del-product" data-name="${esc(p.name)}">حذف</button><button class="btn ghost" data-action="close">إلغاء</button></div>`);
      return;
    }
    case 'confirm-del-product': {
      const r = await run(el, () => api(`/products/${encodeURIComponent(el.dataset.name)}`, { method: 'DELETE' }));
      if (r) { $dlg.close(); toast('اتحذف'); renderTab(); }
      return;
    }
    case 'run-discovery': {
      const days = parseInt(document.querySelector('[data-dv-days]').value);
      const box = document.getElementById('dv-results');
      box.innerHTML = `<div class="panel pad"><span class="spin"></span> جاري قراءة الحملات وتجميعها في منتجات…</div>`;
      el.disabled = true;
      try {
        const [r, p] = await Promise.all([api('/discovery/run', { method: 'POST', body: { days } }), api('/products')]);
        state.me.productNames = p.products.map(x => x.name);
        state.discovery = r;
      } catch (err) { state.discovery = { error: err.message, days }; }
      el.disabled = false;
      box.innerHTML = discoveryResults(state.discovery);
      return;
    }
    case 'apply-discovery': {
      const items = [...document.querySelectorAll('[data-dv]')].filter(tr => tr.querySelector('[data-dv-on]').checked).map(tr => {
        const act = tr.querySelector('[data-dv-action]').value;
        return {
          index: parseInt(tr.dataset.dv),
          action: act.startsWith('link:') ? 'link' : 'add',
          existing: act.startsWith('link:') ? act.slice(5) : undefined,
          name: tr.querySelector('[data-dv-name]').value,
          maxCpp: tr.querySelector('[data-dv-max]').value
        };
      });
      if (!items.length) return toast('اختار منتج واحد على الأقل', true);
      const r = await run(el, () => api('/discovery/apply', { method: 'POST', body: { items } }));
      if (!r) return;
      const msg = [r.added.length && `${r.added.length} منتج جديد`, r.linked.length && `${r.linked.length} ربط`].filter(Boolean).join(' و ');
      if (msg) toast(`اتعمل: ${msg}`);
      if (r.failed.length) toast(r.failed.join(' | '), true);
      state.discovery = null;
      await refreshMe();
      state.tab = 'products'; location.hash = 'products';
      return renderShell();
    }
    case 'edit-accounts': return editAccounts(el.dataset.platform, el);
    case 'save-accounts': {
      const box = el.closest('[data-acc]');
      const ids = [...box.querySelectorAll('.pick input:checked')].map(i => i.value);
      const r = await run(el, () => api('/accounts', { method: 'PUT', body: { platform: el.dataset.platform, ids } }));
      if (r) { toast(`اتحفظ — ${ids.length} حساب`); await refreshMe(); renderTab(); }
      return;
    }
    case 'invite': {
      const r = await run(el, () => api('/invite', { method: 'POST' }));
      if (!r) return;
      const box = document.querySelector('[data-invite]');
      box.classList.add('pad');
      box.innerHTML = `<p style="margin:0 0 8px">ابعت اللينك ده للميديا باير — بيشتغل مرة واحدة:</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><input class="input num" readonly value="${esc(r.link)}" style="flex:1;min-width:220px" data-invite-link>
        <button class="btn" data-action="copy-invite">نسخ</button></div>`;
      return;
    }
    case 'copy-invite': {
      const v = document.querySelector('[data-invite-link]').value;
      await navigator.clipboard.writeText(v).then(() => toast('اتنسخ'), () => toast('انسخه يدوياً', true));
      return;
    }
    case 'rm-user': {
      openDialog(`<div class="dlg-head"><h3>حذف المستخدم ${esc(id)}</h3></div>
        <div class="dlg-body"><p>هيبطل يستقبل التنبيهات، وجلسته على الداشبورد هتتقفل.</p></div>
        <div class="dlg-foot"><button class="btn danger" data-action="confirm-rm-user" data-id="${esc(id)}">حذف</button><button class="btn ghost" data-action="close">إلغاء</button></div>`);
      return;
    }
    case 'confirm-rm-user': {
      const r = await run(el, () => api(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' }));
      if (r) { $dlg.close(); toast('اتحذف'); renderTab(); }
      return;
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches('[data-custom-pct]')) return setBudgetPct(parseInt(t.value));
  if (t.matches('[data-field]')) return markDirty(t.closest('tr'));
  if (t.matches('[data-acc-search]')) {
    const q = t.value.trim().toLowerCase().replace(/^act_/, '');
    t.closest('[data-acc]').querySelectorAll('.pick').forEach(p => { p.hidden = q && !p.dataset.search.includes(q); });
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-change="tenant"]')) {
    localStorage.setItem('tenant', t.value);
    state.overview = null; state.discovery = null; state.productFilter = null;
    await refreshMe();
    return renderShell();
  }
  if (t.matches('.pick input')) updateAccCount(t.closest('[data-acc]'));
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.matches('[data-add-alias]') && e.key === 'Enter') {
    e.preventDefault();
    const v = t.value.trim();
    if (!v) return;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${esc(v)}<button type="button" data-action="rm-alias" aria-label="حذف">×</button>`;
    t.before(chip);
    t.value = '';
    markDirty(t.closest('tr'));
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  const btn = form.querySelector('[type="submit"]');
  if (form.dataset.form === 'add-product') {
    const fd = new FormData(form);
    const body = { name: fd.get('name'), maxCpp: fd.get('maxCpp'), aliases: String(fd.get('aliases') || '').split(/[,،]/) };
    const r = await run(btn, () => api('/products', { method: 'POST', body }));
    if (r) { toast(`اتضاف ${body.name}`); await refreshMe(); renderTab(); }
  }
  if (form.dataset.form === 'settings') {
    const values = {};
    form.querySelectorAll('input[name]').forEach(i => { if (i.value !== i.dataset.orig) values[i.name] = i.value; });
    if (!Object.keys(values).length) return toast('مفيش تغييرات');
    const r = await run(btn, () => api('/settings', { method: 'PUT', body: { values } }));
    if (r) { toast('اتحفظت الإعدادات'); await refreshMe(); renderTab(); }
  }
});

window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if (tab && tab !== state.tab && TABS.some(([id]) => id === tab)) { state.tab = tab; renderShell(); }
});

// ==================== التشغيل ====================
async function refreshMe() {
  state.me = await api('/me');
  if (state.me.role === 'admin' && state.me.tenant) localStorage.setItem('tenant', state.me.tenant.id);
  return state.me;
}

(async function init() {
  try {
    await refreshMe();
  } catch { return; } // شاشة الدخول اتعرضت
  if (location.search) history.replaceState(null, '', `/${location.hash}`);
  if (state.me.tenant?.ready) { try { await loadOverview(); } catch {} }
  renderShell();
})();
