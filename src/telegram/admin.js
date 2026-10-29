const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const registry = require('../core/registry');
const runtime = require('./runtime');
const { send, sendToAll } = require('./messenger');
const logger = require('../utils/logger').child('admin');

// بوت الأدمن المركزي — إضافة وإدارة العملاء (لك أنت بس)

let bot = null;
const pending = new Map(); // confirm keys للحذف

const HELP = `🛡 بوت الإدارة

/new_tenant توكن الاسم — إضافة عميل (بوت) جديد
/tenants — كل العملاء وحالتهم
/tenant اسم — تفاصيل عميل
/invite اسم — لينك دعوة جديد للعميل
/pause_tenant اسم — إيقاف عميل مؤقتاً
/resume_tenant اسم — تشغيل عميل
/remove_tenant اسم — حذف عميل
/check_all — فحص فوري لكل العملاء
/announce نص — رسالة لكل مستخدمي كل العملاء

💡 خطوات عميل جديد:
1. @BotFather ← /newbot ← خد التوكن
2. هنا: /new_tenant التوكن اسم العميل
3. ابعت لينك الدعوة للعميل ← يفتحه ← /setup`;

const isAdmin = (msg) => config.admin.chatIds.includes(String(msg.chat.id));
const reply = (msg, text, opts = {}) => send(bot, msg.chat.id, text, { plain: true, ...opts });

function describe(t) {
  const s = t.setupStatus;
  const last = parseInt(t.db.getState('last_cycle', '0'));
  return `${t.active ? (t.isReady ? '🟢' : '🟡') : '⏸'} ${t.name} (@${t.botUsername || '—'})\n` +
    `   id: ${t.id}\n` +
    `   Meta: ${s.meta ? t.metaAccounts.length : '—'} | TikTok: ${s.tiktok ? t.tiktokAdvertisers.length : '—'} | منتجات: ${t.products.length} | مستخدمين: ${t.users.length}\n` +
    `   آخر فحص: ${last ? `${Math.round((Date.now() - last) / 60000)} د` : 'لم يحدث'}${t.record.disabledReason ? ` | ⚠️ ${t.record.disabledReason}` : ''}`;
}

