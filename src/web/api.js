const express = require('express');
const config = require('../config');
const registry = require('../core/registry');
const actions = require('../core/actions');
const { SETTINGS, validate } = require('../core/settings');
const { mask } = require('../core/crypto');
const auth = require('./auth');

const router = express.Router();

// كل الردود JSON — والأخطاء المتوقعة رسالتها عربي مفهومة
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; this.expose = true; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then(out => {
  if (!res.headersSent) res.json(out ?? { ok: true });
}).catch(next);
const need = (req) => { if (!req.tenant) throw new HttpError(404, 'لا يوجد عملاء بعد'); return req.tenant; };
const adminOnly = (req) => { if (req.session.role !== 'admin') throw new HttpError(403, 'للأدمن فقط'); };
const r2 = (n) => Math.round((n || 0) * 100) / 100;

// ==================== من أنا ====================
function tenantSummary(t) {
  return {
    id: t.id, name: t.name, botUsername: t.botUsername, active: t.active,
    currency: t.currency, timezone: t.tz, ready: t.isReady, setup: t.setupStatus,
    products: t.products.length, users: t.users.length,
    lastCycle: parseInt(t.db.getState('last_cycle', '0')) || null
  };
}

router.get('/me', wrap((req) => ({
  role: req.session.role,
  chatId: req.session.chatId,
  tenant: req.tenant ? tenantSummary(req.tenant) : null,
  tenants: req.session.role === 'admin' ? registry.list().map(tenantSummary) : undefined,
  models: { heavy: config.anthropic.models.heavy, light: config.anthropic.models.light }
})));

router.post('/logout', wrap((req) => { auth.destroySession(req.sid); return { ok: true }; }));

// ==================== نظرة عامة (فترة) ====================
router.get('/overview', wrap((req) => {
  const t = need(req);
  const days = Math.min(Math.max(parseInt(req.query.days) || 1, 1), 90);
  const from = t.daysAgo(days - 1), to = t.today();
  const rows = t.db.rows().filter(r => r.date >= from && r.date <= to);
  const maxOf = (name) => t.products.find(p => p.name === name)?.maxCpp;

  const products = {}, adsets = {}, daily = {};
  for (const r of rows) {
    const p = products[r.product_name] ||= { name: r.product_name, spend: 0, purchases: 0, adsets: new Set(),
      meta: { spend: 0, purchases: 0 }, tiktok: { spend: 0, purchases: 0 } };
    p.spend += r.spend || 0; p.purchases += r.purchases || 0; p.adsets.add(r.adset_id);
    const plat = (r.platform || (String(r.adset_id).startsWith('tt_') ? 'tiktok' : 'meta')) === 'tiktok' ? p.tiktok : p.meta;
    plat.spend += r.spend || 0; plat.purchases += r.purchases || 0;

    const a = adsets[r.adset_id] ||= { id: r.adset_id, name: r.adset_name, product: r.product_name,
      platform: r.platform || (String(r.adset_id).startsWith('tt_') ? 'tiktok' : 'meta'),
      campaign: r.campaign_name, spend: 0, purchases: 0, impressions: 0, clicks: 0, lastDate: '', budget: null, createdAt: r.adset_created_at };
    a.spend += r.spend || 0; a.purchases += r.purchases || 0; a.impressions += r.impressions || 0; a.clicks += r.clicks || 0;
    if (r.date >= a.lastDate) { a.lastDate = r.date; a.name = r.adset_name; a.budget = r.daily_budget ?? a.budget; a.frequency = r.frequency; a.hookRate = r.hook_rate; }

    const d = daily[r.date] ||= { date: r.date, spend: 0, purchases: 0 };
    d.spend += r.spend || 0; d.purchases += r.purchases || 0;
  }

  const cpp = (x) => (x.purchases > 0 ? r2(x.spend / x.purchases) : null);
  const productList = Object.values(products).map(p => ({
    name: p.name, maxCpp: maxOf(p.name) ?? null, spend: r2(p.spend), purchases: p.purchases, cpp: cpp(p),
    adsets: p.adsets.size, metaCpp: cpp(p.meta), tiktokCpp: cpp(p.tiktok), metaSpend: r2(p.meta.spend), tiktokSpend: r2(p.tiktok.spend)
  })).sort((a, b) => b.spend - a.spend);

  const time = require('../utils/time');
  const recentActs = {};
  for (const ac of t.db.load().actions || []) {
    if (!ac.adsetId || !['pause', 'budget_up', 'budget_down'].includes(ac.action) || Date.now() - ac.at > 7 * 86400000) continue;
    recentActs[ac.adsetId] = { action: ac.action, pct: ac.pct ?? null, at: ac.at, day: time.dateOf(ac.at, t.tz) };
  }
  const adsetList = Object.values(adsets).map(a => ({
    lastAction: recentActs[a.id] || null,
    ...a, spend: r2(a.spend), cpp: cpp(a), maxCpp: maxOf(a.product) ?? null,
    ctr: a.impressions ? r2((a.clicks / a.impressions) * 100) : null,
    ageDays: a.createdAt ? Math.floor((Date.now() - new Date(a.createdAt)) / 86400000) : null,
    activeToday: a.lastDate === to
  })).sort((a, b) => b.spend - a.spend);

  const total = productList.reduce((acc, p) => ({ spend: acc.spend + p.spend, purchases: acc.purchases + p.purchases }), { spend: 0, purchases: 0 });
  let unmatched = [];
  try { unmatched = JSON.parse(t.db.getState('unmatched', '{}')).list || []; } catch {}

  return {
    range: { from, to, days },
    totals: { spend: r2(total.spend), purchases: total.purchases, cpp: cpp(total) },
    products: productList,
    adsets: adsetList,
    daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({ ...d, spend: r2(d.spend), cpp: cpp(d) })),
    unmatched: unmatched.sort((a, b) => b.spend - a.spend),
    settings: { bufferPct: t.settings.bufferPct, scalePct: t.settings.scalePct },
    lastCycle: parseInt(t.db.getState('last_cycle', '0')) || null,
    nextCycle: Math.max(t.nextCycleAt, Date.now()),
    intervalMinutes: t.settings.intervalMinutes,
    diag: (() => { try { return Object.values(JSON.parse(t.db.getState('last_cycle_diag', '{}')).accounts || {}); } catch { return []; } })(),
    cycleRunning: t.cycleRunning
  };
}));

