const { send, sendToAll, sendLongToAll } = require('./messenger');
const { formatCppAlert, formatScaleAlert, fmt, truncate } = require('../utils/format');
const time = require('../utils/time');

// ==================== التنبيهات (Markdown + fallback تلقائي) ====================

function ctxFor(tenant, it) {
  return tenant.storeContext({
    platform: it.platform, accountId: it.accountId,
    adsetId: it.adset.id, adsetName: it.adset.name,
    campaignId: it.campaign.id, campaignName: it.campaign.name,
    productName: it.product.name, dailyBudget: it.adset.dailyBudget
  });
}

async function sendCppAlert(tenant, it) {
  const key = ctxFor(tenant, it);
  const label = it.platform === 'tiktok' ? 'Ad Group' : 'Ad Set';
  const keyboard = { inline_keyboard: [[
    { text: `⏸ إيقاف ${label}`, callback_data: `pause:${key}` },
    { text: '💰 تقليل الميزانية', callback_data: `bmenu:${key}` }
  ]] };
  const res = await sendToAll(tenant, formatCppAlert({ tenant, ...it }), { reply_markup: keyboard });
  tenant.log.alert(`CPP alert ${it.product.name} — ${it.adset.name} (${res.filter(r => r.ok).length}/${res.length})`);
}

async function sendScaleAlert(tenant, it) {
  const key = ctxFor(tenant, it);
  const keyboard = { inline_keyboard: [
    [20, 40, 60].map(p => ({ text: `+${p}%`, callback_data: `scale:${key}:${p}` })),
    [...[80, 100].map(p => ({ text: `+${p}%`, callback_data: `scale:${key}:${p}` })),
      { text: '❌ تجاهل', callback_data: 'cancel' }]
  ] };
  await sendToAll(tenant, formatScaleAlert({ tenant, ...it }), { reply_markup: keyboard });
  tenant.log.success(`Scale alert ${it.product.name} — ${it.adset.name}`);
}

// ==================== أوامر العرض (plain text — مضمونة الوصول) ====================

const statusIcon = (cpp, max, buf) => (cpp > max * buf ? '🔴' : cpp > max ? '🟡' : '🟢');

async function sendStatus(tenant, chatId) {
  const s = tenant.setupStatus;
  const cur = tenant.currency;
  const buf = tenant.settings.bufferPct / 100;
  const last = parseInt(tenant.db.getState('last_cycle', '0'));
  let t = `${tenant.isReady ? '🟢 النظام يعمل' : '🟡 الإعداد غير مكتمل — اكتب /setup'}\n`;
  t += `⏰ ${time.dateTimeString(tenant.tz)}\n`;
  if (last) t += `🔄 آخر فحص: من ${Math.round((Date.now() - last) / 60000)} دقيقة\n`;
  if (tenant.isReady) t += `⏭️ الفحص الجاي: ${time.formatTs(Math.max(tenant.nextCycleAt, Date.now()), tenant.tz)} (كل ${tenant.settings.intervalMinutes} دقيقة)\n`;
  const diag = diagLines(tenant);
  if (diag) t += `\n${diag}\n`;
  t += `\n🔵 Meta: ${s.meta ? `${tenant.metaAccounts.length} حساب` : 'غير مربوط'}`;
  t += ` | 🎵 TikTok: ${s.tiktok ? `${tenant.tiktokAdvertisers.length} حساب` : 'غير مربوط'}\n`;
  t += `📦 المنتجات: ${tenant.products.length}\n\n`;

  const rows = tenant.db.getProductSummaryForDate(tenant.today()).sort((a, b) => b.total_spend - a.total_spend);
  if (!rows.length) return send(tenant, chatId, `${t}لا توجد بيانات لليوم حتى الآن`, { plain: true });
  let ts = 0, tp = 0;
  t += `📊 أداء اليوم:\n`;
  for (const r of rows) {
    ts += r.total_spend; tp += r.total_purchases;
    t += `${statusIcon(r.cpp, r.max_cpp, buf)} ${r.product_name}: CPP ${r.cpp.toFixed(0)} | 🛒 ${Math.round(r.total_purchases)} | Spend ${r.total_spend.toFixed(0)}\n`;
  }
  t += `\n💰 الإجمالي: ${fmt.money(ts)} ${cur} | 🛒 ${Math.round(tp)} | CPP ${tp ? (ts / tp).toFixed(1) : '—'}`;
  return send(tenant, chatId, t, { plain: true });
}

// تشخيص آخر دورة: حسابات مفيهاش أي Ad Set بيصرف — عشان العميل يعرف ليه مفيش تنبيهات
function diagLines(tenant) {
  let d;
  try { d = JSON.parse(tenant.db.getState('last_cycle_diag', '{}')); } catch { return ''; }
  const empty = Object.values(d.accounts || {}).filter(a => !a.error && a.matched === 0);
  const failed = Object.values(d.accounts || {}).filter(a => a.error);
  const out = [];
  for (const a of empty) {
    out.push(a.spending === 0
      ? `⚠️ ${a.platform === 'tiktok' ? 'TikTok' : 'Meta'} ${a.id}: مفيش Ad Sets صرفت النهارده (${a.active} نشط)`
      : a.unmatched ? `⚠️ ${a.platform === 'tiktok' ? 'TikTok' : 'Meta'} ${a.id}: ${a.spending} Ad Set بيصرف بس ولا واحد متطابق مع منتج — /unmatched`
        : `⚠️ ${a.platform === 'tiktok' ? 'TikTok' : 'Meta'} ${a.id}: ${a.spending} Ad Set صرفوا النهارده بس حالتهم مش Active دلوقتي`);
  }
  for (const a of failed) out.push(`❌ ${a.platform === 'tiktok' ? 'TikTok' : 'Meta'} ${a.id}: ${a.error}`);
  return out.join('\n');
}

