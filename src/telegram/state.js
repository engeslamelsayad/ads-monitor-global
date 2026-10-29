// حالة المحادثة المؤقتة (خطوات متعددة: نسبة مخصصة، لصق توكن، تعديل اسم...)
// في الذاكرة عمداً — لو السيرفر عمل restart المستخدم يعيد الخطوة بس
const states = new Map(); // `${tenantId}:${chatId}` → { type, ..., at }
const TTL = 30 * 60 * 1000;
const k = (t, c) => `${t.id}:${c}`;

module.exports = {
  set: (t, chatId, s) => states.set(k(t, chatId), { ...s, at: Date.now() }),
  get: (t, chatId) => {
    const s = states.get(k(t, chatId));
    if (s && Date.now() - s.at > TTL) { states.delete(k(t, chatId)); return null; }
    return s || null;
  },
  clear: (t, chatId) => states.delete(k(t, chatId))
};