function start() {
  bot = new TelegramBot(config.admin.botToken, { polling: { interval: 1000, params: { timeout: 10 } } });
  let lastPollErr = 0;
  bot.on('polling_error', (err) => {
    if (Date.now() - lastPollErr < 5 * 60 * 1000) return; // منع إغراق الـ logs
    lastPollErr = Date.now();
    logger.error('Admin polling error', err);
  });

  const on = (re, fn) => bot.onText(re, async (msg, m) => {
    if (!isAdmin(msg)) return reply(msg, `🔒 غير مصرح. معرّفك: ${msg.chat.id}`);
    try { await fn(msg, m); } catch (err) { logger.error(`Admin cmd failed`, err); reply(msg, `❌ ${err.message}`); }
  });

  on(/^\/(start|help)/, (msg) => reply(msg, HELP));

  on(/^\/new_tenant\s+(\d+:[A-Za-z0-9_-]+)\s+(.+)/, async (msg, m) => {
    // مسح رسالة التوكن من الشات
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    const token = m[1], name = m[2].trim();
    const probe = new TelegramBot(token, { polling: false });
    let me;
    try { me = await probe.getMe(); } catch { return reply(msg, '❌ توكن البوت غير صالح'); }
    const t = registry.add({ name, botToken: token });
    await runtime.startTenantBot(t);
    return reply(msg,
      `✅ تم إنشاء العميل: ${name}\n🤖 @${me.username}\n🆔 ${t.id}\n\n` +
      `🔗 لينك الدعوة (لأول مستخدم — يستخدم مرة واحدة):\nhttps://t.me/${me.username}?start=${t.record.inviteCode}\n\n` +
      `بعد ما يفتحه، البوت هيوجهه لـ /setup تلقائياً.`);
  });

  on(/^\/tenants/, (msg) => {
    const list = registry.list();
    if (!list.length) return reply(msg, 'لا يوجد عملاء بعد.\n/new_tenant توكن الاسم');
    return reply(msg, `👥 العملاء (${list.length})\n\n${list.map(describe).join('\n\n')}`);
  });

  const withTenant = (fn) => (msg, m) => {
    const t = registry.findByQuery(m[1]);
    if (!t) return reply(msg, `❌ لم أجد عميل "${m[1]}" — /tenants`);
    return fn(msg, t);
  };

  on(/^\/tenant (.+)/, withTenant((msg, t) => {
    const s = t.settings;
    return reply(msg, `${describe(t)}\n\n   العملة: ${s.currency} | التوقيت: ${s.timezone} | التقرير: ${s.reportTime}\n   المنتجات: ${t.products.map(p => `${p.name}(${p.maxCpp})`).join('، ') || '—'}`);
  }));

  on(/^\/invite (.+)/, withTenant((msg, t) => {
    const code = registry.rotateInvite(t.id);
    return reply(msg, `🔗 ${t.name}:\nhttps://t.me/${t.botUsername}?start=${code}`);
  }));

  on(/^\/pause_tenant (.+)/, withTenant(async (msg, t) => {
    registry.update(t.id, { active: false, disabledReason: 'paused_by_admin' });
    await runtime.stopTenantBot(t);
    return reply(msg, `⏸ تم إيقاف ${t.name} (البوت والمراقبة)`);
  }));

  on(/^\/resume_tenant (.+)/, withTenant(async (msg, t) => {
    registry.update(t.id, { active: true, disabledReason: null });
    await runtime.startTenantBot(t);
    return reply(msg, `▶️ تم تشغيل ${t.name}`);
  }));

  on(/^\/remove_tenant (.+)/, withTenant((msg, t) => {
    const key = Math.random().toString(36).slice(2, 10);
    pending.set(key, t.id);
    return reply(msg, `⚠️ حذف ${t.name} نهائياً من السيرفر؟\n(ملف بياناته يفضل على الـ Volume كنسخة احتياطية)`,
      { reply_markup: { inline_keyboard: [[{ text: '🗑 حذف', callback_data: `rm:${key}` }, { text: '❌ إلغاء', callback_data: 'x' }]] } });
  }));

  on(/^\/check_all/, async (msg) => {
    await reply(msg, '🔄 جاري فحص كل العملاء...');
    const r = await require('../scheduler').runAllCycles();
    return reply(msg, `✅ ${r.map(x => `${x.name}: ${x.result?.skipped ? 'تخطي' : `${x.result?.alerts || 0} تنبيه`}`).join('\n') || 'لا يوجد عملاء جاهزين'}`);
  });

  on(/^\/announce (.+)/s, async (msg, m) => {
    let n = 0;
    for (const t of registry.list()) {
      if (!t.bot) continue;
      const r = await sendToAll(t, `📢 ${m[1]}`, { plain: true });
      n += r.filter(x => x.ok).length;
    }
    return reply(msg, `✅ اتبعتت لـ ${n} مستخدم`);
  });

  bot.on('callback_query', async (q) => {
    await bot.answerCallbackQuery(q.id).catch(() => {});
    if (!config.admin.chatIds.includes(String(q.message.chat.id))) return;
    const [type, key] = q.data.split(':');
    const opts = { chat_id: q.message.chat.id, message_id: q.message.message_id };
    if (type === 'x') return bot.editMessageText('❌ تم الإلغاء', opts).catch(() => {});
    if (type === 'rm' && pending.has(key)) {
      const t = registry.get(pending.get(key));
      pending.delete(key);
      if (!t) return null;
      await runtime.stopTenantBot(t);
      registry.remove(t.id);
      return bot.editMessageText(`🗑 تم حذف ${t.name}`, opts).catch(() => {});
    }
  });

  logger.success('Admin bot online');
}

// تنبيه الأدمن بمشاكل على مستوى السيرفر (رصيد AI، أخطاء...) — مرة كل 6 ساعات لكل نوع
const lastNotice = new Map();
async function notifyAdmin(kind, text) {
  if (!bot) return;
  if (Date.now() - (lastNotice.get(kind) || 0) < 6 * 3600000) return;
  lastNotice.set(kind, Date.now());
  for (const id of config.admin.chatIds) await send(bot, id, text, { plain: true }).catch(() => {});
}

module.exports = { start, notifyAdmin };
