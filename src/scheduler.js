const cron = require('node-cron');
const config = require('./config');
const registry = require('./core/registry');
const engine = require('./core/engine');
const logger = require('./utils/logger');
const time = require('./utils/time');

// جدولة واحدة لكل السيرفر — بتلف على العملاء بالترتيب
// التقارير بتتحسب بتوقيت كل عميل، وبتتأكد مرتين ما تتبعتش (حتى بعد restart)

let cyclesRunning = false;

async function runAllCycles() {
  if (cyclesRunning) { logger.warn('Cycles already running — skip'); return []; }
  cyclesRunning = true;
  const out = [];
  try {
    for (const t of registry.list()) {
      if (!t.active || !t.bot || !t.isReady) continue;
      try {
        out.push({ name: t.name, result: await engine.runCycle(t) });
      } catch (err) {
        t.log.error('Cycle failed', err);
        out.push({ name: t.name, result: { error: err.message } });
      }
      await new Promise(r => setTimeout(r, 2000)); // توزيع الضغط على الـ APIs
    }
  } finally { cyclesRunning = false; }
  return out;
}

// فحص كل 5 دقايق: هل جه وقت التقرير اليومي لأي عميل؟
async function checkReports() {
  for (const t of registry.list()) {
    if (!t.active || !t.bot || !t.isReady) continue;
    const s = t.settings;
    const now = time.timeString(t.tz);
    const today = t.today();
    if (now < s.reportTime || t.db.getState('last_daily_report') === today) continue;
    t.db.setState('last_daily_report', today); // قبل التشغيل — يمنع التكرار لو فشل في النص
    runDailyPipeline(t).catch(err => t.log.error('Daily pipeline failed', err));
  }
}

async function runDailyPipeline(t) {
  const { sendLongToAll } = require('./telegram/alerts');
  t.log.info('Daily pipeline start');

  // آخر فحص قبل التقرير عشان الأرقام تبقى محدّثة
  try { await engine.runCycle(t); } catch (err) { t.log.error('Pre-report cycle failed', err); }

  // 1) التقرير اليومي
  try {
    const report = await require('./ai/reports').daily(t);
    await sendLongToAll(t, `📋 التقرير اليومي — ${t.today()}\n\n${report}`);
  } catch (err) { t.log.error('Daily report failed', err); }

  // 2) تحليل عميق للمنتجات اللي فوق الحد يومين متتاليين
  for (const b of engine.checkConsecutiveBreaches(t)) {
    try {
      const analysis = await require('./ai/reports').deepAnalysis(t, b.product_name);
      await sendLongToAll(t, `🔬 تحليل أداء: ${b.product_name}\nفوق Max CPP يومين متتاليين\n\n${analysis}`);
      t.db.markAnalysisDone(b.product_name, b.today_date);
    } catch (err) { t.log.error(`Deep analysis failed: ${b.product_name}`, err); }
  }

  // 3) تقرير الـ 3 أيام
  const last = parseInt(t.db.getState('last_triday', '0'));
  if (!last) t.db.setState('last_triday', String(Date.now()));
  else if (Date.now() - last >= config.monitor.triDayIntervalDays * 86400000 - 3600000) {
    try {
      const report = await require('./ai/reports').triDay(t);
      await sendLongToAll(t, `📊 تقرير الـ 3 أيام\n\n${report}`);
      t.db.setState('last_triday', String(Date.now()));
    } catch (err) { t.log.error('Tri-day report failed', err); }
  }

  // 4) صيانة: تنظيف البيانات القديمة + فحص التوكنات
  t.db.pruneOldMetrics(t.today());
  await checkTokens(t);
}

async function checkTokens(t) {
  const { sendToAll } = require('./telegram/alerts');
  if (t.metaToken) {
    const r = await require('./meta/client').checkToken(t);
    if (!r.valid) await sendToAll(t, `⚠️ توكن Meta مش شغال (${r.error}).\nجدّده من /setup`, { plain: true });
  }
}

function startAll() {
  // أول دورة بعد دقيقة من التشغيل (البوتات تكون اشتغلت)
  setTimeout(runAllCycles, 60 * 1000);
  setInterval(runAllCycles, config.monitor.intervalMs);
  cron.schedule('*/5 * * * *', () => checkReports().catch(err => logger.error('Report check failed', err)));
  logger.success(`Scheduler started — cycles every ${config.monitor.intervalMs / 60000} min, reports per tenant time`);
}

module.exports = { startAll, runAllCycles, runDailyPipeline };
