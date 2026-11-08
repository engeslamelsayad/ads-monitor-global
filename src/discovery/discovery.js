const metaData = require('../meta/data');
const ttData = require('../tiktok/data');
const { getActionValue } = require('../utils/metrics');
const { completeJson } = require('../ai/client');
const { send, edit } = require('../telegram/messenger');
const state = require('../telegram/state');

// وضع الاكتشاف: يقرا الحملات اللي صرفت آخر 7 أيام → AI يجمّعها في منتجات
// → يقترح Max CPP من الأداء الفعلي → المستخدم يعتمد بالأزرار منتج منتج

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const r1 = (n) => Math.round((n || 0) * 10) / 10;

// ---------- 1) جمع الحملات ----------
async function collectCampaigns(t, days) {
  const out = [];
  const errors = [];
  for (const acc of t.metaAccounts) {
    try {
      for (const c of await metaData.getCampaignInsights(t, acc, days)) {
        out.push({ platform: 'meta', account: acc, id: c.campaign_id, name: c.campaign_name,
          spend: parseFloat(c.spend || 0), purchases: getActionValue(c.actions, 'purchase') });
      }
    } catch (err) { errors.push(`Meta ${acc}: ${err.message}`); }
  }
  for (const adv of t.tiktokAdvertisers) {
    try {
      const [camps, ins] = await Promise.all([ttData.getCampaigns(t, adv), ttData.getCampaignInsights(t, adv, days)]);
      const names = Object.fromEntries(camps.map(c => [String(c.campaign_id), c.campaign_name]));
      for (const r of ins) {
        const id = String(r.dimensions?.campaign_id);
        out.push({ platform: 'tiktok', account: adv, id, name: names[id] || id,
          spend: parseFloat(r.metrics?.spend || 0), purchases: parseFloat(r.metrics?.conversion || 0) });
      }
    } catch (err) { errors.push(`TikTok ${adv}: ${err.message}`); }
  }
  return { campaigns: out.sort((a, b) => b.spend - a.spend), errors };
}

// ---------- 2) التجميع بالـ AI ----------
async function clusterWithAI(t, unmatched) {
  const existing = t.products.map(p => `${p.name}${p.aliases?.length ? ` (أسماء بديلة: ${p.aliases.join('، ')})` : ''}`).join('\n') || 'لا يوجد';
  const list = unmatched.map((c, i) => `${i}. [${c.platform}] ${c.name}`).join('\n');
  return completeJson({
    model: 'heavy',
    system: `أنت خبير إعلانات بتنظم حملات Meta و TikTok لمتجر e-commerce. مهمتك تجمّع أسماء الحملات حسب المنتج المُعلن عنه.`,
    prompt: `المنتجات المسجلة حالياً:
${existing}

حملات بتصرف ومش متطابقة مع أي منتج:
${list}

جمّع الحملات حسب المنتج الفعلي. لكل مجموعة:
- display_name: اسم قصير واضح للمنتج بالعربي (كلمة أو اتنين)
- match_keys: كلمات/عبارات موجودة حرفياً داخل أسماء حملات المجموعة وتميّز المنتج ده بس. كل حملة في المجموعة لازم تحتوي واحدة منها على الأقل. ممنوع كلمات عامة مشتركة بين منتجات (زي: عرض قطعتين، eecm test، retarget، Sales Campaign، تواريخ، new pixel، LLA، cr-1).
- campaigns: أرقام الحملات
- existing_product: اسم المنتج المسجل لو المجموعة هي نفس منتج موجود بس باسم مختلف (يبقى نضيفها كاسم بديل)، وإلا null

الحملات اللي مش واضح منتجها حطها في ignore.

الشكل:
{"groups":[{"display_name":"","match_keys":[""],"campaigns":[0],"existing_product":null}],"ignore":[]}`
  });
}