// ==================== إجراءات الحملات ====================
function adsetCtx(req) {
  const ctx = actions.contextFromAdset(need(req), req.params.id);
  if (!ctx) throw new HttpError(404, 'الـ Ad Set مش موجود في البيانات المحفوظة');
  return ctx;
}

router.post('/adsets/:id/pause', wrap(async (req) => {
  const r = await actions.pause(req.tenant, adsetCtx(req), req.actor);
  return { ok: true, newName: r.newName };
}));

router.get('/adsets/:id/budget', wrap(async (req) => {
  const b = await actions.api.budget(req.tenant, adsetCtx(req));
  return { budget: b.dailyBudget, isCBO: b.isCBO, floor: req.tenant.settings.budgetFloor };
}));

router.post('/adsets/:id/budget', wrap(async (req) => {
  const pct = parseInt(req.body?.pct);
  if (!pct || pct < -90 || pct > 200) throw new HttpError(400, 'النسبة لازم تكون بين -90% و +200%');
  const r = await actions.changeBudget(req.tenant, adsetCtx(req), pct, req.actor);
  if (!r.success) throw new HttpError(400, r.error);
  return { ok: true, from: r.oldBudget, to: r.newBudget };
}));

router.post('/check', wrap(async (req) => {
  const t = need(req);
  if (!t.isReady) throw new HttpError(400, 'الإعداد غير مكتمل');
  if (t.cycleRunning) throw new HttpError(409, 'فيه فحص شغال بالفعل');
  return require('../core/engine').runCycle(t);
}));

// ==================== المنتجات ====================
function cleanAliases(list, selfName) {
  return [...new Set((Array.isArray(list) ? list : []).map(a => String(a).trim()).filter(a => a && a !== selfName))].slice(0, 30);
}

function assertNoClash(t, names, exceptProduct) {
  for (const n of names) {
    const clash = t.products.find(p => p.name !== exceptProduct && (p.name === n || (p.aliases || []).includes(n)));
    if (clash) throw new HttpError(400, `"${n}" مستخدم بالفعل مع منتج ${clash.name}`);
  }
}

router.get('/products', wrap((req) => ({ products: need(req).products })));

