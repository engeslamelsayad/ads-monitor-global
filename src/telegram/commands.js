const registry = require('../core/registry');
const { send, edit, sendLong } = require('./messenger');
const alerts = require('./alerts');
const state = require('./state');
const { mask } = require('../core/crypto');

// كل أوامر بوت العميل — كل الردود plain text (مضمونة الوصول)

const HELP = (t) => `🤖 ${t.name} — مراقبة إعلانات Meta & TikTok

📊 المتابعة
/status — حالة النظام وأداء اليوم
/top — أفضل 3 منتجات اليوم
/worst — أسوأ 3 منتجات اليوم
/budget — الإنفاق + توقع نهاية اليوم

🔍 المنتجات
/product اسم — أداء per adset آخر 3 أيام
/week اسم — أداء per adset آخر 7 أيام
/pause_product اسم — إيقاف كل Ad Sets لمنتج

🤖 المساعد الذكي
/ask سؤال — تحليل أو اقتراح إجراء
مثال: /ask ايه أسوأ adset في خرز النهارده؟

🧭 الإعداد والاكتشاف
/setup — ربط Meta و TikTok
/discover — استكشاف حملات آخر 7 أيام واقتراح المنتجات
/discover 30 — نفس الكلام لآخر 30 يوم (من 1 لـ 90)
/unmatched — حملات شغالة من غير مراقبة

🛠 المنتجات والحسابات
/products — المنتجات وحدودها
/add_product اسم حد — إضافة منتج
/edit_cpp اسم حد — تعديل Max CPP
/remove_product اسم — حذف منتج
/add_alias منتج = اسم-بديل
/remove_alias منتج = اسم-بديل
/accounts — الحسابات المربوطة
/add_account meta|tiktok ID
/remove_account meta|tiktok ID

🖥 /dashboard — لينك دخول الداشبورد

⚙️ النظام
/settings — الإعدادات الحالية
/set إعداد قيمة — تعديل إعداد
/users — المستخدمون | /invite — لينك دعوة
/add_user ID | /remove_user ID
/check — فحص فوري الآن`;

const { SETTINGS, validate } = require('../core/settings');

