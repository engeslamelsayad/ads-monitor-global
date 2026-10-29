const { complete } = require('./client');
const metaData = require('../meta/data');
const { getActionValue, parseInsights } = require('../utils/metrics');

// التقارير الذكية — اليومي (Haiku) / 3 أيام (Haiku) / تحليل عميق (Sonnet)

const r1 = (n) => Math.round((n || 0) * 10) / 10;
const pctChange = (a, b) => (b > 0 ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(0)}%` : 'n/a');

function productLine(p, maxCpp) {
  const meta = p.meta.purchases ? r1(p.meta.spend / p.meta.purchases) : (p.meta.spend ? 'لا مبيعات' : '—');
  const tt = p.tiktok.purchases ? r1(p.tiktok.spend / p.tiktok.purchases) : (p.tiktok.spend ? 'لا مبيعات' : '—');
  return `Spend=${r1(p.total_spend)} | Purchases=${p.total_purchases} | CPP=${r1(p.cpp)} | Max=${maxCpp} | Meta CPP=${meta} (spend ${r1(p.meta.spend)}) | TikTok CPP=${tt} (spend ${r1(p.tiktok.spend)})`;
}

// ==================== التقرير اليومي ====================
async function daily(t) {
  const today = t.today();
  const cur = t.currency;
  const map = (arr) => Object.fromEntries(arr.map(p => [p.product_name, p]));
  const T = t.db.getProductSummaryForDate(today);
  const Y = map(t.db.getProductSummaryForDate(t.daysAgo(1)));
  const W = map(t.db.getProductSummaryForDate(t.daysAgo(7)));
  if (!T.length) return 'لا توجد بيانات إنفاق اليوم.';

  const lines = T.sort((a, b) => b.total_spend - a.total_spend).map(p => {
    const max = t.products.find(x => x.name === p.product_name)?.maxCpp || p.max_cpp;
    const y = Y[p.product_name], w = W[p.product_name];
    return `${p.product_name}: ${productLine(p, max)}\n  أمس: CPP=${y ? r1(y.cpp) : '—'} (${y ? pctChange(p.cpp, y.cpp) : 'n/a'}) | نفس اليوم الأسبوع الماضي: CPP=${w ? r1(w.cpp) : '—'} (${w ? pctChange(p.cpp, w.cpp) : 'n/a'})`;
  }).join('\n');

  // أفضل وأسوأ Ad Sets اليوم
  const rows = t.db.getAllAdsetMetricsForDate(today).filter(r => r.spend > 0);
  const rated = rows.filter(r => r.purchases >= 2).map(r => ({ ...r, ratio: r.cpp / (r.max_cpp || 1) }));
  const adsetLine = (r) => `${r.product_name} | ${r.platform} | ${r.adset_name} | spend ${r1(r.spend)} | purch ${r.purchases} | CPP ${r1(r.cpp)} / max ${r.max_cpp}`;
  const best = [...rated].sort((a, b) => a.ratio - b.ratio).slice(0, 5).map(adsetLine).join('\n') || '—';
  const worst = [...rated].sort((a, b) => b.ratio - a.ratio).slice(0, 5).map(adsetLine).join('\n') || '—';
  const burning = rows.filter(r => r.purchases === 0 && r.spend > (r.max_cpp || 0)).map(adsetLine).join('\n') || '—';

  // توزيع المشتريات بالساعة (Meta)
  const hourly = {};
  for (const acc of t.metaAccounts) {
    try {
      for (const h of await metaData.getHourlyToday(t, acc)) {
        const hour = (h.hourly_stats_aggregated_by_advertiser_time_zone || '').slice(0, 2);
        if (hour) hourly[hour] = (hourly[hour] || 0) + getActionValue(h.actions, 'purchase');
      }
    } catch { /* اختياري */ }
  }
  const hTotal = Object.values(hourly).reduce((a, b) => a + b, 0);
  const hourlyText = hTotal
    ? Object.entries(hourly).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([h, v]) => `${h}:00 → ${v} (${((v / hTotal) * 100).toFixed(0)}%)`).join('\n')
    : 'غير متاح';

  // إعلانات عمرها 21+ يوم
  const aged = rows.filter(r => r.adset_created_at)
    .map(r => ({ ...r, age: Math.floor((Date.now() - new Date(r.adset_created_at)) / 86400000) }))
    .filter(r => r.age >= 21).sort((a, b) => b.age - a.age).slice(0, 10)
    .map(r => `${r.adset_name} (${r.product_name}): ${r.age} يوم | CPP ${r1(r.cpp)}`).join('\n') || 'لا يوجد';

  return complete({
    model: 'light',
    maxTokens: 3000,
    system: `أنت ميديا باير خبير في السوق المصري (COD e-commerce) بتكتب تقرير نهاية اليوم لفريق الإعلانات. العملة: ${cur}.`,
    prompt: `بيانات اليوم ${today}:

