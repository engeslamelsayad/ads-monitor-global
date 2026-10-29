const logger = require('../utils/logger');

// كل الإرسال لـ Telegram بيعدي من هنا
// شبكة أمان: لو Telegram رفض الـ Markdown (can't parse entities) → نعيد الإرسال plain تلقائياً
// كده مستحيل رسالة تضيع بصمت تاني بسبب * أو _ في اسم حملة

const MAX_LEN = 3800;
const isParseError = (err) => /can't parse entities|can't find end/i.test(err?.message || '');
const stripMd = (t) => String(t).replace(/[*_`]/g, '');

async function send(tenantOrBot, chatId, text, opts = {}) {
  const bot = tenantOrBot.bot || tenantOrBot;
  const { plain, ...rest } = opts;
  const options = plain ? { ...rest } : { parse_mode: 'Markdown', ...rest };
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (err) {
    if (!plain && isParseError(err)) {
      logger.warn(`Markdown rejected — resent as plain (${err.message.slice(0, 80)})`);
      const { parse_mode, ...noMd } = options;
      return bot.sendMessage(chatId, stripMd(text), noMd);
    }
    throw err;
  }
}

async function edit(tenant, chatId, messageId, text, opts = {}) {
  const { plain, ...rest } = opts;
  const options = { chat_id: chatId, message_id: messageId, ...(plain ? {} : { parse_mode: 'Markdown' }), ...rest };
  try {
    return await tenant.bot.editMessageText(text, options);
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    if (!plain && isParseError(err)) {
      const { parse_mode, ...noMd } = options;
      return tenant.bot.editMessageText(stripMd(text), noMd).catch(() => null);
    }
    // رسالة قديمة لا يمكن تعديلها → نبعت رسالة جديدة
    tenant.log.warn(`Edit failed, sending new message: ${err.message.slice(0, 80)}`);
    return send(tenant, chatId, text, opts).catch(() => null);
  }
}

// إرسال لكل مستخدمي العميل
async function sendToAll(tenant, text, opts = {}) {
  const results = [];
  for (const chatId of tenant.users) {
    try {
      const m = await send(tenant, chatId, text, opts);
      results.push({ chatId, ok: true, messageId: m?.message_id });
    } catch (err) {
      tenant.log.error(`Send to ${chatId} failed`, err);
      results.push({ chatId, ok: false, error: err.message });
    }
  }
  return results;
}

// تقسيم الرسائل الطويلة (حد Telegram 4096) عند حدود السطور
function chunk(text) {
  if (text.length <= MAX_LEN) return [text];
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > MAX_LEN) {
      if (cur) parts.push(cur);
      cur = line.length > MAX_LEN ? line.slice(0, MAX_LEN) : line;
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) parts.push(cur);
  return parts.length > 1 ? parts.map((p, i) => `(${i + 1}/${parts.length})\n${p}`) : parts;
}

async function sendLong(tenant, chatId, text, opts = { plain: true }) {
  for (const part of chunk(text)) {
    await send(tenant, chatId, part, opts);
    await new Promise(r => setTimeout(r, 500));
  }
}

async function sendLongToAll(tenant, text) {
  for (const chatId of tenant.users) {
    try { await sendLong(tenant, chatId, text); } catch (err) { tenant.log.error(`Long send to ${chatId} failed`, err); }
  }
}

module.exports = { send, edit, sendToAll, sendLong, sendLongToAll, chunk };
