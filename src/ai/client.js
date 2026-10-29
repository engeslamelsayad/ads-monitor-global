const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

// عميل Anthropic مشترك — مفتاحك لكل العملاء
const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// قواعد تنسيق ثابتة لكل مخرجات AI (بتتبعت plain text على Telegram)
const TELEGRAM_RULES = `قواعد التنسيق (إلزامية — الرد هيتعرض في Telegram كنص عادي):
- ممنوع: ## أو ### أو **نص** أو --- أو جداول بـ |
- استخدم إيموجي كعناوين وسطر لكل بند
- عربي مصري واضح، المصطلحات الإعلانية بالإنجليزي (CPP, CTR, Hook Rate...)
- أرقام محددة، بدون مقدمات أو خاتمة`;

async function handleError(err) {
  const msg = err?.error?.error?.message || err.message || '';
  if (/credit balance|billing/i.test(msg)) {
    await require('../telegram/admin').notifyAdmin('ai_credit',
      '🚨 رصيد Anthropic API خلص — التقارير الذكية و/ask واقفين لكل العملاء.\nاشحن من console.anthropic.com');
    throw new Error('خدمة الذكاء الاصطناعي متوقفة مؤقتاً (رصيد). تم إبلاغ المسؤول.');
  }
  throw err;
}

// نداء نصي بسيط
async function complete({ model = 'light', system, prompt, maxTokens = 2500 }) {
  try {
    const res = await client.messages.create({
      model: config.anthropic.models[model] || model,
      max_tokens: maxTokens,
      system: system ? `${system}\n\n${TELEGRAM_RULES}` : TELEGRAM_RULES,
      messages: [{ role: 'user', content: prompt }]
    });
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  } catch (err) { return handleError(err); }
}

// نداء يرجع JSON (للـ discovery)
async function completeJson({ model = 'heavy', system, prompt, maxTokens = 4000 }) {
  try {
    const res = await client.messages.create({
      model: config.anthropic.models[model] || model,
      max_tokens: maxTokens,
      system: `${system}\n\nأرجع JSON صالح فقط — بدون أي نص قبله أو بعده وبدون code fences.`,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('رد الذكاء الاصطناعي غير مفهوم — جرّب تاني');
    return handleError(err);
  }
}

module.exports = { client, complete, completeJson, handleError, TELEGRAM_RULES };