// تحقق من كلمات المطابقة: لازم تطابق حملات المجموعة ومتطابقش حملات تانية
function validateGroups(groups, unmatched, allCampaigns) {
  const lower = (s) => String(s || '').toLowerCase();
  return groups.map(g => {
    const members = (g.campaigns || []).map(i => unmatched[i]).filter(Boolean);
    const memberIds = new Set(members.map(m => `${m.platform}:${m.id}`));
    const others = allCampaigns.filter(c => !memberIds.has(`${c.platform}:${c.id}`));
    const keys = [...new Set((g.match_keys || []).map(k => String(k).trim()).filter(k => k.length >= 2))]
      .filter(k => members.some(m => lower(m.name).includes(lower(k))))
      .filter(k => !others.some(o => lower(o.name).includes(lower(k))));
    const covered = members.filter(m => keys.some(k => lower(m.name).includes(lower(k))));
    const spend = covered.reduce((a, m) => a + m.spend, 0);
    const purchases = covered.reduce((a, m) => a + m.purchases, 0);
    const cpp = purchases > 0 ? spend / purchases : 0;
    return {
      name: String(g.display_name || keys[0] || 'منتج').trim(),
      keys, existing: g.existing_product || null,
      campaigns: members.map(m => ({ name: m.name, platform: m.platform, covered: covered.includes(m) })),
      spend, purchases, cpp,
      suggested: purchases >= 2 ? Math.ceil((cpp * 1.1) / 5) * 5 : null
    };
  }).filter(g => g.campaigns.length).sort((a, b) => b.spend - a.spend);
}

// ---------- 3) التحليل (مشترك بين البوت والداشبورد) ----------
// يرجع { days, total, matched, unmatched, groups, errors } — groups = [] لو مفيش جديد
async function analyze(t, requestedDays) {
  const days = Math.min(Math.max(parseInt(requestedDays) || DEFAULT_DAYS, 1), MAX_DAYS);
  if (!t.setupStatus.meta && !t.setupStatus.tiktok) throw new Error('اربط Meta أو TikTok الأول');
  const { campaigns, errors } = await collectCampaigns(t, days);
  if (errors.length) t.log.warn(`Discovery errors: ${errors.join(' | ')}`);
  const unmatched = campaigns.filter(c => !t.matchProduct(c.name));
  const base = { days, total: campaigns.length, matched: campaigns.length - unmatched.length, unmatched, errors, groups: [] };
  if (!unmatched.length) return base;
  const ai = await clusterWithAI(t, unmatched);
  return { ...base, groups: validateGroups(ai.groups || [], unmatched, campaigns) };
}

// ---------- 3b) جلسة البوت ----------
async function start(t, chatId, requestedDays) {
  if (!t.setupStatus.meta && !t.setupStatus.tiktok) {
    return send(t, chatId, '⚠️ اربط Meta أو TikTok الأول — /setup', { plain: true });
  }
  const days = Math.min(Math.max(parseInt(requestedDays) || DEFAULT_DAYS, 1), MAX_DAYS);
  const wait = await send(t, chatId, `🔍 جاري استكشاف الحملات اللي صرفت آخر ${days} يوم وتجميعها في منتجات...`, { plain: true });

  let r;
  try {
    r = await analyze(t, days);
  } catch (err) {
    t.log.error('Discovery failed', err);
    return edit(t, chatId, wait.message_id, `❌ تعذّر الاكتشاف: ${err.message}\n\nتقدر تضيف المنتجات يدوياً: /add_product اسم حد`, { plain: true });
  }
  if (!r.total) {
    return edit(t, chatId, wait.message_id, `لا توجد حملات صرفت آخر ${days} يوم.${r.errors.length ? `\n\n⚠️ ${r.errors.join('\n')}` : ''}`, { plain: true });
  }
  if (!r.unmatched.length) {
    return edit(t, chatId, wait.message_id, `✅ كل الحملات (${r.total}) متطابقة مع منتجاتك — مفيش حاجة جديدة.`, { plain: true });
  }
  if (!r.groups.length) {
    return edit(t, chatId, wait.message_id, '🤷 مقدرتش أحدد منتجات واضحة من الأسماء — ضيفها يدوياً بـ /add_product', { plain: true });
  }
  await edit(t, chatId, wait.message_id,
    `📋 ${r.total} حملة: ${r.matched} متطابقة و ${r.unmatched.length} جديدة\n✨ لقيت ${r.groups.length} منتج مقترح — هنراجعهم واحد واحد 👇`, { plain: true });
  const key = t.storeContext({ dv: true, days, groups: r.groups, idx: 0, added: [], linked: [], skipped: [] });
  return showCard(t, chatId, key);
}

