const { format } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');

function ts() {
  return format(toZonedTime(new Date(), 'Africa/Cairo'), 'yyyy-MM-dd HH:mm:ss');
}

function make(prefix = '') {
  const p = prefix ? `[${prefix}] ` : '';
  return {
    info: (msg) => console.log(`[${ts()}] ℹ️  ${p}${msg}`),
    success: (msg) => console.log(`[${ts()}] ✅ ${p}${msg}`),
    warn: (msg) => console.warn(`[${ts()}] ⚠️  ${p}${msg}`),
    alert: (msg) => console.log(`[${ts()}] 🚨 ${p}${msg}`),
    error: (msg, err) => {
      console.error(`[${ts()}] ❌ ${p}${msg}`, err?.message || err || '');
      if (err?.stack && process.env.LOG_STACKS !== '0') console.error(err.stack);
    },
    child: (sub) => make(prefix ? `${prefix}/${sub}` : sub)
  };
}

module.exports = make();
