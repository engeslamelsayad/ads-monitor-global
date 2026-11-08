const time = require('../utils/time');

// متابعة نتيجة القرار: أداء الـ Ad Set (أو المنتج للإيقاف) قبل القرار وبعده
// قبل = الـ N يوم اللي قبل يوم القرار | بعد = الـ N يوم اللي بعده (يوم القرار نفسه والنهارده مستبعدين لأنهم ناقصين)

const TYPES = ['pause', 'budget_up', 'budget_down'];
const MIN_AFTER_DAYS = 2;
const LOOKBACK_DAYS = 60;

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function sumRows(rows, days) {
  const spend = rows.reduce((a, r) => a + (r.spend || 0), 0);
  const purchases = rows.reduce((a, r) => a + (r.purchases || 0), 0);
  const d = Math.max(days, 1);
  return {
    days, spend: r2(spend), purchases,
    spendPerDay: r2(spend / d), purchasesPerDay: r2(purchases / d),
    cpp: purchases > 0 ? r2(spend / purchases) : null
  };
}

const pctChange = (a, b) => (a == null || b == null || a === 0 ? null : Math.round(((b - a) / a) * 100));

// الحكم على القرار — بيرجع { verdict: success|mixed|fail|neutral, reason }
function judge(type, before, after, maxCpp, extra = {}) {
  if (type === 'pause') {
    const p = extra.productStats;
    if (!p || p.before.cpp == null || p.after.cpp == null) return { verdict: 'neutral', reason: 'مفيش مبيعات كفاية للمقارنة' };
    if (p.after.cpp <= p.before.cpp) return { verdict: 'success', reason: 'CPP المنتج اتحسن بعد الإيقاف' };
    if (p.after.purchasesPerDay < p.before.purchasesPerDay * 0.7) return { verdict: 'fail', reason: 'مبيعات المنتج قلت والـ CPP ما اتحسنش' };
    return { verdict: 'neutral', reason: 'CPP المنتج ما اتحسنش' };
  }
  if (!after.days || after.spend === 0) return { verdict: 'neutral', reason: 'الـ Ad Set وقف يصرف بعدها' };
  const bc = before.cpp, ac = after.cpp;

  if (type === 'budget_up') {
    const moreSales = after.purchasesPerDay > before.purchasesPerDay;
    if (!moreSales) return { verdict: 'fail', reason: 'الصرف زاد والمبيعات ما زادتش' };
    if (ac == null) return { verdict: 'fail', reason: 'مفيش مبيعات بعد الرفع' };
    if (bc == null || ac <= bc * 1.10) return { verdict: 'success', reason: 'مبيعات أكتر بنفس التكلفة تقريباً' };
    if (maxCpp && ac <= maxCpp) return { verdict: 'mixed', reason: 'مبيعات أكتر بس التكلفة زادت (لسه تحت الحد)' };
    return { verdict: 'fail', reason: 'التكلفة عدّت الحد بعد الرفع' };
  }

  // budget_down
  if (ac == null) return { verdict: 'neutral', reason: 'مفيش مبيعات بعد التقليل' };
  if (bc == null) return { verdict: maxCpp && ac <= maxCpp ? 'success' : 'neutral', reason: 'بقى فيه مبيعات بعد التقليل' };
  if (ac < bc) return { verdict: 'success', reason: maxCpp && bc > maxCpp && ac <= maxCpp ? 'رجع تحت الحد' : 'التكلفة اتحسنت' };
  if (ac > bc * 1.05) return { verdict: 'fail', reason: 'التكلفة زادت رغم التقليل' };
  return { verdict: 'neutral', reason: 'التكلفة زي ما هي' };
}