// ---------- 4) كارت المنتج ----------
function cardText(t, g, i, n, days = DEFAULT_DAYS) {
  const cur = t.currency;
  let s = `📦 منتج مقترح ${i + 1}/${n}: ${g.name}\n\n`;
  s += `🔑 كلمات المطابقة: ${g.keys.length ? g.keys.join(' ، ') : '⚠️ مفيش كلمة مميزة — اضغط "تغيير الاسم" واكتب كلمة موجودة في أسماء الحملات'}\n\n`;
  s += `الحملات (${g.campaigns.length}):\n`;
  s += g.campaigns.slice(0, 8).map(c => `${c.covered ? '•' : '⚠️'} ${c.platform === 'tiktok' ? '🎵' : '🔵'} ${c.name}`).join('\n');
  if (g.campaigns.length > 8) s += `\n• ... و${g.campaigns.length - 8} أخرى`;
  s += `\n\n📊 آخر ${days} يوم: Spend ${r1(g.spend)} ${cur} | 🛒 ${g.purchases} | CPP ${g.purchases ? r1(g.cpp) : '—'}\n`;
  s += g.suggested ? `💡 Max CPP المقترح: ${g.suggested} (الفعلي + 10%)`
    : `💡 مبيعات قليلة — حدد Max CPP بنفسك${days < 30 ? ` أو جرّب /discover ${Math.min(days * 2 > 30 ? 30 : days * 2, MAX_DAYS)} لفترة أطول` : ''}`;
  if (g.existing) s += `\n\n🔗 شكله نفس منتج "${g.existing}" المسجل`;
  return s;
}

function cardKeyboard(key, g) {
  const rows = [];
  if (g.existing) rows.push([{ text: `🔗 اربطها بـ ${g.existing}`.slice(0, 60), callback_data: `dv:link:${key}` }]);
  const r = [];
  if (g.suggested && g.keys.length) r.push({ text: `✅ اعتمد ${g.suggested}`, callback_data: `dv:ok:${key}` });
  r.push({ text: '✍️ حد آخر', callback_data: `dv:cpp:${key}` });
  rows.push(r);
  rows.push([{ text: '✏️ تغيير الاسم', callback_data: `dv:name:${key}` }, { text: '⏭ تخطي', callback_data: `dv:skip:${key}` }]);
  rows.push([{ text: '⏹ إنهاء', callback_data: `dv:end:${key}` }]);
  return { inline_keyboard: rows };
}

async function showCard(t, chatId, key, msgId = null) {
  const s = t.getContext(key);
  if (!s) return send(t, chatId, '❌ انتهت جلسة الاكتشاف — /discover', { plain: true });
  if (s.idx >= s.groups.length) return finish(t, chatId, key, msgId);
  const g = s.groups[s.idx];
  const text = cardText(t, g, s.idx, s.groups.length, s.days);
  const opts = { plain: true, reply_markup: cardKeyboard(key, g) };
  return msgId ? edit(t, chatId, msgId, text, opts) : send(t, chatId, text, opts);
}

function saveSession(t, key, s) { t.db.storeContext(key, { ...s, timestamp: Date.now() }); }

// ---------- 5) الإجراءات ----------
function addProduct(t, g, maxCpp) {
  const aliases = g.keys.filter(k => k !== g.name);
  const existing = t.products.find(p => p.name === g.name);
  if (existing) {
    t.saveProducts(t.products.map(p => (p.name === g.name
      ? { ...p, maxCpp, aliases: [...new Set([...(p.aliases || []), ...aliases])] } : p)));
  } else {
    t.saveProducts([...t.products, { name: g.name, maxCpp, aliases }]);
  }
}

function linkToExisting(t, g) {
  const target = t.findProduct(g.existing);
  if (!target) return false;
  const keys = [...g.keys, g.name].filter(k => k && k !== target.name);
  t.saveProducts(t.products.map(p => (p.name === target.name
    ? { ...p, aliases: [...new Set([...(p.aliases || []), ...keys])] } : p)));
  return target.name;
}

