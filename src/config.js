require('dotenv').config();
const path = require('path');

// إعدادات عامة على مستوى السيرفر — إعدادات كل عميل محفوظة في بياناته الخاصة
const list = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

const config = {
  admin: {
    botToken: process.env.ADMIN_BOT_TOKEN,
    chatIds: list(process.env.ADMIN_CHAT_IDS)
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    models: {
      heavy: process.env.AI_MODEL_HEAVY || 'claude-sonnet-5-5', // تحليل عميق + /ask + discovery
      light: process.env.AI_MODEL_LIGHT || 'claude-haiku-5-5'   // تقارير يومية و3 أيام
    }
  },

  meta: {
    apiVersion: 'v20.0',
    baseUrl: 'https://graph.facebook.com'
  },

  tiktok: {
    appId: process.env.TIKTOK_APP_ID,
    appSecret: process.env.TIKTOK_APP_SECRET,
    redirectUri: process.env.TIKTOK_REDIRECT_URI || 'https://eecm.co',
    baseUrl: 'https://business-api.tiktok.com/open_api/v1.3'
  },

  encryptionKey: process.env.ENCRYPTION_KEY,

  paths: {
    data: process.env.DATA_DIR || path.join(__dirname, '../data')
  },

  // القيم الافتراضية لأي عميل جديد — كل عميل يقدر يغيرها بـ /set
  tenantDefaults: {
    timezone: 'Africa/Cairo',
    currency: 'ج.م',
    budgetFloor: 55,          // أدنى ميزانية يومية (بعملة الحساب)
    cooldownHours: 3,
    bufferPct: 110,           // تنبيه عند تجاوز 110% من Max CPP
    minPurchases: 2,
    highSpendPct: 250,        // إنفاق > 250% من Max مع مبيعات أقل من الحد الأدنى
    scalePct: 60,             // فرصة Scale عند CPP أقل من 60% من Max
    scaleCooldownHours: 8,
    reportTime: '22:30'
  },

  monitor: {
    intervalMs: 90 * 60 * 1000,
    triDayIntervalDays: 3
  }
};

const required = ['ADMIN_BOT_TOKEN', 'ADMIN_CHAT_IDS', 'ANTHROPIC_API_KEY', 'ENCRYPTION_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length && require.main && !process.env.SKIP_ENV_CHECK) {
  console.error(`❌ متغيرات البيئة المفقودة: ${missing.join(', ')}`);
  process.exit(1);
}
if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length < 32 && !process.env.SKIP_ENV_CHECK) {
  console.error('❌ ENCRYPTION_KEY لازم يكون 32 حرف على الأقل');
  process.exit(1);
}
if (!config.tiktok.appId) console.log('[Config] ℹ️  TikTok App غير مضبوط — ربط TikTok للعملاء معطّل');

module.exports = config;