async function sendBudget(tenant, chatId) {
  const cur = tenant.currency;
  const rows = tenant.db.getProductSummaryForDate(tenant.today());
  const total = rows.reduce((a, r) => a + r.total_spend, 0);
  const now = time.nowIn(tenant.tz);
  const dayPct = (now.getHours() * 60 + now.getMinutes()) / 1440;
  let t = `💸 ميزانية اليوم — ${time.timeString(tenant.tz)}\n\n`;
  t += `💰 الإنفاق حتى الآن: ${fmt.money(total)} ${cur}\n`;
  if (dayPct > 0.05) t += `📈 المتوقع بنهاية اليوم: ${fmt.money(total / dayPct)} ${cur}\n`;
  t += `\n📦 حسب المنتج:\n`;
  rows.sort((a, b) => b.total_spend - a.total_spend)
    .forEach(r => { t += `• ${r.product_name}: ${fmt.money(r.total_spend)} ${cur}\n`; });
  return send(tenant, chatId, t, { plain: true });
}

async function sendRanking(tenant, chatId, best = true) {
  const rows = tenant.db.getProductSummaryForDate(tenant.today())
    .filter(r => r.total_purchases > 0 && r.max_cpp > 0)
    .map(r => ({ ...r, ratio: r.cpp / r.max_cpp }))
    .sort((a, b) => (best ? a.ratio - b.ratio : b.ratio - a.ratio))
    .slice(0, 3);
  if (!rows.length) return send(tenant, chatId, '📊 لا توجد مبيعات كافية اليوم حتى الآن.', { plain: true });
  let t = best ? '🏆 أفضل 3 منتجات اليوم\n\n' : '⬇️ أسوأ 3 منتجات اليوم\n\n';
  rows.forEach((r, i) => {
    t += `${['🥇', '🥈', '🥉'][i]} ${r.product_name}\n`;
    t += `   CPP: ${fmt.money(r.cpp)} (${(r.ratio * 100).toFixed(0)}% من Max ${r.max_cpp})\n`;
    t += `   Spend: ${fmt.money(r.total_spend)} | Purchases: ${Math.round(r.total_purchases)}\n\n`;
  });
  return send(tenant, chatId, t.trim(), { plain: true });
}

// /product و /week — أداء المنتج per adset
async function sendProductReport(tenant, chatId, query, days) {
  const product = tenant.findProduct(query);
  if (!product) {
    return send(tenant, chatId,
      `❌ لم أجد منتجاً باسم "${query}"\n\nالمنتجات:\n${tenant.products.map(p => `• ${p.name}`).join('\n')}`, { plain: true });
  }
  const max = product.maxCpp;
  const buf = tenant.settings.bufferPct / 100;
  const rows = tenant.db.getDailyMetricsByProduct(product.name, tenant.daysAgo(days - 1), tenant.today());
  if (!rows.length) return send(tenant, chatId, `لا توجد بيانات لـ ${product.name} خلال آخر ${days} أيام`, { plain: true });

  const S = rows.reduce((a, r) => a + r.spend, 0), P = rows.reduce((a, r) => a + r.purchases, 0);
  let t = `📦 ${product.name} — آخر ${days} أيام | Max CPP: ${max}\n`;
  t += `📊 الإجمالي: Spend ${fmt.money(S)} | 🛒 ${Math.round(P)} | CPP ${statusIcon(P ? S / P : 0, max, buf)} ${P ? fmt.money(S / P) : '—'}\n\n`;

  const byDate = {};
  rows.forEach(r => { (byDate[r.date] ||= []).push(r); });
  for (const date of Object.keys(byDate).sort().reverse()) {
    const d = byDate[date].sort((a, b) => b.spend - a.spend);
    const ds = d.reduce((a, r) => a + r.spend, 0), dp = d.reduce((a, r) => a + r.purchases, 0);
    t += `📅 ${date} ${statusIcon(dp ? ds / dp : 0, max, buf)} Spend ${fmt.money(ds)} | 🛒 ${Math.round(dp)} | CPP ${dp ? fmt.money(ds / dp) : '—'}\n`;
    for (const r of d) {
      if (r.spend < 1) continue;
      const plat = String(r.adset_id).startsWith('tt_') ? '🎵' : '🔵';
      t += `  ${plat}${statusIcon(r.cpp, max, buf)} ${truncate(r.adset_name, 28)}: ${r.purchases ? fmt.money(r.cpp) : '—'} | ${fmt.money(r.spend)} | ${Math.round(r.purchases)}\n`;
    }
    t += '\n';
  }
  const { sendLong } = require('./messenger');
  return sendLong(tenant, chatId, t.trim());
}

module.exports = {
  sendCppAlert, sendScaleAlert, sendToAll, sendLongToAll,
  sendStatus, sendBudget, sendRanking, sendProductReport
};