router.post('/products', wrap((req) => {
  const t = need(req);
  const name = String(req.body?.name || '').trim();
  const maxCpp = parseFloat(req.body?.maxCpp);
  if (!name || name.length > 60) throw new HttpError(400, 'اسم المنتج مطلوب');
  if (!(maxCpp > 0)) throw new HttpError(400, 'Max CPP لازم يكون رقم أكبر من صفر');
  const aliases = cleanAliases(req.body?.aliases, name);
  assertNoClash(t, [name, ...aliases]);
  t.saveProducts([...t.products, { name, maxCpp, aliases }]);
  t.logAction(req.actor, 'product_add', { product: name, maxCpp });
  return { products: t.products };
}));

router.put('/products/:name', wrap((req) => {
  const t = need(req);
  const cur = t.products.find(p => p.name === req.params.name);
  if (!cur) throw new HttpError(404, 'المنتج مش موجود');
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : cur.name;
  const maxCpp = req.body?.maxCpp !== undefined ? parseFloat(req.body.maxCpp) : cur.maxCpp;
  if (!name) throw new HttpError(400, 'اسم المنتج مطلوب');
  if (!(maxCpp > 0)) throw new HttpError(400, 'Max CPP لازم يكون رقم أكبر من صفر');
  let aliases = req.body?.aliases !== undefined ? cleanAliases(req.body.aliases, name) : (cur.aliases || []);
  // تغيير الاسم: الاسم القديم يفضل كاسم بديل عشان المطابقة ما تتكسرش
  if (name !== cur.name && !aliases.includes(cur.name)) aliases = [...aliases, cur.name];
  assertNoClash(t, [name, ...aliases], cur.name);
  t.saveProducts(t.products.map(p => (p.name === cur.name ? { ...p, name, maxCpp, aliases } : p)));
  t.logAction(req.actor, 'product_edit', { product: name, from: cur.maxCpp, to: maxCpp, renamedFrom: name !== cur.name ? cur.name : undefined });
  return { products: t.products };
}));

router.delete('/products/:name', wrap((req) => {
  const t = need(req);
  if (!t.products.some(p => p.name === req.params.name)) throw new HttpError(404, 'المنتج مش موجود');
  t.saveProducts(t.products.filter(p => p.name !== req.params.name));
  t.logAction(req.actor, 'product_remove', { product: req.params.name });
  return { products: t.products };
}));

// ==================== الإعدادات ====================
router.get('/settings', wrap((req) => {
  const t = need(req);
  const s = t.settings;
  return {
    fields: Object.entries(SETTINGS).map(([name, d]) => ({
      name, label: d.label, unit: d.unit, type: d.type, min: d.min, max: d.max, value: s[d.key]
    }))
  };
}));

router.put('/settings', wrap((req) => {
  const t = need(req);
  const values = req.body?.values || {};
  const validated = [];
  for (const [name, raw] of Object.entries(values)) {
    const r = validate(name, raw);
    if (!r.ok) throw new HttpError(400, r.error);
    validated.push([name, r]);
  }
  for (const [name, r] of validated) {
    if (t.settings[r.def.key] === r.value) continue;
    t.setSetting(r.def.key, r.value);
    t.logAction(req.actor, 'setting', { name, value: r.value });
  }
  return { ok: true };
}));

// ==================== الحسابات ====================
router.get('/accounts', wrap((req) => {
  const t = need(req);
  return {
    meta: { connected: !!t.metaToken, token: mask(t.metaToken), ids: t.metaAccounts },
    tiktok: { connected: !!t.tiktokToken, token: mask(t.tiktokToken), ids: t.tiktokAdvertisers, available: !!config.tiktok.appId },
    names: JSON.parse(t.db.getState('account_names', '{}'))
  };
}));

// كل الحسابات المتاحة للتوكن المحفوظ (للاختيار) — وبنحفظ الأسماء للعرض
router.get('/accounts/available', wrap(async (req) => {
  const t = need(req);
  const platform = req.query.platform === 'tiktok' ? 'tiktok' : 'meta';
  let list;
  if (platform === 'meta') {
    if (!t.metaToken) throw new HttpError(400, 'Meta مش مربوط — اربطه من البوت بـ /setup');
    list = await require('../meta/client').listAdAccounts(t.metaToken);
  } else {
    if (!t.tiktokToken) throw new HttpError(400, 'TikTok مش مربوط — اربطه من البوت بـ /setup');
    list = await require('../tiktok/client').listAdvertisers(t.tiktokToken);
  }
  const selected = platform === 'meta' ? t.metaAccounts : t.tiktokAdvertisers;
  const names = JSON.parse(t.db.getState('account_names', '{}'));
  for (const a of list) names[a.id] = a.name;
  t.db.setState('account_names', JSON.stringify(names));
  return { platform, accounts: list.map(a => ({ ...a, selected: selected.includes(a.id) })) };
}));

