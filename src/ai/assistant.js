const config = require('../config');
const { client, handleError, TELEGRAM_RULES } = require('./client');
const { send } = require('../telegram/messenger');

// /ask — مساعد ميديا باير بأدوات حقيقية (Sonnet)
// أي إجراء = زر تأكيد للمستخدم، مفيش تنفيذ مباشر أبداً

const tools = [
  {
    name: 'get_product_history',
    description: 'الأداء اليومي لمنتج per ad set خلال آخر N يوم (حتى 30)',
    input_schema: {
      type: 'object',
      properties: { product_name: { type: 'string' }, days: { type: 'integer' } },
      required: ['product_name']
    }
  },
  {
    name: 'propose_pause_adset',
    description: 'اقتراح إيقاف ad set — يظهر للمستخدم زر تأكيد ولا يُنفَّذ إلا بموافقته',
    input_schema: {
      type: 'object',
      properties: { adset_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['adset_id', 'reason']
    }
  },
  {
    name: 'propose_budget_change',
    description: 'اقتراح رفع أو خفض ميزانية ad set — زر تأكيد للمستخدم',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string' },
        percent: { type: 'integer', description: '1-100' },
        direction: { type: 'string', enum: ['increase', 'decrease'] },
        reason: { type: 'string' }
      },
      required: ['adset_id', 'percent', 'direction', 'reason']
    }
  }
];

const r1 = (n) => Math.round((n || 0) * 10) / 10;
const compact = (r) => ({
  date: r.date, adset_id: r.adset_id, adset: r.adset_name, product: r.product_name, platform: r.platform,
  spend: r1(r.spend), purchases: r.purchases, cpp: r1(r.cpp), max_cpp: r.max_cpp,
  ctr: r1(r.ctr), frequency: r1(r.frequency), hook: r1(r.hook_rate), budget: r.daily_budget
});

async function executeTool(t, name, input, chatId) {
  if (name === 'get_product_history') {
    const p = t.findProduct(input.product_name);
    if (!p) return `لا يوجد منتج باسم ${input.product_name}. المنتجات: ${t.products.map(x => x.name).join('، ')}`;
    const days = Math.min(Math.max(input.days || 7, 1), 30);
    const rows = t.db.getDailyMetricsByProduct(p.name, t.daysAgo(days - 1), t.today());
    return rows.length ? JSON.stringify(rows.map(compact)) : 'لا توجد بيانات';
  }

  // اقتراح إجراء → زر تأكيد
  let row = t.db.getAllAdsetMetricsForDate(t.today()).find(r => r.adset_id === input.adset_id);
  if (!row) row = t.db.getAdsetHistory(input.adset_id, t.daysAgo(6)).pop();
  if (!row) return `adset_id غير موجود: ${input.adset_id}`;

  const key = t.storeContext({
    platform: row.platform, accountId: row.account_id, adsetId: row.adset_id, adsetName: row.adset_name,
    campaignId: row.campaign_id, campaignName: row.campaign_name, productName: row.product_name, dailyBudget: row.daily_budget
  });

  if (name === 'propose_pause_adset') {
    await send(t, chatId, `🤖 اقتراح: إيقاف\n\n📑 ${row.adset_name}\n📦 ${row.product_name}\n\n💭 ${input.reason}`, {
      plain: true,
      reply_markup: { inline_keyboard: [[{ text: '✅ تأكيد الإيقاف', callback_data: `cpause:${key}` }, { text: '❌ تجاهل', callback_data: 'cancel' }]] }
    });
    return 'تم عرض زر التأكيد — القرار للمستخدم.';
  }

  if (name === 'propose_budget_change') {
    const p = Math.max(1, Math.min(100, input.percent));
    const up = input.direction === 'increase';
    await send(t, chatId, `🤖 اقتراح: ${up ? 'رفع' : 'خفض'} الميزانية ${up ? '+' : '-'}${p}%\n\n📑 ${row.adset_name}\n📦 ${row.product_name}\n\n💭 ${input.reason}`, {
      plain: true,
      reply_markup: { inline_keyboard: [[
        { text: `✅ تأكيد ${up ? '+' : '-'}${p}%`, callback_data: up ? `cscale:${key}:${p}` : `bpct:${key}:${p}` },
        { text: '❌ تجاهل', callback_data: 'cancel' }]] }
    });
    return 'تم عرض زر التأكيد — القرار للمستخدم.';
  }
  return 'أداة غير معروفة';
}

async function run(t, question, chatId) {
  const today = t.db.getAllAdsetMetricsForDate(t.today()).map(compact);
  const system = `أنت مساعد ميديا باير خبير لحساب "${t.name}" (Meta + TikTok، سوق COD). العملة: ${t.currency}.
عندك بيانات اليوم per ad set وأدوات لجلب التاريخ واقتراح إجراءات.
- لو المستخدم طلب إجراء أو شايف إجراء لازم، استخدم أدوات الاقتراح (التنفيذ بزر تأكيد).
- adset_id اللي يبدأ بـ tt_ = TikTok.
- اتكلم بالأرقام، وقول رأيك بوضوح.

${TELEGRAM_RULES}`;

  const messages = [{
    role: 'user',
    content: `المنتجات: ${t.products.map(p => `${p.name} (Max ${p.maxCpp})`).join('، ')}\n\nبيانات اليوم ${t.today()}:\n${JSON.stringify(today)}\n\nالسؤال: ${question}`
  }];

  try {
    for (let i = 0; i < 6; i++) {
      const res = await client.messages.create({
        model: config.anthropic.models.heavy, max_tokens: 2000, system, tools, messages
      });
      if (res.stop_reason !== 'tool_use') {
        return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || 'تم.';
      }
      messages.push({ role: 'assistant', content: res.content });
      const results = [];
      for (const b of res.content.filter(x => x.type === 'tool_use')) {
        t.log.info(`[ask] tool ${b.name}`);
        results.push({ type: 'tool_result', tool_use_id: b.id, content: String(await executeTool(t, b.name, b.input, chatId)) });
      }
      messages.push({ role: 'user', content: results });
    }
    return '⚠️ السؤال محتاج خطوات كتير — جرّب تسأل بشكل أبسط.';
  } catch (err) {
    try { await handleError(err); } catch (e) { return `❌ ${e.message}`; }
  }
}

module.exports = { run };
