const { format } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');

// كل الدوال تقبل timezone العميل (افتراضي القاهرة)
const DEFAULT_TZ = 'Africa/Cairo';

const nowIn = (tz = DEFAULT_TZ) => toZonedTime(new Date(), tz);
const todayString = (tz = DEFAULT_TZ) => format(nowIn(tz), 'yyyy-MM-dd');
const timeString = (tz = DEFAULT_TZ) => format(nowIn(tz), 'HH:mm');
const dateTimeString = (tz = DEFAULT_TZ) => format(nowIn(tz), 'yyyy-MM-dd HH:mm');

function daysAgoString(n, tz = DEFAULT_TZ) {
  return format(toZonedTime(new Date(Date.now() - n * 86400000), tz), 'yyyy-MM-dd');
}

module.exports = { DEFAULT_TZ, nowIn, todayString, timeString, dateTimeString, daysAgoString };