router.put('/accounts', wrap((req) => {
  const t = need(req);
  const platform = req.body?.platform === 'tiktok' ? 'tiktok' : 'meta';
  const ids = (req.body?.ids || []).map(String).filter(id => /^\d{3,25}$/.test(id));
  if (platform === 'meta' && !t.metaToken && ids.length) throw new HttpError(400, 'اربط Meta الأول من البوت');
  if (platform === 'tiktok' && !t.tiktokToken && ids.length) throw new HttpError(400, 'اربط TikTok الأول من البوت');
  t.setAccounts(platform, ids);
  t.logAction(req.actor, 'accounts', { platform, count: ids.length });
  return { ok: true, ids };
}));

// ==================== الفريق ====================
router.get('/users', wrap((req) => {
  const t = need(req);
  return { users: t.users, me: req.session.chatId };
}));

router.delete('/users/:id', wrap((req) => {
  const t = need(req);
  const id = String(req.params.id);
  if (req.session.role !== 'admin' && id === req.session.chatId) throw new HttpError(400, 'ما ينفعش تحذف نفسك');
  if (!t.users.includes(id)) throw new HttpError(404, 'المستخدم مش موجود');
  if (t.users.length <= 1) throw new HttpError(400, 'ما ينفعش تحذف آخر مستخدم');
  t.saveUsers(t.users.filter(u => u !== id));
  auth.revokeUser(t.id, id);
  t.logAction(req.actor, 'user_remove', { user: id });
  return { users: t.users };
}));

router.post('/invite', wrap((req) => {
  const t = need(req);
  if (!t.botUsername) throw new HttpError(400, 'بوت العميل مش شغال');
  const code = registry.rotateInvite(t.id);
  return { link: `https://t.me/${t.botUsername}?start=${code}` };
}));

// ==================== الاكتشاف ====================
const discoveryRunning = new Set();

router.post('/discovery/run', wrap(async (req) => {
  const t = need(req);
  if (discoveryRunning.has(t.id)) throw new HttpError(409, 'فيه اكتشاف شغال بالفعل');
  discoveryRunning.add(t.id);
  try {
    const r = await require('../discovery/discovery').analyze(t, req.body?.days);
    t.db.setState('dashboard_discovery', JSON.stringify({ at: Date.now(), groups: r.groups }));
    return { days: r.days, total: r.total, matched: r.matched, unmatchedCount: r.unmatched.length, errors: r.errors, groups: r.groups };
  } catch (err) {
    throw new HttpError(400, err.message);
  } finally { discoveryRunning.delete(t.id); }
}));

// items: [{ index, action: 'add'|'link', name, maxCpp }]
router.post('/discovery/apply', wrap((req) => {
  const t = need(req);
  const disc = require('../discovery/discovery');
  let saved;
  try { saved = JSON.parse(t.db.getState('dashboard_discovery', '{}')); } catch { saved = {}; }
  if (!saved.groups) throw new HttpError(400, 'شغّل الاكتشاف الأول');
  const done = { added: [], linked: [], failed: [] };
  for (const item of req.body?.items || []) {
    const g = saved.groups[item.index];
    if (!g) continue;
    try {
      if (item.action === 'link') {
        const name = disc.linkToExisting(t, { ...g, existing: item.existing || g.existing });
        if (!name) throw new Error('المنتج الأساسي مش موجود');
        done.linked.push(`${g.name} → ${name}`);
        t.logAction(req.actor, 'alias_add', { product: name, alias: g.keys.join('، ') });
      } else if (item.action === 'add') {
        const maxCpp = parseFloat(item.maxCpp);
        if (!(maxCpp > 0)) throw new Error('Max CPP غير صالح');
        const name = String(item.name || g.name).trim();
        const keys = [...new Set([...g.keys, ...(g.campaigns.some(c => c.name.toLowerCase().includes(name.toLowerCase())) ? [name] : [])])];
        if (!keys.length) throw new Error('مفيش كلمة مطابقة — غيّر الاسم لكلمة موجودة في أسماء الحملات');
        const clash = t.products.find(p => p.name !== name && keys.some(k => p.name === k || (p.aliases || []).includes(k)));
        if (clash) throw new Error(`كلمة المطابقة مستخدمة مع ${clash.name}`);
        disc.addProduct(t, { ...g, name, keys }, maxCpp);
        done.added.push(`${name} (${maxCpp})`);
        t.logAction(req.actor, 'product_add', { product: name, maxCpp, via_discovery: true });
      }
    } catch (err) { done.failed.push(`${g.name}: ${err.message}`); }
  }
  return { ...done, products: t.products, ready: t.isReady };
}));