async function handleCallback(t, q) {
  const chatId = String(q.message.chat.id);
  const msgId = q.message.message_id;
  const [, action, key] = q.data.split(':');
  const s = t.getContext(key);
  if (!s?.dv) return send(t, chatId, '❌ انتهت جلسة الاكتشاف — /discover', { plain: true });
  const g = s.groups[s.idx];

  switch (action) {
    case 'ok':
      addProduct(t, g, g.suggested);
      s.added.push(`${g.name} (${g.suggested})`);
      s.idx++; saveSession(t, key, s);
      return showCard(t, chatId, key, msgId);

    case 'link': {
      const name = linkToExisting(t, g);
      if (name) s.linked.push(`${g.name} → ${name}`);
      s.idx++; saveSession(t, key, s);
      return showCard(t, chatId, key, msgId);
    }

    case 'skip':
      s.skipped.push(g.name);
      s.idx++; saveSession(t, key, s);
      return showCard(t, chatId, key, msgId);

    case 'cpp':
      state.set(t, chatId, { type: 'dv_cpp', key, msgId });
      return send(t, chatId, `✍️ اكتب Max CPP لـ ${g.name} (رقم):`, { plain: true });

    case 'name':
      state.set(t, chatId, { type: 'dv_name', key, msgId });
      return send(t, chatId, `✏️ اكتب اسم المنتج — ويُفضّل يكون كلمة موجودة في أسماء حملاته عشان المطابقة:`, { plain: true });

    case 'end':
      s.idx = s.groups.length; saveSession(t, key, s);
      return finish(t, chatId, key, msgId);
  }
}

async function handleText(t, msg, st) {
  const chatId = String(msg.chat.id);
  const s = t.getContext(st.key);
  state.clear(t, chatId);
  if (!s?.dv) return send(t, chatId, '❌ انتهت الجلسة — /discover', { plain: true });
  const g = s.groups[s.idx];
  const text = msg.text.trim();

  if (st.type === 'dv_cpp') {
    const v = parseFloat(text);
    if (!(v > 0)) return send(t, chatId, '❌ رقم غير صالح — اضغط "حد آخر" تاني', { plain: true });
    if (!g.keys.length) {
      return send(t, chatId, '⚠️ لازم تحدد اسم/كلمة مطابقة الأول ("تغيير الاسم")', { plain: true });
    }
    addProduct(t, g, v);
    s.added.push(`${g.name} (${v})`);
    s.idx++; saveSession(t, st.key, s);
    return showCard(t, chatId, st.key);
  }

  if (st.type === 'dv_name') {
    g.name = text;
    // لو الاسم موجود فعلاً في أسماء الحملات يبقى كلمة مطابقة صالحة
    if (g.campaigns.some(c => c.name.toLowerCase().includes(text.toLowerCase())) && !g.keys.includes(text)) g.keys.push(text);
    saveSession(t, st.key, s);
    return showCard(t, chatId, st.key);
  }
}

async function finish(t, chatId, key, msgId) {
  const s = t.getContext(key) || { added: [], linked: [], skipped: [] };
  let text = '🏁 انتهى الاكتشاف\n\n';
  if (s.added.length) text += `✅ منتجات جديدة (${s.added.length}):\n${s.added.map(x => `• ${x}`).join('\n')}\n\n`;
  if (s.linked.length) text += `🔗 اتربطت كأسماء بديلة:\n${s.linked.map(x => `• ${x}`).join('\n')}\n\n`;
  if (s.skipped.length) text += `⏭ اتخطّت: ${s.skipped.join('، ')}\n\n`;
  text += t.isReady ? '🟢 المراقبة شغالة — /check لفحص فوري أو /products للمراجعة' : '⚠️ لسه محتاج منتج واحد على الأقل عشان المراقبة تبدأ';
  const opts = { plain: true };
  return msgId ? edit(t, chatId, msgId, text, opts) : send(t, chatId, text, opts);
}

// ---------- /unmatched ----------
async function showUnmatched(t, chatId) {
  let data;
  try { data = JSON.parse(t.db.getState('unmatched', '{}')); } catch { data = {}; }
  const list = (data.list || []).sort((a, b) => b.spend - a.spend);
  if (!data.at) return send(t, chatId, 'لسه مفيش فحص — /check الأول', { plain: true });
  if (!list.length) return send(t, chatId, '✅ كل الحملات اللي بتصرف النهارده متطابقة مع منتجاتك', { plain: true });
  const total = list.reduce((a, c) => a + c.spend, 0);
  let text = `⚠️ ${list.length} حملة بتصرف من غير مراقبة (${r1(total)} ${t.currency} النهارده):\n\n`;
  text += list.slice(0, 20).map(c => `• ${c.platform === 'tiktok' ? '🎵' : '🔵'} ${c.name} — ${r1(c.spend)}`).join('\n');
  return send(t, chatId, text, {
    plain: true,
    reply_markup: { inline_keyboard: [[{ text: '🔍 اكتشف المنتجات دي', callback_data: 'su:discover' }]] }
  });
}

module.exports = { start, analyze, addProduct, linkToExisting, handleCallback, handleText, showUnmatched, validateGroups, DEFAULT_DAYS, MAX_DAYS };
