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

// ---------- اختيار الحسابات: صفحات + بحث (يدعم مئات الحسابات) ----------
const PAGE_SIZE = 8;

function normalize(s) { return String(s || '').toLowerCase().replace(/^act_/, '').trim(); }

// الحسابات اللي تظهر حسب البحث أو فلتر "المختار فقط" — بترجع أرقامها في القائمة الأصلية
function visibleIndices(ctx) {
  const q = normalize(ctx.filter);
  return ctx.accounts.map((a, i) => i).filter(i => {
    const a = ctx.accounts[i];
    if (ctx.onlySelected && !ctx.selected.includes(a.id)) return false;
    return !q || normalize(a.name).includes(q) || String(a.id).includes(q);
  });
}

function pickerView(ctxKey, ctx) {
  const idxs = visibleIndices(ctx);
  const pages = Math.max(1, Math.ceil(idxs.length / PAGE_SIZE));
  const page = Math.min(Math.max(ctx.page || 0, 0), pages - 1);
  const slice = idxs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const plat = ctx.platform === 'meta' ? '🔵 Meta' : '🎵 TikTok';

  let text = `${plat} — ${ctx.accounts.length} حساب متاح\n`;
  text += `✅ مختار: ${ctx.selected.length}\n`;
  if (ctx.filter) text += `🔍 بحث: "${ctx.filter}" ← ${idxs.length} نتيجة\n`;
  if (ctx.onlySelected) text += `📋 بيعرض المختار بس\n`;
  text += idxs.length ? `\nاضغط على الحساب لاختياره (صفحة ${page + 1}/${pages}):` : '\n⚠️ مفيش نتايج — جرّب كلمة تانية أو رقم الحساب';

  const rows = slice.map(i => {
    const a = ctx.accounts[i];
    const label = `${ctx.selected.includes(a.id) ? '✅' : '⬜'} ${a.name || a.id}${a.active === false ? ' (غير نشط)' : ''}`;
    return [{ text: label.slice(0, 58), callback_data: `su:tg:${ctxKey}:${i}` }];
  });
  if (pages > 1) {
    rows.push([
      { text: page > 0 ? '◀️ السابق' : '·', callback_data: page > 0 ? `su:pg:${ctxKey}:${page - 1}` : 'su:noop' },
      { text: `${page + 1}/${pages}`, callback_data: 'su:noop' },
      { text: page < pages - 1 ? 'التالي ▶️' : '·', callback_data: page < pages - 1 ? `su:pg:${ctxKey}:${page + 1}` : 'su:noop' }
    ]);
  }
  const tools = [{ text: '🔍 بحث بالاسم أو الرقم', callback_data: `su:find:${ctxKey}` }];
  if (ctx.filter || ctx.onlySelected) tools.push({ text: '✖️ عرض الكل', callback_data: `su:clr:${ctxKey}` });
  else if (ctx.selected.length) tools.push({ text: `📋 المختار (${ctx.selected.length})`, callback_data: `su:only:${ctxKey}` });
  rows.push(tools);
  rows.push([
    { text: `💾 حفظ (${ctx.selected.length})`, callback_data: `su:save:${ctxKey}` },
    { text: '❌ إلغاء', callback_data: 'cancel' }
  ]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

function sortAccounts(accounts) {
  return [...accounts].sort((a, b) =>
    (b.active !== false) - (a.active !== false) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

// يبدأ جلسة اختيار: لو الحسابات قليلة (5 أو أقل) نختار النشط تلقائياً، غير كده نسيبها فاضية
async function openPicker(tenant, chatId, platform, token, rawAccounts) {
  const accounts = sortAccounts(rawAccounts);
  const selected = accounts.length <= 5 ? accounts.filter(a => a.active !== false).map(a => a.id) : [];
  const ctx = { platform, token: encrypt(token), accounts, selected, page: 0, filter: '', onlySelected: false };
  const key = tenant.storeContext(ctx);
  const v = pickerView(key, ctx);
  return send(tenant, chatId, v.text, { plain: true, reply_markup: v.reply_markup });
}

function savePicker(tenant, key, ctx) { tenant.db.storeContext(key, { ...ctx, timestamp: Date.now() }); }

async function refreshPicker(tenant, chatId, msgId, key, ctx) {
  const v = pickerView(key, ctx);
  return edit(tenant, chatId, msgId, v.text, { plain: true, reply_markup: v.reply_markup });
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
  if (action === 'noop') return null;

  const ctx = tenant.getContext(key);
  if (!ctx) return send(tenant, chatId, '❌ انتهت الجلسة — ابدأ /setup من جديد', { plain: true });

  if (action === 'tg') {
    const acc = ctx.accounts[parseInt(idx)];
    if (!acc) return null;
    ctx.selected = ctx.selected.includes(acc.id) ? ctx.selected.filter(x => x !== acc.id) : [...ctx.selected, acc.id];
    if (ctx.onlySelected && !ctx.selected.length) ctx.onlySelected = false;
    savePicker(tenant, key, ctx);
    return refreshPicker(tenant, chatId, msgId, key, ctx);
  }

  if (action === 'pg') {
    ctx.page = parseInt(idx) || 0;
    savePicker(tenant, key, ctx);
    return refreshPicker(tenant, chatId, msgId, key, ctx);
  }

  if (action === 'find') {
    state.set(tenant, chatId, { type: 'setup_find', key, msgId });
    return send(tenant, chatId, '🔍 اكتب جزء من اسم الحساب أو رقمه (Account ID):', { plain: true });
  }

  if (action === 'clr' || action === 'only') {
    ctx.filter = '';
    ctx.onlySelected = action === 'only';
    ctx.page = 0;
    savePicker(tenant, key, ctx);
    return refreshPicker(tenant, chatId, msgId, key, ctx);
  }

  if (action === 'save') {
    if (!ctx.selected.length) return send(tenant, chatId, '⚠️ اختار حساب واحد على الأقل — استخدم 🔍 بحث لو الحساب مش ظاهر', { plain: true });
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

  if (st.type === 'setup_find') {
    state.clear(tenant, chatId);
    const ctx = tenant.getContext(st.key);
    if (!ctx) return send(tenant, chatId, '❌ انتهت الجلسة — ابدأ /setup من جديد', { plain: true });
    ctx.filter = input.slice(0, 60);
    ctx.onlySelected = false;
    ctx.page = 0;
    savePicker(tenant, st.key, ctx);
    if (!visibleIndices(ctx).length && /^(act_)?\d{6,}$/.test(input)) {
      await send(tenant, chatId,
        `⚠️ الحساب ${normalize(input)} مش ضمن الحسابات اللي التوكن ده يقدر يوصلها.\n` +
        `ضيفه للـ System User من Business Settings ← System Users ← Add Assets، وبعدين اعمل /setup تاني.`, { plain: true });
    }
    return refreshPicker(tenant, chatId, st.msgId, st.key, ctx);
  }

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
    return openPicker(tenant, chatId, 'meta', input, accounts);
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
    return openPicker(tenant, chatId, 'tiktok', token, accounts);
  }
}

module.exports = { start, handleCallback, handleText };