// ==================== متابعة نتيجة القرار ====================
router.get('/outcomes', wrap((req) => {
  const t = need(req);
  const oc = require('../core/outcomes');
  const window = Math.min(Math.max(parseInt(req.query.window) || 3, 2), 7);
  const list = oc.computeOutcomes(t, { window, limit: 200 });
  return { window, list, summary: oc.summarize(list) };
}));

// ==================== رسم الاتجاه لمنتج ====================
router.get('/trend', wrap((req) => {
  const t = need(req);
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 120);
  const from = t.daysAgo(days - 1), to = t.today();
  const names = [...new Set(t.db.rows().map(r => r.product_name))];
  const product = String(req.query.product || '') || t.products[0]?.name || names[0] || null;
  const byDate = {};
  for (let i = days - 1; i >= 0; i--) { const d = t.daysAgo(i); byDate[d] = { date: d, spend: 0, purchases: 0, metaSpend: 0, tiktokSpend: 0 }; }
  for (const r of t.db.rows()) {
    if (r.product_name !== product || r.date < from || r.date > to || !byDate[r.date]) continue;
    const d = byDate[r.date];
    d.spend += r.spend || 0; d.purchases += r.purchases || 0;
    if ((r.platform || (String(r.adset_id).startsWith('tt_') ? 'tiktok' : 'meta')) === 'tiktok') d.tiktokSpend += r.spend || 0; else d.metaSpend += r.spend || 0;
  }
  const time = require('../utils/time');
  const acts = (t.db.load().actions || []).filter(a => a.product === product && ['pause', 'budget_up', 'budget_down', 'product_cpp', 'product_edit'].includes(a.action))
    .map(a => ({ ...a, date: time.dateOf(a.at, t.tz) })).filter(a => a.date >= from);
  return {
    product, products: [...new Set([...t.products.map(p => p.name), ...names])],
    maxCpp: t.products.find(p => p.name === product)?.maxCpp ?? null,
    days: Object.values(byDate).map(d => ({ ...d, spend: r2(d.spend), metaSpend: r2(d.metaSpend), tiktokSpend: r2(d.tiktokSpend), cpp: d.purchases ? r2(d.spend / d.purchases) : null })),
    actions: acts
  };
}));

// ==================== مقارنة فترتين ====================
router.get('/compare', wrap((req) => {
  const t = need(req);
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 45);
  const includeToday = req.query.today === '1';
  const off = includeToday ? 0 : 1;
  const cur = { from: t.daysAgo(off + days - 1), to: t.daysAgo(off) };
  const prev = { from: t.daysAgo(off + 2 * days - 1), to: t.daysAgo(off + days) };
  const agg = {};
  const blank = () => ({ spend: 0, purchases: 0 });
  for (const r of t.db.rows()) {
    const slot = r.date >= cur.from && r.date <= cur.to ? 'cur' : r.date >= prev.from && r.date <= prev.to ? 'prev' : null;
    if (!slot) continue;
    const p = agg[r.product_name] ||= { name: r.product_name, cur: blank(), prev: blank() };
    p[slot].spend += r.spend || 0; p[slot].purchases += r.purchases || 0;
  }
  const fin = (x) => ({ spend: r2(x.spend), purchases: x.purchases, cpp: x.purchases ? r2(x.spend / x.purchases) : null });
  const ch = (a, b) => (a == null || b == null || !a ? null : Math.round(((b - a) / a) * 100));
  const mk = (p) => {
    const c = fin(p.cur), v = fin(p.prev);
    return { name: p.name, maxCpp: t.products.find(x => x.name === p.name)?.maxCpp ?? null, cur: c, prev: v,
      change: { spend: ch(v.spend, c.spend), purchases: ch(v.purchases, c.purchases), cpp: ch(v.cpp, c.cpp) } };
  };
  const products = Object.values(agg).map(mk).sort((a, b) => b.cur.spend - a.cur.spend);
  const tot = Object.values(agg).reduce((a, p) => {
    a.cur.spend += p.cur.spend; a.cur.purchases += p.cur.purchases; a.prev.spend += p.prev.spend; a.prev.purchases += p.prev.purchases; return a;
  }, { name: 'الإجمالي', cur: blank(), prev: blank() });
  return { days, includeToday, current: cur, previous: prev, products, totals: mk(tot) };
}));

