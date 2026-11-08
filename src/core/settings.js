// تعريف إعدادات العميل القابلة للتعديل — مشترك بين أوامر Telegram والداشبورد
const SETTINGS = {
  interval: { key: 'intervalMinutes', label: 'المراجعة الدورية كل', unit: 'دقيقة', min: 30, max: 240, type: 'number' },
  cooldown: { key: 'cooldownHours', label: 'الانتظار بين تنبيهات نفس الـ Ad Set', unit: 'ساعة', min: 1, max: 24, type: 'number' },
  buffer: { key: 'bufferPct', label: 'التنبيه عند تجاوز', unit: '% من Max CPP', min: 100, max: 200, type: 'number' },
  min_purchases: { key: 'minPurchases', label: 'أقل مشتريات قبل حساب CPP', unit: 'مشترية', min: 1, max: 20, type: 'number' },
  high_spend: { key: 'highSpendPct', label: 'تنبيه إنفاق بدون مبيعات عند', unit: '% من Max CPP', min: 100, max: 1000, type: 'number' },
  scale: { key: 'scalePct', label: 'فرصة Scale عند CPP أقل من', unit: '% من Max CPP', min: 10, max: 95, type: 'number' },
  scale_cooldown: { key: 'scaleCooldownHours', label: 'الانتظار بين تنبيهات Scale لنفس الـ Ad Set', unit: 'ساعة', min: 1, max: 48, type: 'number' },
  budget_floor: { key: 'budgetFloor', label: 'أدنى ميزانية يومية', unit: '', min: 1, max: 100000, type: 'number' },
  report_time: { key: 'reportTime', label: 'وقت التقرير اليومي', unit: '', pattern: /^([01]\d|2[0-3]):[0-5]\d$/, type: 'time' },
  currency: { key: 'currency', label: 'رمز العملة', unit: '', pattern: /^.{1,8}$/, type: 'text' },
  timezone: { key: 'timezone', label: 'المنطقة الزمنية', unit: '', pattern: /^[A-Za-z_]+\/[A-Za-z_\-]+$/, type: 'text' }
};

// يرجع { ok, value } أو { ok:false, error }
function validate(name, raw) {
  const d = SETTINGS[name];
  if (!d) return { ok: false, error: `إعداد غير معروف: ${name}` };
  const str = String(raw ?? '').trim();
  if (d.pattern) {
    if (!d.pattern.test(str)) return { ok: false, error: `قيمة غير صالحة لـ ${d.label}` };
    if (name === 'timezone') {
      try { new Intl.DateTimeFormat('en', { timeZone: str }); } catch { return { ok: false, error: 'منطقة زمنية غير معروفة' }; }
    }
    return { ok: true, value: str, def: d };
  }
  const v = parseFloat(str);
  if (isNaN(v) || v < d.min || v > d.max) return { ok: false, error: `${d.label}: القيمة لازم تكون بين ${d.min} و ${d.max}` };
  return { ok: true, value: v, def: d };
}

module.exports = { SETTINGS, validate };
