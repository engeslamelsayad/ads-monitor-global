const metaActions = require('../meta/actions');
const ttActions = require('../tiktok/actions');

// تنفيذ إجراءات الحملات — مشترك بين أزرار Telegram والداشبورد
// كل إجراء: ينفَّذ → يتسجل في سجل الإجراءات → باقي الفريق يتبلغ على Telegram

const isTT = (c) => c.platform === 'tiktok' || String(c.adsetId).startsWith('tt_');
const rawId = (c) => String(c.adsetId).replace(/^tt_/, '');

const api = {
  pause: (t, c) => (isTT(c) ? ttActions.pauseAdgroup(t, c.accountId, rawId(c)) : metaActions.pauseAdset(t, c.adsetId)),
  reduce: (t, c, p) => (isTT(c) ? ttActions.reduceBudget(t, c.accountId, rawId(c), p) : metaActions.reduceBudget(t, c.adsetId, p)),
  increase: (t, c, p) => (isTT(c) ? ttActions.increaseBudget(t, c.accountId, rawId(c), p) : metaActions.increaseBudget(t, c.adsetId, p)),
  budget: (t, c) => (isTT(c) ? ttActions.getAdgroupBudget(t, c.accountId, rawId(c)) : metaActions.getAdsetBudget(t, c.adsetId))
};

// actor: { via: 'telegram'|'dashboard', chatId }
function actorLabel(actor) {
  if (actor.via === 'rule') return `قاعدة تلقائية "${actor.chatId}"${actor.note ? `\n📐 ${actor.note}` : ''}`;
  return `${actor.chatId}${actor.via === 'dashboard' ? ' (من الداشبورد)' : ''}`;
}

async function notifyTeam(t, actor, text) {
  if (!t.bot) return;
  const { send } = require('../telegram/messenger');
  for (const cid of t.users) {
    if (actor.via === 'telegram' && cid === String(actor.chatId)) continue;
    await send(t, cid, text, { plain: true }).catch(() => {});
  }
}

// يبني سياق الإجراء من آخر بيانات محفوظة للـ Ad Set (للداشبورد و /ask)
function contextFromAdset(t, adsetId) {
  let row = t.db.getAllAdsetMetricsForDate(t.today()).find(r => r.adset_id === adsetId);
  if (!row) row = t.db.getAdsetHistory(adsetId, t.daysAgo(13)).pop();
  if (!row) return null;
  return {
    platform: row.platform || (String(adsetId).startsWith('tt_') ? 'tiktok' : 'meta'),
    accountId: row.account_id, adsetId: row.adset_id, adsetName: row.adset_name,
    campaignId: row.campaign_id, campaignName: row.campaign_name, productName: row.product_name,
    dailyBudget: row.daily_budget
  };
}

// opts.silent: من غير إشعار (الإجراءات الجماعية بتبعت ملخص واحد)
async function pause(t, ctx, actor, opts = {}) {
  const r = await api.pause(t, ctx);
  t.logAction(actor, 'pause', { adset: ctx.adsetName, adsetId: ctx.adsetId, product: ctx.productName, platform: ctx.platform, ...(opts.log || {}) });
  if (!opts.silent) await notifyTeam(t, actor, `⏸ تم إيقاف ${ctx.platform === 'tiktok' ? 'Ad Group' : 'Ad Set'}\n📑 ${r.newName}\n👤 بواسطة: ${actorLabel(actor)}`);
  return r;
}

// pct موجب = رفع، سالب = تقليل
async function changeBudget(t, ctx, pct, actor, opts = {}) {
  const up = pct > 0;
  const r = up ? await api.increase(t, ctx, pct) : await api.reduce(t, ctx, Math.abs(pct));
  if (!r.success) return r;
  t.logAction(actor, up ? 'budget_up' : 'budget_down', {
    adset: r.adsetName, adsetId: ctx.adsetId, product: ctx.productName, platform: ctx.platform,
    pct, from: r.oldBudget, to: r.newBudget, ...(opts.log || {})
  });
  if (!opts.silent) await notifyTeam(t, actor,
    `${up ? '🚀 تم رفع' : '💰 تم تقليل'} ميزانية\n📑 ${r.adsetName}\n${up ? '+' : ''}${pct}% → ${Number(r.newBudget).toFixed(2)} ${t.currency}\n👤 بواسطة: ${actorLabel(actor)}`);
  return r;
}

module.exports = { api, pause, changeBudget, contextFromAdset, notifyTeam, actorLabel };
