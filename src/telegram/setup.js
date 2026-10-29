const config = require('../config');
const { send, edit } = require('./messenger');
const state = require('./state');
const metaClient = require('../meta/client');
const ttClient = require('../tiktok/client');
const { mask, encrypt, decrypt } = require('../core/crypto');

// معالج الإعداد /setup — ربط Meta و TikTok واختيار الحسابات من أزرار
// التوكنات بتتمسح من الشات فوراً بعد استلامها وبتتحفظ مشفرة

const CURRENCY_SYMBOLS = { EGP: 'ج.م', SAR: 'ر.س', AED: 'د.إ', KWD: 'د.ك', USD: '$', EUR: '€', QAR: 'ر.ق', JOD: 'د.أ', MAD: 'د.م' };

function menu(tenant) {
  const s = tenant.setupStatus;
  const ok = (b) => (b ? '✅' : '⬜');
  const text = `🧭 إعداد ${tenant.name}\n\n` +
    `${ok(s.meta)} Meta: ${s.meta ? `${tenant.metaAccounts.length} حساب (${mask(tenant.metaToken)})` : 'غير مربوط'}\n` +
    `${ok(s.tiktok)} TikTok: ${s.tiktok ? `${tenant.tiktokAdvertisers.length} حساب` : 'غير مربوط'}\n` +
    `${ok(s.products)} المنتجات: ${tenant.products.length}\n\n` +
    (tenant.isReady ? '🟢 المراقبة شغالة' : 'اربط منصة واحدة على الأقل، وبعدها اكتشف المنتجات 👇');
  const rows = [
    [{ text: `${s.meta ? '🔄 إعادة ربط' : '🔵 ربط'} Meta`, callback_data: 'su:meta' }],
    [{ text: `${s.tiktok ? '🔄 إعادة ربط' : '🎵 ربط'} TikTok`, callback_data: 'su:tiktok' }],
    [{ text: '🔍 اكتشاف المنتجات من الحملات', callback_data: 'su:discover' }]
  ];
  if (!config.tiktok.appId) rows.splice(1, 1);
  return { text, opts: { plain: true, reply_markup: { inline_keyboard: rows } } };
}

async function start(tenant, chatId) {
  const m = menu(tenant);
  return send(tenant, chatId, m.text, m.opts);
}

// ---------- اختيار الحسابات (أزرار ✅/⬜) ----------
function selectionKeyboard(ctxKey, accounts, selected) {
  const rows = accounts.slice(0, 40).map((a, i) => [{
    text: `${selected.includes(a.id) ? '✅' : '⬜'} ${a.name || a.id}${a.active === false ? ' (غير نشط)' : ''}`.slice(0, 60),
    callback_data: `su:tg:${ctxKey}:${i}`
  }]);
  rows.push([{ text: '💾 حفظ', callback_data: `su:save:${ctxKey}` }, { text: '❌ إلغاء', callback_data: 'cancel' }]);
  return { inline_keyboard: rows };
}