function register(tenant) {
  const bot = tenant.bot;
  const reply = (msg, text, opts = {}) => send(tenant, msg.chat.id, text, { plain: true, ...opts });

  // حارس الصلاحيات: أي أمر غير /start من شخص غير مسجل → تجاهل صامت
  const guard = (fn) => async (msg, match) => {
    if (msg.chat.type !== 'private' && !tenant.isAuthorized(msg.chat.id)) return;
    if (!tenant.isAuthorized(msg.chat.id)) return;
    try { await fn(msg, match); } catch (err) {
      tenant.log.error(`Command failed: ${msg.text}`, err);
      reply(msg, `❌ حدث خطأ: ${err.message}`).catch(() => {});
    }
  };
  const on = (re, fn) => bot.onText(re, guard(fn));
  const actor = (msg) => ({ via: 'telegram', chatId: String(msg.chat.id) });

  // ---------- /start [inviteCode] ----------
  bot.onText(/^\/start(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    if (tenant.isAuthorized(chatId)) return reply(msg, `👋 أهلاً بيك تاني!\n\n${HELP(tenant)}`);
    const code = match[1];
    if (code && code === tenant.record.inviteCode) {
      tenant.saveUsers([...tenant.users, chatId]);
      registry.rotateInvite(tenant.id); // اللينك يستخدم مرة واحدة
      tenant.log.success(`User joined via invite: ${chatId} (@${msg.from?.username || '-'})`);
      const first = tenant.users.length === 1;
      await reply(msg, `✅ تم تفعيل حسابك على ${tenant.name}\n\n${first ? 'إنت أول مستخدم — يلا نبدأ الإعداد 👇\n/setup' : 'اكتب /help لعرض الأوامر'}`);
      if (!first) {
        for (const u of tenant.users) if (u !== chatId) send(tenant, u, `👤 انضم مستخدم جديد: ${chatId} (@${msg.from?.username || '-'})`, { plain: true }).catch(() => {});
      }
      return;
    }
    return reply(msg, `🔒 البوت ده خاص.\nمعرّفك: ${chatId}\nابعته لمسؤول الحساب عشان يضيفك.`);
  });

  on(/^\/help/, (msg) => reply(msg, HELP(tenant)));
  on(/^\/status/, (msg) => alerts.sendStatus(tenant, msg.chat.id));
  on(/^\/budget/, (msg) => alerts.sendBudget(tenant, msg.chat.id));
  on(/^\/top/, (msg) => alerts.sendRanking(tenant, msg.chat.id, true));
  on(/^\/worst/, (msg) => alerts.sendRanking(tenant, msg.chat.id, false));
  on(/^\/product (.+)/, (msg, m) => alerts.sendProductReport(tenant, msg.chat.id, m[1].trim(), 3));
  on(/^\/week (.+)/, (msg, m) => alerts.sendProductReport(tenant, msg.chat.id, m[1].trim(), 7));

  on(/^\/check/, async (msg) => {
    if (!tenant.isReady) return reply(msg, '⚠️ الإعداد غير مكتمل — اكتب /setup');
    if (tenant.cycleRunning) return reply(msg, '⏳ فيه فحص شغال بالفعل، استنى دقيقة.');
    await reply(msg, '🔄 جاري الفحص...');
    const r = await require('../core/engine').runCycle(tenant);
    return reply(msg, `✅ انتهى الفحص: ${r.items || 0} Ad Set | ${r.alerts || 0} تنبيه | ${r.scales || 0} فرصة Scale${r.unmatched ? `\n⚠️ ${r.unmatched} حملة غير مطابقة — /unmatched` : ''}`);
  });

  on(/^\/ask (.+)/s, async (msg, m) => {
    await reply(msg, '🤔 جاري التحليل...');
    const answer = await require('../ai/assistant').run(tenant, m[1].trim(), String(msg.chat.id));
    return sendLong(tenant, msg.chat.id, answer);
  });

  on(/^\/dashboard/, (msg) => {
    const link = require('../web/auth').createLoginLink({ role: 'tenant', tenantId: tenant.id, chatId: msg.chat.id });
    if (!link) return reply(msg, '⚠️ الداشبورد مش متاح لسه — المسؤول محتاج يفعّل الدومين العام على Railway.');
    return reply(msg, `🖥 لينك دخول الداشبورد (لك إنت بس — صالح 15 دقيقة ومرة واحدة):\n${link}\n\nبعد الدخول هتفضل مسجّل 7 أيام على نفس المتصفح.`,
      { disable_web_page_preview: true });
  });

  on(/^\/setup/, (msg) => require('./setup').start(tenant, msg.chat.id));
  on(/^\/discover(?:\s+(\d+))?/, (msg, m) => require('../discovery/discovery').start(tenant, msg.chat.id, m && m[1]));
  on(/^\/unmatched/, (msg) => require('../discovery/discovery').showUnmatched(tenant, msg.chat.id));

  // ---------- إيقاف منتج كامل ----------
  on(/^\/pause_product (.+)/, async (msg, m) => {
    const product = tenant.findProduct(m[1].trim());
    if (!product) return reply(msg, `❌ لم أجد منتجاً باسم "${m[1].trim()}"`);
    const rows = tenant.db.getAllAdsetMetricsForDate(tenant.today()).filter(r => r.product_name === product.name);
    if (!rows.length) return reply(msg, `لا توجد Ad Sets نشطة اليوم لـ ${product.name}`);
    const adsets = Object.fromEntries(rows.map(r => [r.adset_id, r]));
    const key = tenant.storeContext({ productName: product.name, adsets });
    const n = rows.length;
    const list = rows.slice(0, 8).map(r => `• ${r.platform === 'tiktok' ? '🎵' : '🔵'} ${r.adset_name}`).join('\n');
    return reply(msg, `⚠️ تأكيد إيقاف منتج: ${product.name}\n\n${list}${n > 8 ? `\n• ... و${n - 8} آخرين` : ''}\n\nالإجمالي: ${n}`,
      { reply_markup: { inline_keyboard: [[{ text: `✅ إيقاف ${n}`, callback_data: `pprod:${key}` }, { text: '❌ إلغاء', callback_data: 'cancel' }]] } });
  });

  // ---------- المنتجات ----------
  on(/^\/products/, (msg) => {
    const ps = tenant.products;
    if (!ps.length) return reply(msg, '📦 لا توجد منتجات بعد.\n\n💡 /discover لاكتشافها تلقائياً من الحملات');
    let t = `📦 المنتجات (${ps.length})\n\n`;
    ps.forEach((p, i) => {
      t += `${i + 1}. ${p.name} — Max CPP: ${p.maxCpp}\n`;
      if (p.aliases?.length) t += `   ↳ أسماء بديلة: ${p.aliases.join(' ، ')}\n`;
    });
    return reply(msg, `${t}\n💡 /add_product اسم حد`);
  });

  on(/^\/add_product (.+)/, (msg, m) => {
    const parts = m[1].trim().split(/\s+/);
    const max = parseFloat(parts.pop());
    const name = parts.join(' ');
    if (!name || !(max > 0)) return reply(msg, '❌ الصيغة: /add_product اسم المنتج الحد\nمثال: /add_product خرز 55');
    if (tenant.products.some(p => p.name === name)) return reply(msg, `❌ "${name}" موجود — استخدم /edit_cpp`);
    tenant.saveProducts([...tenant.products, { name, maxCpp: max, aliases: [] }]);
    tenant.logAction(actor(msg), 'product_add', { product: name, maxCpp: max });
    return reply(msg, `✅ تم إضافة ${name} — Max CPP: ${max}\nإجمالي المنتجات: ${tenant.products.length}`);
  });

  on(/^\/edit_cpp (.+)/, (msg, m) => {
    const parts = m[1].trim().split(/\s+/);
    const max = parseFloat(parts.pop());
    const p = tenant.findProduct(parts.join(' '));
    if (!p || !(max > 0)) return reply(msg, '❌ الصيغة: /edit_cpp اسم المنتج الحد');
    const old = p.maxCpp;
    tenant.saveProducts(tenant.products.map(x => (x.name === p.name ? { ...x, maxCpp: max } : x)));
    tenant.logAction(actor(msg), 'product_cpp', { product: p.name, from: old, to: max });
    return reply(msg, `✅ ${p.name}: ${old} → ${max}`);
  });

  on(/^\/remove_product (.+)/, (msg, m) => {
    const p = tenant.findProduct(m[1].trim());
    if (!p) return reply(msg, `❌ لم أجد "${m[1].trim()}"`);
    const key = tenant.storeContext({ cfg: 'rmprod', name: p.name });
    return reply(msg, `⚠️ حذف المنتج ${p.name} (Max ${p.maxCpp})؟\nالنظام هيوقف مراقبة حملاته.`,
      { reply_markup: { inline_keyboard: [[{ text: '✅ حذف', callback_data: `cfg:${key}` }, { text: '❌ إلغاء', callback_data: 'cancel' }]] } });
  });

  const aliasCmd = (adding) => (msg, m) => {
    const [a, b] = m[1].split('=').map(s => s?.trim());
    if (!a || !b) return reply(msg, `❌ الصيغة: /${adding ? 'add' : 'remove'}_alias المنتج = الاسم البديل`);
    const p = tenant.findProduct(a);
    if (!p) return reply(msg, `❌ لم أجد منتجاً باسم "${a}"`);
    if (adding) {
      const clash = tenant.products.find(x => x.name === b || (x.aliases || []).includes(b));
      if (clash) return reply(msg, `❌ "${b}" مستخدم بالفعل مع ${clash.name}`);
    }
    const aliases = adding ? [...(p.aliases || []), b] : (p.aliases || []).filter(x => x !== b);
    tenant.saveProducts(tenant.products.map(x => (x.name === p.name ? { ...x, aliases } : x)));
    tenant.logAction(actor(msg), adding ? 'alias_add' : 'alias_remove', { product: p.name, alias: b });
    return reply(msg, `✅ ${p.name}\nالأسماء البديلة: ${aliases.join(' ، ') || 'لا يوجد'}`);
  };
  on(/^\/add_alias (.+)/, aliasCmd(true));
  on(/^\/remove_alias (.+)/, aliasCmd(false));

  // ---------- الحسابات ----------
  on(/^\/accounts/, (msg) => {
    let t = `🏦 الحسابات\n\n🔵 Meta (توكن: ${mask(tenant.metaToken)}):\n`;
    t += tenant.metaAccounts.map(a => `• ${a}`).join('\n') || '• لا يوجد';
    t += `\n\n🎵 TikTok (توكن: ${mask(tenant.tiktokToken)}):\n`;
    t += tenant.tiktokAdvertisers.map(a => `• ${a}`).join('\n') || '• لا يوجد';
    return reply(msg, `${t}\n\n💡 /setup لإعادة الربط أو اختيار الحسابات`);
  });

  on(/^\/add_account (meta|tiktok) (\d+)/, (msg, m) => {
    const plat = m[1];
    const list = plat === 'meta' ? tenant.metaAccounts : tenant.tiktokAdvertisers;
    if (list.includes(m[2])) return reply(msg, '❌ الحساب موجود بالفعل');
    tenant.setAccounts(plat, [...list, m[2]]);
    return reply(msg, `✅ تم إضافة حساب ${plat === 'meta' ? 'Meta' : 'TikTok'}: ${m[2]}\n💡 /discover لاكتشاف منتجاته`);
  });

  on(/^\/remove_account (meta|tiktok) (\d+)/, (msg, m) => {
    const key = tenant.storeContext({ cfg: 'rmacct', platform: m[1], id: m[2] });
    return reply(msg, `⚠️ إزالة حساب ${m[1]} ${m[2]}؟`,
      { reply_markup: { inline_keyboard: [[{ text: '✅ إزالة', callback_data: `cfg:${key}` }, { text: '❌ إلغاء', callback_data: 'cancel' }]] } });
  });

  // ---------- الإعدادات ----------
  on(/^\/settings/, (msg) => {
    const s = tenant.settings;
    let t = `⚙️ الإعدادات\n\n`;
    for (const [name, d] of Object.entries(SETTINGS)) t += `• ${name}: ${s[d.key]} ${d.unit} — ${d.label}\n`;
    return reply(msg, `${t}\n💡 /set اسم قيمة\nمثال: /set cooldown 4`);
  });

  on(/^\/set (\w+) (.+)/, (msg, m) => {
    if (!SETTINGS[m[1]]) return reply(msg, `❌ إعداد غير معروف. المتاح:\n${Object.keys(SETTINGS).join(', ')}`);
    const r = validate(m[1], m[2]);
    if (!r.ok) return reply(msg, `❌ ${r.error}`);
    tenant.setSetting(r.def.key, r.value);
    tenant.logAction(actor(msg), 'setting', { name: m[1], value: r.value });
    return reply(msg, `✅ ${r.def.label}: ${r.value} ${r.def.unit}`);
  });

  // ---------- المستخدمون ----------
  on(/^\/users/, (msg) => {
    const me = String(msg.chat.id);
    return reply(msg, `👥 المستخدمون (${tenant.users.length})\n\n${tenant.users.map((u, i) => `${i + 1}. ${u}${u === me ? ' ← أنت' : ''}`).join('\n')}\n\n💡 /invite لإنشاء لينك دعوة`);
  });

  on(/^\/invite/, (msg) => {
    const code = registry.rotateInvite(tenant.id);
    return reply(msg, `🔗 لينك دعوة (يستخدم مرة واحدة):\nhttps://t.me/${tenant.botUsername}?start=${code}\n\nابعته للميديا باير — أول ما يفتحه ويضغط Start يتفعّل.`);
  });

  on(/^\/add_user (-?\d+)/, async (msg, m) => {
    if (tenant.isAuthorized(m[1])) return reply(msg, '❌ مسجل بالفعل');
    tenant.saveUsers([...tenant.users, m[1]]);
    await reply(msg, `✅ تم إضافة ${m[1]}`);
    return send(tenant, m[1], `👋 تم إضافتك لنظام ${tenant.name}\nاكتب /help لعرض الأوامر`, { plain: true })
      .catch(() => reply(msg, '⚠️ لم أستطع مراسلته — لازم يبعت /start للبوت الأول'));
  });

  on(/^\/remove_user (-?\d+)/, (msg, m) => {
    if (m[1] === String(msg.chat.id)) return reply(msg, '❌ لا يمكنك حذف نفسك');
    if (!tenant.isAuthorized(m[1])) return reply(msg, '❌ غير مسجل');
    const key = tenant.storeContext({ cfg: 'rmuser', id: m[1] });
    return reply(msg, `⚠️ حذف المستخدم ${m[1]}؟`,
      { reply_markup: { inline_keyboard: [[{ text: '✅ حذف', callback_data: `cfg:${key}` }, { text: '❌ إلغاء', callback_data: 'cancel' }]] } });
  });

  // ---------- إدخال نصي (خطوات متعددة) ----------
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (!tenant.isAuthorized(msg.chat.id)) return;
    const st = state.get(tenant, msg.chat.id);
    if (!st) return;
    try {
      if (st.type === 'custom_budget') return require('./handlers').handleCustomBudget(tenant, String(msg.chat.id), msg.text, st);
      if (st.type.startsWith('setup_')) return require('./setup').handleText(tenant, msg, st);
      if (st.type.startsWith('dv_')) return require('../discovery/discovery').handleText(tenant, msg, st);
    } catch (err) {
      tenant.log.error('Text input failed', err);
      reply(msg, `❌ ${err.message}`).catch(() => {});
    }
  });

  // ---------- الأزرار ----------
  bot.on('callback_query', async (q) => {
    if (!tenant.isAuthorized(q.message?.chat?.id)) return bot.answerCallbackQuery(q.id).catch(() => {});
    try {
      await bot.answerCallbackQuery(q.id).catch(() => {});
      await require('./handlers').handleCallback(tenant, q);
    } catch (err) {
      tenant.log.error(`Callback failed: ${q.data}`, err);
      send(tenant, q.message.chat.id, `❌ حدث خطأ: ${err.message}`, { plain: true }).catch(() => {});
    }
  });
}