// ==================== كاش بسيط للاستعلامات التقيلة من الـ APIs ====================
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return { ...hit.value, cachedAt: hit.at };
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return { ...value, cachedAt: Date.now() };
}

// ==================== خريطة ساعات البيع ====================
router.get('/hourly', wrap(async (req) => {
  const t = need(req);
  if (!t.isReady) throw new HttpError(400, 'الإعداد غير مكتمل');
  const days = [7, 14, 28].includes(parseInt(req.query.days)) ? parseInt(req.query.days) : 14;
  const product = String(req.query.product || '') || null;
  const refresh = req.query.refresh === '1';
  const key = `hourly:${t.id}:${days}:${product || ''}`;
  if (refresh) cache.delete(key);
  return cached(key, 30 * 60000, async () => {
    const from = t.daysAgo(days), to = t.daysAgo(1); // أيام كاملة بس
    const dates = []; for (let i = days; i >= 1; i--) dates.push(t.daysAgo(i));
    const camp = { meta: new Set(), tiktok: new Set() };
    if (product) for (const r of t.db.rows()) {
      if (r.product_name === product && r.campaign_id) camp[(r.platform || (String(r.adset_id).startsWith('tt_') ? 'tiktok' : 'meta'))].add(String(r.campaign_id));
    }
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ spend: 0, purchases: 0 })));
    const errors = [];
    const add = (rows) => { for (const r of rows) { const g = grid[new Date(`${r.date}T00:00:00Z`).getUTCDay()][r.hour]; if (g) { g.spend += r.spend; g.purchases += r.purchases; } } };
    if (t.setupStatus.meta && (!product || camp.meta.size)) {
      for (const acc of t.metaAccounts) {
        try { add(await require('../meta/data').getHourlyRange(t, acc, from, to, product ? [...camp.meta] : null)); }
        catch (err) { errors.push(`Meta ${acc}: ${err.message}`); }
      }
    }
    if (t.setupStatus.tiktok && (!product || camp.tiktok.size)) {
      for (const adv of t.tiktokAdvertisers) {
        try { add(await require('../tiktok/data').getHourlyRange(t, adv, dates, product ? [...camp.tiktok] : null)); }
        catch (err) { errors.push(`TikTok ${adv}: ${err.message}`); }
      }
    }
    for (const row of grid) for (const c of row) c.spend = r2(c.spend);
    return { days, from, to, product, grid, errors, products: t.products.map(p => p.name) };
  });
}));

// ==================== مستوى الإعلان (الكريتيف) ====================
router.get('/adsets/:id/ads', wrap(async (req) => {
  const t = need(req);
  const ctx = adsetCtx(req);
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  const from = t.daysAgo(days - 1), to = t.today();
  const key = `ads:${t.id}:${ctx.adsetId}:${days}`;
  if (req.query.refresh === '1') cache.delete(key);
  return cached(key, 10 * 60000, async () => {
    const ads = ctx.platform === 'tiktok'
      ? await require('../tiktok/data').getAdsOfAdgroup(t, ctx.accountId, String(ctx.adsetId).replace(/^tt_/, ''), from, to)
      : await require('../meta/data').getAdsOfAdset(t, ctx.adsetId, from, to);
    const maxCpp = t.products.find(p => p.name === ctx.productName)?.maxCpp ?? null;
    return {
      adset: ctx.adsetName, product: ctx.productName, platform: ctx.platform, days, from, to, maxCpp,
      ads: ads.map(a => ({ ...a, spend: r2(a.spend), ctr: r2(a.ctr), frequency: r2(a.frequency), cpp: r2(a.cpp),
        hookRate: r2(a.hookRate), holdRate: r2(a.holdRate),
        ageDays: a.createdAt ? Math.floor((Date.now() - new Date(a.createdAt)) / 86400000) : null }))
        .sort((x, y) => y.spend - x.spend)
    };
  });
}));