المنتجات (اليوم مقابل أمس والأسبوع الماضي، Meta مقابل TikTok):
${lines}

أفضل Ad Sets (CPP مقارنة بالحد):
${best}

أسوأ Ad Sets:
${worst}

Ad Sets بتصرف من غير مبيعات (فوق Max CPP):
${burning}

توزيع المشتريات بالساعة (Meta):
${hourlyText}

إعلانات عمرها 21+ يوم (خطر Creative Fatigue):
${aged}

اكتب التقرير بالأقسام دي:
1. 📊 ملخص اليوم (إجمالي الإنفاق والمبيعات وCPP ومقارنة بأمس)
2. 🟢 المنتجات الكويسة و🔴 اللي محتاجة تدخل — مع السبب من الأرقام
3. ⚖️ Meta مقابل TikTok — فين الأداء أحسن لكل منتج يشتغل على المنصتين
4. ⏰ ساعات الذروة وتوصية scheduling
5. 🎨 إعلانات محتاجة creative جديد
6. ✅ 3 إجراءات محددة لبكرة (اسم الـ Ad Set + الإجراء + النسبة)`
  });
}

// ==================== تقرير الـ 3 أيام ====================
async function triDay(t) {
  const days = [2, 1, 0].map(n => t.daysAgo(n));
  const by = {};
  for (const d of days) {
    for (const p of t.db.getProductSummaryForDate(d)) {
      const x = by[p.product_name] ||= { spend: 0, purchases: 0, days: [], meta: { s: 0, p: 0 }, tt: { s: 0, p: 0 } };
      x.spend += p.total_spend; x.purchases += p.total_purchases;
      x.meta.s += p.meta.spend; x.meta.p += p.meta.purchases;
      x.tt.s += p.tiktok.spend; x.tt.p += p.tiktok.purchases;
      x.days.push(`${d.slice(5)}: CPP ${r1(p.cpp)} / spend ${r1(p.total_spend)}`);
    }
  }
  if (!Object.keys(by).length) return 'لا توجد بيانات كافية لآخر 3 أيام.';
  const lines = Object.entries(by).sort((a, b) => b[1].spend - a[1].spend).map(([name, x]) => {
    const max = t.products.find(p => p.name === name)?.maxCpp || '?';
    return `${name} (Max ${max}): spend ${r1(x.spend)} | purchases ${x.purchases} | CPP ${x.purchases ? r1(x.spend / x.purchases) : '—'} | Meta CPP ${x.meta.p ? r1(x.meta.s / x.meta.p) : '—'} | TikTok CPP ${x.tt.p ? r1(x.tt.s / x.tt.p) : '—'}\n  الاتجاه: ${x.days.join(' → ')}`;
  }).join('\n');

  return complete({
    model: 'light',
    maxTokens: 3000,
    system: `أنت مدير ميديا باينج بتكتب مراجعة استراتيجية كل 3 أيام لمدير مشغول. العملة: ${t.currency}.`,
    prompt: `أداء آخر 3 أيام (${days[0]} → ${days[2]}):

${lines}

