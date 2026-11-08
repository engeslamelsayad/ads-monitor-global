const { send, edit, sendToAll } = require('./messenger');
const { fmt, escapeMd, adsetLabel } = require('../utils/format');
const actions = require('../core/actions');
const state = require('./state');

const act = actions.api;
const tg = (chatId) => ({ via: 'telegram', chatId: String(chatId) });

const expired = (tenant, chatId) => send(tenant, chatId, '❌ انتهت صلاحية هذا الطلب (أكثر من 48 ساعة). انتظر تنبيهاً جديداً.', { plain: true });

// ==================== نقطة الدخول ====================

async function handleCallback(tenant, query) {
  const chatId = String(query.message.chat.id);
  const msgId = query.message.message_id;
  const data = query.data || '';
  const [type, key, arg] = data.split(':');

  if (type === 'cancel') {
    state.clear(tenant, chatId);
    return edit(tenant, chatId, msgId, '❌ تم إلغاء العملية.', { plain: true });
  }
  if (type === 'su') return require('./setup').handleCallback(tenant, query);
  if (type === 'dv') return require('../discovery/discovery').handleCallback(tenant, query);
  if (type === 'cfg') return require('./commands').handleConfigCallback(tenant, query);

  const ctx = tenant.getContext(key);
  if (!ctx) return expired(tenant, chatId);
  const label = adsetLabel(ctx.platform);
  const cur = tenant.currency;

  switch (type) {
    // ---------- تأكيد قاعدة تلقائية ----------
    case 'rl': {
      if (ctx.done) return edit(tenant, chatId, msgId, `ℹ️ القاعدة دي اتنفذت قبل كده بواسطة ${ctx.done}`, { plain: true });
      tenant.db.storeContext(key, { ...ctx, done: chatId, timestamp: ctx.timestamp });
      try {
        const text = await require('../core/rules').applyConfirmed(tenant, ctx, chatId);
        return edit(tenant, chatId, msgId, `📐 ${ctx.ruleName}\n\n${text}`, { plain: true });
      } catch (err) {
        tenant.log.error('Rule apply failed', err);
        return edit(tenant, chatId, msgId, `❌ فشل التنفيذ\n\n${err.message}`, { plain: true });
      }
    }

    // ---------- إيقاف ----------
    case 'pause':
      return edit(tenant, chatId, msgId,
        `⏸ *تأكيد إيقاف ${label}*\n\n📑 *${escapeMd(ctx.adsetName)}*\n🗂 ${escapeMd(ctx.campaignName)}\n\nسيتم إضافة "claude edit" للاسم.`,
        { reply_markup: { inline_keyboard: [[
          { text: '✅ تأكيد الإيقاف', callback_data: `cpause:${key}` },
          { text: '❌ إلغاء', callback_data: 'cancel' }]] } });

    case 'cpause':
      try {
        const r = await actions.pause(tenant, ctx, tg(chatId));
        return edit(tenant, chatId, msgId, `✅ تم إيقاف ${label}\n\n📑 ${r.newName}\n🗂 ${ctx.campaignName}`, { plain: true });
      } catch (err) {
        tenant.log.error('Pause failed', err);
        return edit(tenant, chatId, msgId, `❌ فشل الإيقاف\n\n${err.message}`, { plain: true });
      }

    // ---------- تقليل الميزانية ----------
    case 'bmenu': {
      let budget = ctx.dailyBudget;
      try { budget = (await act.budget(tenant, ctx)).dailyBudget; } catch {}
      return edit(tenant, chatId, msgId,
        `💰 *تقليل الميزانية*\n\n📑 ${escapeMd(ctx.adsetName)}\n💵 الحالية: *${fmt.money(budget)} ${cur} / يوم*\n⚠️ الحد الأدنى: ${tenant.settings.budgetFloor}\n\nاختر النسبة:`,
        { reply_markup: { inline_keyboard: [
          [20, 30, 50].map(p => ({ text: `-${p}%`, callback_data: `bpct:${key}:${p}` })),
          [{ text: '✍️ نسبة مخصصة', callback_data: `bcustom:${key}` }],
          [{ text: '❌ إلغاء', callback_data: 'cancel' }]
        ] } });
    }

    case 'bpct':
      return applyReduce(tenant, chatId, msgId, ctx, parseInt(arg));

    case 'bcustom':
      state.set(tenant, chatId, { type: 'custom_budget', key, msgId });
      return send(tenant, chatId, '✍️ اكتب نسبة التقليل (رقم من 1 إلى 90):', { plain: true });

    // ---------- Scale ----------
    case 'scale': {
      const p = parseInt(arg);
      let budget = ctx.dailyBudget;
      try { budget = (await act.budget(tenant, ctx)).dailyBudget; } catch {}
      return edit(tenant, chatId, msgId,
        `🚀 *تأكيد رفع الميزانية*\n\n📑 ${escapeMd(ctx.adsetName)}\n💰 ${fmt.money(budget)} → *${fmt.money(budget * (1 + p / 100))} ${cur}* (+${p}%)`,
        { reply_markup: { inline_keyboard: [[
          { text: `✅ تأكيد +${p}%`, callback_data: `cscale:${key}:${p}` },
          { text: '❌ إلغاء', callback_data: 'cancel' }]] } });
    }

    case 'cscale':
      try {
        const p = parseInt(arg);
        const r = await actions.changeBudget(tenant, ctx, p, tg(chatId));
        if (!r.success) return edit(tenant, chatId, msgId, `❌ تعذّر رفع الميزانية\n\n${r.error}`, { plain: true });
        return edit(tenant, chatId, msgId,
          `✅ تم رفع الميزانية\n\n📑 ${r.adsetName}\n💰 ${fmt.money(r.oldBudget)} → ${fmt.money(r.newBudget)} ${cur} (+${p}%)`, { plain: true });
      } catch (err) {
        tenant.log.error('Scale up failed', err);
        return edit(tenant, chatId, msgId, `❌ خطأ: ${err.message}`, { plain: true });
      }

    // ---------- إيقاف منتج كامل ----------
    case 'pprod': {
      const ids = Object.entries(ctx.adsets || {});
      await edit(tenant, chatId, msgId, `⏳ جاري إيقاف ${ids.length}...`, { plain: true });
      const ok = [], failed = [];
      for (const [, m] of ids) {
        try {
          await act.pause(tenant, { platform: m.platform, accountId: m.account_id, adsetId: m.adset_id });
          tenant.logAction(tg(chatId), 'pause', { adset: m.adset_name, adsetId: m.adset_id, product: ctx.productName, platform: m.platform });
          ok.push(m.adset_name);
        } catch { failed.push(m.adset_name); }
        await new Promise(r => setTimeout(r, 400));
      }
      let t = `✅ إيقاف منتج: ${ctx.productName}\n\n`;
      if (ok.length) t += `تم (${ok.length}):\n${ok.map(n => `• ${n}`).join('\n')}\n`;
      if (failed.length) t += `\n❌ فشل (${failed.length}):\n${failed.map(n => `• ${n}`).join('\n')}`;
      await edit(tenant, chatId, msgId, t, { plain: true });
      return actions.notifyTeam(tenant, tg(chatId), `⏸ تم إيقاف ${ok.length} لمنتج ${ctx.productName}\n👤 بواسطة: ${chatId}`);
    }

    default:
      return null;
  }
}