// ==================== إجراءات جماعية ====================
router.post('/adsets/bulk', wrap(async (req) => {
  const t = need(req);
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))].slice(0, 50);
  const op = req.body?.op;
  const pct = parseInt(req.body?.pct);
  if (!ids.length) throw new HttpError(400, 'اختار Ad Set واحد على الأقل');
  if (!['pause', 'budget'].includes(op)) throw new HttpError(400, 'إجراء غير معروف');
  if (op === 'budget' && (!pct || pct < -90 || pct > 200)) throw new HttpError(400, 'النسبة لازم تكون بين -90% و +200%');
  const ok = [], failed = [];
  for (const id of ids) {
    const ctx = actions.contextFromAdset(t, id);
    if (!ctx) { failed.push({ id, error: 'مش موجود' }); continue; }
    try {
      if (op === 'pause') { await actions.pause(t, ctx, req.actor, { silent: true, log: { bulk: true } }); ok.push({ id, name: ctx.adsetName }); }
      else {
        const r = await actions.changeBudget(t, ctx, pct, req.actor, { silent: true, log: { bulk: true } });
        if (r.success) ok.push({ id, name: r.adsetName, from: r.oldBudget, to: r.newBudget });
        else failed.push({ id, name: ctx.adsetName, error: r.error });
      }
    } catch (err) { failed.push({ id, name: ctx.adsetName, error: err.message }); }
  }
  if (ok.length) {
    const what = op === 'pause' ? '⏸ إيقاف جماعي' : `${pct > 0 ? '🚀 رفع' : '💰 تقليل'} ميزانية جماعي ${pct > 0 ? '+' : ''}${pct}%`;
    const lines = ok.map(o => `• ${o.name}${o.to != null ? ` — من ${Math.round(o.from)} لـ ${Math.round(o.to)}` : ''}`).join('\n');
    await actions.notifyTeam(t, req.actor, `${what} (${ok.length})\n${lines}${failed.length ? `\n⚠️ فشل ${failed.length}` : ''}\n👤 بواسطة: ${actions.actorLabel(req.actor)}`);
  }
  return { ok, failed };
}));

// ==================== القواعد التلقائية ====================
const R = () => require('../core/rules');
router.get('/rules', wrap((req) => {
  const t = need(req);
  const rules = R();
  const fires = {};
  for (const a of t.db.load().alert_log || []) {
    if (!String(a.alert_type).startsWith('rule:')) continue;
    const id = a.alert_type.slice(5);
    const f = fires[id] ||= { count: 0, last: 0 };
    f.count++; f.last = Math.max(f.last, a.sent_at);
  }
  return {
    rules: t.rules.map(r => ({ ...r, conditionText: rules.describeCondition(r), actionText: rules.describeAction(r), fires: fires[r.id] || { count: 0, last: 0 } })),
    conditions: rules.CONDITIONS, actions: rules.ACTIONS, maxAutoUp: rules.MAX_AUTO_UP,
    products: t.products.map(p => p.name)
  };
}));
router.post('/rules', wrap((req) => {
  const t = need(req);
  if (t.rules.length >= 30) throw new HttpError(400, 'أقصى عدد 30 قاعدة');
  const rule = R().validateRule(t, req.body || {});
  t.saveRules([...t.rules, rule]);
  t.logAction(req.actor, 'rule_add', { rule: rule.name, mode: rule.mode });
  return { rule };
}));
router.put('/rules/:id', wrap((req) => {
  const t = need(req);
  const old = t.rules.find(r => r.id === req.params.id);
  if (!old) throw new HttpError(404, 'القاعدة مش موجودة');
  const rule = R().validateRule(t, req.body || {}, old);
  t.saveRules(t.rules.map(r => (r.id === old.id ? rule : r)));
  t.logAction(req.actor, 'rule_edit', { rule: rule.name, enabled: rule.enabled, mode: rule.mode });
  return { rule };
}));
router.delete('/rules/:id', wrap((req) => {
  const t = need(req);
  const old = t.rules.find(r => r.id === req.params.id);
  if (!old) throw new HttpError(404, 'القاعدة مش موجودة');
  t.saveRules(t.rules.filter(r => r.id !== old.id));
  t.logAction(req.actor, 'rule_remove', { rule: old.name });
  return { ok: true };
}));

// ==================== السجل ====================
router.get('/logs', wrap((req) => {
  const t = need(req);
  const alerts = (t.db.load().alert_log || []).slice(-300).reverse();
  return { actions: t.recentActions(300), alerts };
}));

module.exports = { router, HttpError };