async function handleCallback(tenant, q) {
  const chatId = String(q.message.chat.id);
  const msgId = q.message.message_id;
  const [, action, key, idx] = q.data.split(':');

  if (action === 'meta') {
    state.set(tenant, chatId, { type: 'setup_meta_token' });
    return send(tenant, chatId,
      `🔵 ربط Meta\n\n` +
      `1. Business Settings ← Users ← System Users ← Add (Admin)\n` +
      `2. Add Assets ← اختار الحسابات الإعلانية (Manage campaigns)\n` +
      `3. Generate New Token ← صلاحيات: ads_management + ads_read ← Never expire\n\n` +
      `📋 الصق التوكن هنا (هيتمسح من الشات فوراً ويتحفظ مشفّر):`, { plain: true });
  }

  if (action === 'tiktok') {
    state.set(tenant, chatId, { type: 'setup_tiktok_code' });
    return send(tenant, chatId,
      `🎵 ربط TikTok\n\n1. افتح اللينك ده وسجّل دخول بحساب TikTok Ads ووافق:\n${ttClient.authUrl(tenant.id)}\n\n` +
      `2. هيحوّلك لصفحة لينكها فيه auth_code=...\n3. انسخ اللينك كله (أو الكود) والصقه هنا خلال 10 دقايق:`, { plain: true });
  }

  if (action === 'discover') return require('../discovery/discovery').start(tenant, chatId);

  const ctx = tenant.getContext(key);
  if (!ctx) return send(tenant, chatId, '❌ انتهت الجلسة — ابدأ /setup من جديد', { plain: true });

  if (action === 'tg') {
    const acc = ctx.accounts[parseInt(idx)];
    const sel = ctx.selected.includes(acc.id) ? ctx.selected.filter(x => x !== acc.id) : [...ctx.selected, acc.id];
    tenant.db.storeContext(key, { ...ctx, selected: sel, timestamp: Date.now() });
    return tenant.bot.editMessageReplyMarkup(selectionKeyboard(key, ctx.accounts, sel), { chat_id: chatId, message_id: msgId }).catch(() => {});
  }

  if (action === 'save') {
    if (!ctx.selected.length) return send(tenant, chatId, '⚠️ اختار حساب واحد على الأقل', { plain: true });
    tenant.setCredential(ctx.platform === 'meta' ? 'metaToken' : 'tiktokToken', decrypt(ctx.token));
    tenant.setAccounts(ctx.platform, ctx.selected);

    // أول ربط Meta: العملة والتوقيت من الحساب الإعلاني (لو لسه مش متغيرين)
    if (ctx.platform === 'meta') {
      const first = ctx.accounts.find(a => a.id === ctx.selected[0]);
      const custom = tenant.db.load().settings;
      if (first?.currency && !custom.currency) tenant.setSetting('currency', CURRENCY_SYMBOLS[first.currency] || first.currency);
      if (first?.timezone && !custom.timezone) tenant.setSetting('timezone', first.timezone);
    }
    tenant.db.storeContext(key, { ...ctx, token: null, timestamp: Date.now() }); // لا نترك التوكن في السياق
    tenant.log.success(`${ctx.platform} connected: ${ctx.selected.length} accounts`);

    await edit(tenant, chatId, msgId,
      `✅ تم ربط ${ctx.platform === 'meta' ? 'Meta' : 'TikTok'} — ${ctx.selected.length} حساب`, { plain: true });
    return send(tenant, chatId, '🔍 الخطوة الجاية: نستكشف الحملات ونقترح المنتجات وحدودها؟', {
      plain: true,
      reply_markup: { inline_keyboard: [[{ text: '🔍 ابدأ الاكتشاف', callback_data: 'su:discover' }, { text: '🧭 قائمة الإعداد', callback_data: 'su:menu' }]] }
    });
  }

  if (action === 'menu') return start(tenant, chatId);
}

// ---------- استلام التوكن / كود TikTok ----------
async function handleText(tenant, msg, st) {
  const chatId = String(msg.chat.id);
  const input = msg.text.trim();
  // مسح رسالة التوكن من الشات فوراً (أمان)
  tenant.bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  if (st.type === 'setup_meta_token') {
    await send(tenant, chatId, '🔐 استلمت التوكن ومسحته من الشات — جاري التحقق...', { plain: true });
    let accounts;
    try {
      accounts = await metaClient.listAdAccounts(input);
    } catch (err) {
      return send(tenant, chatId, `❌ التوكن مش شغال: ${err.message === 'META_TOKEN_EXPIRED' ? 'منتهي أو غير صالح' : err.message}\n\nجرّب تاني أو اكتب /setup`, { plain: true });
    }
    state.clear(tenant, chatId);
    if (!accounts.length) return send(tenant, chatId, '⚠️ التوكن سليم بس مفيش حسابات إعلانية مضافة للـ System User.\nضيف الحسابات من Add Assets وابعت التوكن تاني /setup', { plain: true });
    const selected = accounts.filter(a => a.active).map(a => a.id);
    const key = tenant.storeContext({ platform: 'meta', token: encrypt(input), accounts, selected });
    return send(tenant, chatId, `🔵 لقيت ${accounts.length} حساب — اختار اللي عايز تراقبه:`,
      { plain: true, reply_markup: selectionKeyboard(key, accounts, selected) });
  }

  if (st.type === 'setup_tiktok_code') {
    const code = ttClient.extractAuthCode(input);
    if (!code) return send(tenant, chatId, '❌ مش لاقي auth_code في اللي بعته — الصق اللينك كامل', { plain: true });
    await send(tenant, chatId, '🔐 جاري التحقق من TikTok...', { plain: true });
    let token, accounts;
    try {
      const r = await ttClient.exchangeAuthCode(code);
      token = r.accessToken;
      try { accounts = await ttClient.listAdvertisers(token); } catch { accounts = []; }
      if (!accounts.length) accounts = r.advertiserIds.map(id => ({ id, name: id }));
    } catch (err) {
      return send(tenant, chatId, `❌ فشل الربط: ${err.message}\n\nالكود صالح لدقايق قليلة — اطلب لينك جديد من /setup`, { plain: true });
    }
    state.clear(tenant, chatId);
    const key = tenant.storeContext({ platform: 'tiktok', token: encrypt(token), accounts, selected: accounts.map(a => a.id) });
    return send(tenant, chatId, `🎵 لقيت ${accounts.length} حساب — اختار اللي عايز تراقبه:`,
      { plain: true, reply_markup: selectionKeyboard(key, accounts, accounts.map(a => a.id)) });
  }
}

module.exports = { start, handleCallback, handleText };