اكتب:
1. 🎯 الصورة العامة في 3 سطور
2. 🚀 فرص Scale (منتجات CPP ثابت تحت الحد) — بنسبة زيادة مقترحة
3. 🔧 منتجات محتاجة Optimization — والسبب المرجح
4. 💰 توزيع الميزانية المقترح بين المنتجات والمنصتين للـ 3 أيام الجاية
5. ⚠️ مخاطر تراقبها`
  });
}

// ==================== التحليل العميق (يومين فوق الحد) ====================
async function deepAnalysis(t, productName) {
  const product = t.products.find(p => p.name === productName);
  const rows = t.db.getDailyMetricsByProduct(productName, t.daysAgo(13), t.today());

  // ملخص يومي per adset لآخر 14 يوم
  const perAdset = {};
  for (const r of rows) {
    (perAdset[r.adset_id] ||= { name: r.adset_name, platform: r.platform, account: r.account_id, campaign: r.campaign_id, days: [] })
      .days.push(`${r.date.slice(5)}: sp ${r1(r.spend)} pu ${r.purchases} cpp ${r1(r.cpp)} ctr ${r1(r.ctr)} freq ${r1(r.frequency)} hook ${r1(r.hook_rate)} hold ${r1(r.hold_rate)}`);
  }
  const adsetText = Object.values(perAdset).slice(0, 15)
    .map(a => `[${a.platform}] ${a.name}\n  ${a.days.sort().join('\n  ')}`).join('\n') || '—';

  // تاريخ أسبوعي 3 شهور + نصوص الإعلانات (Meta)
  let weekly = '—', copyText = '—', landing = '—';
  const metaCampaigns = [...new Set(Object.values(perAdset).filter(a => a.platform === 'meta').map(a => `${a.account}|${a.campaign}`))];
  if (metaCampaigns.length && t.metaToken) {
    const [acc] = metaCampaigns[0].split('|');
    const ids = metaCampaigns.filter(x => x.startsWith(acc)).map(x => x.split('|')[1]);
    try {
      const hist = await metaData.getHistoricalInsights(t, acc, ids, t.daysAgo(90), t.today());
      const wk = {};
      for (const h of hist) {
        const m = parseInsights(h);
        const w = wk[h.date_start] ||= { s: 0, p: 0, i: 0, c: 0, v: 0 };
        w.s += m.spend; w.p += m.purchases; w.i += m.impressions; w.c += m.clicks; w.v += m.threeSPlays;
      }
      weekly = Object.entries(wk).sort().map(([d, w]) =>
        `${d}: spend ${r1(w.s)} | purch ${w.p} | CPP ${w.p ? r1(w.s / w.p) : '—'} | CTR ${w.i ? r1((w.c / w.i) * 100) : 0}% | Hook ${w.i ? r1((w.v / w.i) * 100) : 0}%`).join('\n');
    } catch (err) { t.log.warn(`Weekly history failed: ${err.message}`); }
    try {
      const ac = await metaData.getAdCopyAndLanding(t, ids[0]);
      copyText = ac.copies.map((c, i) => `${i + 1}. ${c.title}\n${c.body.slice(0, 500)}\nCTA: ${c.cta}`).join('\n\n') || '—';
      landing = ac.landing || '—';
    } catch {}
  }

  return complete({
    model: 'heavy',
    maxTokens: 4000,
    system: `أنت ميديا باير senior متخصص في منتجات الصحة والتجميل بنظام COD في السوق المصري. بتشخص سبب ارتفاع CPP وبتدي خطة علاج عملية. العملة: ${t.currency}.`,
    prompt: `المنتج "${productName}" (Max CPP ${product?.maxCpp}) فوق الحد يومين متتاليين.

أداء يومي per Ad Set (آخر 14 يوم):
${adsetText}

الاتجاه الأسبوعي (آخر 3 شهور — Meta):
${weekly}

نصوص الإعلانات الحالية:
${copyText}

Landing Page: ${landing}

اكتب تشخيص منظم:
1. 🩺 التشخيص الرئيسي — السبب الأرجح بالأرقام (Creative Fatigue؟ Audience Fatigue/Frequency؟ مشكلة Landing؟ تشبع سوق؟)
2. 🎬 قراءة مقاييس الفيديو (Hook/Hold/CTR) واتجاهها
3. ✍️ ملاحظات على الـ Ad Copy وزاوية بديلة مقترحة
4. 📋 خطة علاج بالأولوية (اليوم / خلال 3 أيام / الأسبوع) — إجراءات محددة على Ad Sets بالاسم
5. 🚦 متى نوقف المنتج لو الخطة ما نجحتش`
  });
}

module.exports = { daily, triDay, deepAnalysis };
