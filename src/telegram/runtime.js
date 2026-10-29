const TelegramBot = require('node-telegram-bot-api');
const registry = require('../core/registry');
const logger = require('../utils/logger');

// تشغيل بوت Telegram لكل عميل في نفس السيرفر (polling مستقل لكل بوت)

const pollingErrors = new Map(); // tenantId → آخر وقت تسجيل خطأ (منع إغراق الـ logs)

async function startTenantBot(tenant) {
  if (tenant.bot) return tenant.bot;
  const bot = new TelegramBot(tenant.botToken, { polling: { interval: 1000, autoStart: false, params: { timeout: 10 } } });
  const me = await bot.getMe(); // يتأكد إن التوكن صالح قبل ما نبدأ
  tenant.bot = bot;
  tenant.botUsername = me.username;

  bot.on('polling_error', (err) => {
    const last = pollingErrors.get(tenant.id) || 0;
    if (Date.now() - last > 5 * 60 * 1000) {
      pollingErrors.set(tenant.id, Date.now());
      tenant.log.error('Telegram polling error', err);
    }
    // 401 = التوكن اتلغى من BotFather → نوقف البوت ده بس
    if (err.response?.statusCode === 401 || /401|Unauthorized/.test(err.message)) {
      tenant.log.error('Bot token revoked — stopping this tenant bot');
      stopTenantBot(tenant);
      registry.update(tenant.id, { active: false, disabledReason: 'bot_token_revoked' });
    }
  });

  require('./commands').register(tenant);
  await bot.startPolling();
  tenant.log.success(`Bot @${me.username} online`);
  return bot;
}

async function stopTenantBot(tenant) {
  if (!tenant.bot) return;
  try { await tenant.bot.stopPolling({ cancel: true }); } catch {}
  tenant.bot.removeAllListeners();
  tenant.bot = null;
  tenant.log.info('Bot stopped');
}

async function startAll() {
  const tenants = registry.loadAll();
  let ok = 0;
  for (const t of tenants) {
    if (!t.active) continue;
    try { await startTenantBot(t); ok++; } catch (err) { t.log.error('Failed to start bot', err); }
    await new Promise(r => setTimeout(r, 300));
  }
  logger.success(`Tenant bots online: ${ok}/${tenants.filter(t => t.active).length}`);
}

module.exports = { startTenantBot, stopTenantBot, startAll };
