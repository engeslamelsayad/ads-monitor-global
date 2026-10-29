// تنسيق الرسائل — Telegram MarkdownV1
// درس مهم: MarkdownV1 لا يدعم escape؛ أي * أو _ أو [ غير مقفول = الرسالة كلها تترفض بصمت
// لذلك: escapeMd يحذف/يستبدل، ورسائل الإدارة كلها تتبعت plain text

const fmt = {
  money: (n) => Number(n || 0).toFixed(2),
  int: (n) => Math.round(n || 0).toLocaleString('en'),
  num: (n, d = 2) => Number(n || 0).toFixed(d),
  pct: (n) => `${Number(n || 0).toFixed(1)}%`
};

function escapeMd(str) {
  if (str == null) return '';
  return String(str).replace(/\*/g, '').replace(/_/g, '-').replace(/`/g, "'")
    .replace(/\[/g, '(').replace(/\]/g, ')');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

const platformTag = (p) => (p === 'tiktok' ? '🎵 TikTok' : '🔵 Meta');
const adsetLabel = (p) => (p === 'tiktok' ? 'Ad Group' : 'Ad Set');

function extrasBlock(m, extras, cur) {
  if (!extras) return '';
  let t = `\n📐 *مؤشرات الاتجاه:*\n`;
  if (extras.rollingCpp > 0) {
    const trend = m.costPerPurchase > extras.rollingCpp * 1.15 ? '📈 أسوأ من المعتاد'
      : m.costPerPurchase < extras.rollingCpp * 0.85 ? '📉 أفضل من المعتاد' : '➡️ مستقر';
    t += `• CPP آخر ${extras.rollingDays} أيام: *${fmt.money(extras.rollingCpp)} ${cur}* ${trend}\n`;
  }
  if (extras.ageDays != null) {
    t += `• ⏳ العمر: ${extras.ageDays} يوم${extras.ageDays >= 21 ? ' ⚠️ قد يحتاج creative جديد' : ''}\n`;
  }
  return t;
}

// تنبيه تجاوز CPP / إنفاق عالي
function formatCppAlert({ tenant, product, campaign, adset, metrics: m, alertInfo, platform, extras }) {
  const cur = tenant.currency;
  const highSpend = alertInfo.reason === 'high_spend_low_purchases';
  const header = highSpend ? '⚠️ *إنفاق مرتفع — مبيعات منخفضة*' : '🚨 *تجاوز CPP*';
  const budgetLine = adset.dailyBudget > 0
    ? `💼 Daily Budget: *${fmt.money(adset.dailyBudget)} ${cur} / يوم*`
    : `💼 Daily Budget: CBO (مستوى الحملة)`;

  let t = `${header} — ${platformTag(platform)}\n\n`;
  t += `📦 *المنتج:* ${escapeMd(product.name)}\n`;
  t += `🗂 *Campaign:* ${escapeMd(truncate(campaign.name, 40))}\n`;
  t += `📑 *${adsetLabel(platform)}:* ${escapeMd(truncate(adset.name, 40))}\n`;
  t += `${budgetLine}\n\n📊 *الأرقام اليوم:*\n`;

  if (highSpend) {
    t += `• 💸 Amount Spent: *${fmt.money(m.spend)} ${cur}* (${((m.spend / product.maxCpp) * 100).toFixed(0)}% من Max CPP)\n`;
    t += `• 🛒 Purchases: *${m.purchases}* فقط\n`;
  } else {
    const diff = ((m.costPerPurchase - product.maxCpp) / product.maxCpp * 100).toFixed(0);
    t += `• 💰 Cost per Purchase: *${fmt.money(m.costPerPurchase)} ${cur}* | Max: ${product.maxCpp} (+${diff}%)\n`;
    t += `• 💸 Amount Spent: *${fmt.money(m.spend)} ${cur}*\n`;
    t += `• 🛒 Purchases: *${m.purchases}*\n`;
  }
  t += `• 📈 Purchase ROAS: ${fmt.num(m.purchaseRoas)}\n`;
  t += `• 👁 Impressions: ${fmt.int(m.impressions)}\n`;
  t += `• 🔁 Frequency: ${fmt.num(m.frequency)}\n`;
  t += `• 🖱 CTR: ${fmt.pct(m.ctr)}\n`;
  t += `• 💵 CPM: ${fmt.money(m.cpm)} ${cur}\n`;
  t += `• 🔗 CPC: ${fmt.money(m.cpc)} ${cur}\n`;
  t += `• 👆 Link Clicks: ${fmt.int(m.clicks)}\n`;
  if (platform !== 'tiktok') {
    t += `• 🌐 LP Views: ${fmt.int(m.lpViews)}\n`;
    t += `• 📊 LP View Rate: ${fmt.pct(m.lpViewRate)}\n`;
    t += `• 🎯 Purchases Rate (LP): ${fmt.pct(m.purchaseRateLP)}\n`;
  }
  t += `• 💎 Conv. Value: ${fmt.money(m.purchaseValue)} ${cur}\n`;
  t += `• 🛍 Adds to Cart: ${fmt.int(m.addToCart)}\n`;
  t += `• 🏷 Cost/ATC: ${fmt.money(m.costPerATC)} ${cur}\n`;
  t += `• ✅ Checkouts: ${fmt.int(m.checkouts)}\n`;
  if (m.threeSPlays > 0 || m.thruPlays > 0) {
    t += `• 🎬 ${platform === 'tiktok' ? '2s' : '3s'} Video Plays: ${fmt.int(m.threeSPlays)}\n`;
    t += `• ▶️ ThruPlays: ${fmt.int(m.thruPlays)}\n`;
    t += `• 🪝 Hook Rate: ${fmt.pct(m.hookRate)}\n`;
    t += `• 🔒 Hold Rate: ${fmt.pct(m.holdRate)}\n`;
    t += `• 📲 CTA Rate: ${fmt.pct(m.ctaRate)}\n`;
  }
  t += extrasBlock(m, extras, cur);
  t += `\n⏰ *${tenant.nowTime()}*`;
  return t;
}

// فرصة Scale
function formatScaleAlert({ tenant, product, campaign, adset, metrics: m, platform, extras }) {
  const cur = tenant.currency;
  const pctOfMax = ((m.costPerPurchase / product.maxCpp) * 100).toFixed(0);
  let t = `🚀 *فرصة Scale — ${platformTag(platform)}*\n\n`;
  t += `📦 *المنتج:* ${escapeMd(product.name)}\n`;
  t += `🗂 *Campaign:* ${escapeMd(truncate(campaign.name, 40))}\n`;
  t += `📑 *${adsetLabel(platform)}:* ${escapeMd(truncate(adset.name, 40))}\n`;
  t += `💼 الميزانية الحالية: *${fmt.money(adset.dailyBudget)} ${cur} / يوم*\n\n`;
  t += `📊 *الأداء:*\n`;
  t += `• 💰 CPP: *${fmt.money(m.costPerPurchase)} ${cur}* | Max: ${product.maxCpp} (${pctOfMax}% من الحد ✅)\n`;
  t += `• 💸 Spend: ${fmt.money(m.spend)} ${cur}\n`;
  t += `• 🛒 Purchases: ${m.purchases}\n`;
  t += `• 📈 ROAS: ${fmt.num(m.purchaseRoas)}\n`;
  t += `• 💵 توفير عن الحد: ${fmt.money(product.maxCpp - m.costPerPurchase)} ${cur} لكل مبيعة\n`;
  t += extrasBlock(m, extras, cur);
  t += `\n👆 *رفع الميزانية بنسبة:*`;
  return t;
}

module.exports = { fmt, escapeMd, truncate, platformTag, adsetLabel, formatCppAlert, formatScaleAlert };