async function applyReduce(tenant, chatId, msgId, ctx, pct) {
  try {
    const r = await actions.changeBudget(tenant, ctx, -pct, tg(chatId));
    const text = r.success
      ? `✅ تم تقليل الميزانية\n\n📑 ${r.adsetName}\n💰 ${fmt.money(r.oldBudget)} → ${fmt.money(r.newBudget)} ${tenant.currency} (-${pct}%)`
      : `❌ تعذّر تقليل الميزانية\n\n${r.error}`;
    if (msgId) await edit(tenant, chatId, msgId, text, { plain: true });
    else await send(tenant, chatId, text, { plain: true });
  } catch (err) {
    tenant.log.error('Budget reduce failed', err);
    await send(tenant, chatId, `❌ فشلت العملية: ${err.message}`, { plain: true });
  }
}

// إدخال نصي: النسبة المخصصة
async function handleCustomBudget(tenant, chatId, text, st) {
  const pct = parseInt(String(text).trim());
  if (isNaN(pct) || pct < 1 || pct > 90) return send(tenant, chatId, '❌ أدخل رقماً بين 1 و 90.', { plain: true });
  state.clear(tenant, chatId);
  const ctx = tenant.getContext(st.key);
  if (!ctx) return expired(tenant, chatId);
  return applyReduce(tenant, chatId, null, ctx, pct);
}

module.exports = { handleCallback, handleCustomBudget, act };
