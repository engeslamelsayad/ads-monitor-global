const { format } = require('date-fns');
const { toZonedTime, formatInTimeZone } = require('date-fns-tz');

// كل الدوال تقبل timezone العميل (افتراضي القاهرة)
const DEFAULT_TZ = 'Africa/Cairo';

const nowIn = (tz = DEFAULT_TZ) => toZonedTime(new Date(), tz);
const todayString = (tz = DEFAULT_TZ) => format(nowIn(tz), 'yyyy-MM-dd');
const timeString = (tz = DEFAULT_TZ) => format(nowIn(tz), 'HH:mm');
const dateTimeString = (tz = DEFAULT_TZ) => format(nowIn(tz), 'yyyy-MM-dd HH:mm');

function daysAgoString(n, tz = DEFAULT_TZ) {
  return format(toZonedTime(new Date(Date.now() - n * 86400000), tz), 'yyyy-MM-dd');
}

// ms → "HH:mm" بتوقيت العميل (أو "yyyy-MM-dd HH:mm" لو مش النهارده)
function formatTs(ms, tz = DEFAULT_TZ) {
  const d = new Date(ms);
  return formatInTimeZone(d, tz, 'yyyy-MM-dd') === todayString(tz) ? formatInTimeZone(d, tz, 'HH:mm') : formatInTimeZone(d, tz, 'yyyy-MM-dd HH:mm');
}
const dateOf = (ms, tz = DEFAULT_TZ) => formatInTimeZone(new Date(ms), tz, 'yyyy-MM-dd');
// إزاحة تاريخ نصي بعدد أيام
const shiftDate = (dateStr, n) => new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

module.exports = { formatTs, dateOf, shiftDate, DEFAULT_TZ, nowIn, todayString, timeString, dateTimeString, daysAgoString };