// تأكيدات حذف المنتج/الحساب/المستخدم
async function handleConfigCallback(tenant, q) {
  const chatId = String(q.message.chat.id);
  const [, key] = q.data.split(':');
  const c = tenant.getContext(key);
  if (!c) return send(tenant, chatId, '❌ انتهت صلاحية الطلب', { plain: true });
  let text;
  if (c.cfg === 'rmprod') {
    tenant.saveProducts(tenant.products.filter(p => p.name !== c.name));
    tenant.logAction({ via: 'telegram', chatId }, 'product_remove', { product: c.name });
    text = `✅ تم حذف ${c.name}\nالمنتجات المتبقية: ${tenant.products.length}`;
  } else if (c.cfg === 'rmacct') {
    const list = c.platform === 'meta' ? tenant.metaAccounts : tenant.tiktokAdvertisers;
    tenant.setAccounts(c.platform, list.filter(a => a !== c.id));
    text = `✅ تمت إزالة ${c.platform} ${c.id}`;
  } else if (c.cfg === 'rmuser') {
    if (tenant.users.length <= 1) text = '❌ لا يمكن حذف آخر مستخدم';
    else {
      tenant.saveUsers(tenant.users.filter(u => u !== c.id));
      require('../web/auth').revokeUser(tenant.id, c.id);
      tenant.logAction({ via: 'telegram', chatId }, 'user_remove', { user: c.id });
      text = `✅ تم حذف ${c.id}`;
    }
  }
  return edit(tenant, chatId, q.message.message_id, text || '❌ إجراء غير معروف', { plain: true });
}

module.exports = { register, handleConfigCallback, HELP };