function computeOutcomes(t, { window = 3, limit = 100 } = {}) {
  const tz = t.tz;
  const today = t.today();
  const since = Date.now() - LOOKBACK_DAYS * 86400000;
  const acts = (t.db.load().actions || []).filter(a => TYPES.includes(a.action) && a.adsetId && a.at >= since);
  if (!acts.length) return [];

  // فهرسة الصفوف مرة واحدة
  const byAdset = {}, byProduct = {};
  for (const r of t.db.rows()) {
    (byAdset[r.adset_id] ||= []).push(r);
    (byProduct[r.product_name] ||= []).push(r);
  }
  const inRange = (rows, from, to) => (rows || []).filter(r => r.date >= from && r.date <= to);

  const out = [];
  for (const a of acts.slice(-limit).reverse()) {
    const day = time.dateOf(a.at, tz);
    const bFrom = time.shiftDate(day, -window), bTo = time.shiftDate(day, -1);
    const aFrom = time.shiftDate(day, 1);
    const lastComplete = time.shiftDate(today, -1);
    const aTo = [time.shiftDate(day, window), lastComplete].sort()[0];
    const afterDays = aTo >= aFrom ? Math.round((Date.parse(aTo) - Date.parse(aFrom)) / 86400000) + 1 : 0;
    const readyOn = time.shiftDate(day, MIN_AFTER_DAYS + 1); // أول يوم النتيجة تبقى متاحة فيه
    const finalOn = time.shiftDate(day, window + 1);

    const rows = byAdset[a.adsetId] || [];
    const bRows = inRange(rows, bFrom, bTo);
    const product = a.product || rows[0]?.product_name;
    const maxCpp = t.products.find(p => p.name === product)?.maxCpp ?? null;

    const base = {
      id: `${a.at}:${a.adsetId}`, at: a.at, day, action: a.action, via: a.via, by: a.by,
      adsetId: a.adsetId, adset: a.adset || rows[rows.length - 1]?.adset_name || a.adsetId,
      product, platform: a.platform || (String(a.adsetId).startsWith('tt_') ? 'tiktok' : 'meta'),
      pct: a.pct ?? null, from: a.from ?? null, to: a.to ?? null, maxCpp, window,
      before: sumRows(bRows, bRows.length), readyOn, finalOn
    };

    if (afterDays < MIN_AFTER_DAYS) { out.push({ ...base, status: 'pending', after: null, afterDays }); continue; }

    const aRows = inRange(rows, aFrom, aTo);
    // بعد القرار: نقسم على الأيام التقويمية — يوم من غير صرف = صفر (ده التوفير في حالة الإيقاف)
    const after = sumRows(aRows, a.action === 'pause' ? afterDays : (aRows.length || afterDays));
    const extra = {};
    if (a.action === 'pause' && product) {
      const pr = byProduct[product] || [];
      const pb = inRange(pr, bFrom, bTo), pa = inRange(pr, aFrom, aTo);
      const bDays = new Set(pb.map(r => r.date)).size;
      extra.productStats = { before: sumRows(pb, bDays), after: sumRows(pa, afterDays) };
      extra.savingPerDay = base.before.spendPerDay;
    }
    const j = judge(a.action, base.before, after, maxCpp, extra);
    out.push({
      ...base, ...extra, status: afterDays >= window ? 'final' : 'partial', after, afterDays,
      verdict: j.verdict, reason: j.reason,
      change: { cpp: pctChange(base.before.cpp, after.cpp), purchasesPerDay: pctChange(base.before.purchasesPerDay, after.purchasesPerDay), spendPerDay: pctChange(base.before.spendPerDay, after.spendPerDay) }
    });
  }
  return out;
}

// ملخص: نسبة النجاح لكل نوع قرار + توفير الإيقافات
function summarize(list) {
  const s = {};
  for (const type of TYPES) {
    const done = list.filter(o => o.action === type && o.verdict);
    s[type] = {
      total: list.filter(o => o.action === type).length, judged: done.length,
      success: done.filter(o => o.verdict === 'success').length,
      mixed: done.filter(o => o.verdict === 'mixed').length,
      fail: done.filter(o => o.verdict === 'fail').length
    };
  }
  s.savingPerDay = r2(list.filter(o => o.action === 'pause' && o.savingPerDay).reduce((a, o) => a + o.savingPerDay, 0));
  s.pending = list.filter(o => o.status === 'pending').length;
  return s;
}

// ---------- نص Telegram ----------
const ICON = { success: '✅', mixed: '🟡', fail: '❌', neutral: '⚪' };
const fmtN = (v) => (v == null ? '—' : Number(v).toLocaleString('en', { maximumFractionDigits: v >= 100 ? 0 : 1 }));

function describe(o, cur = '') {
  const what = o.action === 'pause' ? `إيقاف ${o.adset}`
    : `${o.action === 'budget_up' ? 'رفع' : 'تقليل'} ميزانية ${o.adset} ${Math.abs(o.pct || 0)}%`;
  let t = `${ICON[o.verdict] || '⏳'} ${what}\n   ${o.product || ''} — ${o.day}\n`;
  if (o.action === 'pause' && o.productStats) {
    const p = o.productStats;
    t += `   CPP المنتج: من ${fmtN(p.before?.cpp)} لـ ${fmtN(p.after?.cpp)}\n   مبيعات المنتج/يوم: من ${fmtN(p.before?.purchasesPerDay)} لـ ${fmtN(p.after?.purchasesPerDay)}\n`;
    if (o.savingPerDay) t += `   وفّر ~${fmtN(o.savingPerDay)} ${cur} يومياً\n`;
  } else if (o.after) {
    t += `   CPP: من ${fmtN(o.before.cpp)} لـ ${fmtN(o.after.cpp)}\n   مبيعات/يوم: من ${fmtN(o.before.purchasesPerDay)} لـ ${fmtN(o.after.purchasesPerDay)}\n   صرف/يوم: من ${fmtN(o.before.spendPerDay)} لـ ${fmtN(o.after.spendPerDay)}\n`;
  }
  if (o.reason) t += `   ${o.reason}\n`;
  return t;
}

// بيتنادي من الـ daily pipeline: يبلّغ الفريق بالقرارات اللي نتيجتها النهائية جهزت (مرة واحدة لكل قرار)
function collectNewFinals(t) {
  let notified = [];
  try { notified = JSON.parse(t.db.getState('outcomes_notified', '[]')); } catch {}
  const seen = new Set(notified);
  const fresh = computeOutcomes(t).filter(o => o.status === 'final' && !seen.has(o.id) && Date.now() - o.at < 14 * 86400000);
  if (!fresh.length) return [];
  const all = [...notified, ...fresh.map(o => o.id)].slice(-500);
  t.db.setState('outcomes_notified', JSON.stringify(all));
  return fresh;
}

module.exports = { computeOutcomes, summarize, describe, collectNewFinals, judge, TYPES };
