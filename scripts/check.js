// اختبار ذاتي بدون شبكة: يشغّل المنطق الأساسي على بيانات وهمية
process.env.SKIP_ENV_CHECK = '1';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-test-key-test-key-123456';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-check-'));

const assert = require('assert');
let passed = 0;
const ok = (name) => { passed++; console.log('✅', name); };

(async () => {
  // 1) التشفير
  const { encrypt, decrypt, mask } = require('../src/core/crypto');
  const enc = encrypt('EAAB-secret-token');
  assert(enc.startsWith('enc:v1:') && decrypt(enc) === 'EAAB-secret-token');
  assert.strictEqual(mask('abcdefghijklmnop'), 'abcd…mnop');
  ok('crypto roundtrip + mask');

  // 2) السجل + العميل + التخزين
  const registry = require('../src/core/registry');
  const t = registry.add({ name: 'Goldbloom Test', botToken: '123456:ABC-test' });
  assert.strictEqual(t.botToken, '123456:ABC-test');
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'registry.json'), 'utf8'));
  assert(raw.tenants[0].botToken.startsWith('enc:v1:'), 'bot token must be encrypted at rest');
  t.setCredential('metaToken', 'META-TOKEN-XYZ');
  const tf = fs.readFileSync(path.join(process.env.DATA_DIR, 'tenants', `${t.id}.json`), 'utf8');
  assert(!tf.includes('META-TOKEN-XYZ') && t.metaToken === 'META-TOKEN-XYZ');
  ok('registry + encrypted credentials at rest');

  // 3) المطابقة + الأسماء البديلة
  t.saveProducts([
    { name: 'خرز', maxCpp: 55, aliases: [] },
    { name: 'كريم ازالة', maxCpp: 85, aliases: ['wart cream'] },
    { name: 'الظفر', maxCpp: 100, aliases: ['الظافر'] }
  ]);
  assert.strictEqual(t.matchProduct('camp 2 Wart Cream -22/7').name, 'كريم ازالة');
  assert.strictEqual(t.matchProduct('alp - الظافر الناشب - test').name, 'الظفر');
  assert.strictEqual(t.matchProduct('عرض قطعتين eecm test - 26/5 مجموعة خرز اصلاح الاسنان').name, 'خرز');
  assert.strictEqual(t.matchProduct('حملة مجهولة'), null);
  assert.strictEqual(t.findProduct('wart cream').name, 'كريم ازالة');
  ok('matchProduct + aliases + findProduct');

  // 4) الجاهزية
  assert.strictEqual(t.isReady, false);
  t.setAccounts('meta', ['111']); t.saveUsers(['890006956']);
  assert.strictEqual(t.isReady, true);
  ok('setup status / readiness');

  // 5) سياق الأزرار يعيش بعد restart (إعادة تحميل من الملف)
  const key = t.storeContext({ adsetId: '42', platform: 'meta' });
  const Tenant = require('../src/core/tenant');
  const fresh = new Tenant(t.record);
  assert.strictEqual(fresh.getContext(key).adsetId, '42');
  ok('button context survives restart');

  // 6) المحرك ببيانات Meta + TikTok وهمية
  const metaData = require('../src/meta/data');
  const ttData = require('../src/tiktok/data');
  metaData.getActiveAdsets = async () => [{ id: 'a1', name: 'خرز adset *1*', status: 'ACTIVE', daily_budget: '50000', created_time: '2026-09-01T00:00:00+0200' },
    { id: 'a2', name: 'cream adset', status: 'ACTIVE', daily_budget: '30000' }];
  metaData.getAdsetInsightsToday = async () => [
    { adset_id: 'a1', campaign_id: 'c1', campaign_name: 'عرض قطعتين خرز', spend: '400', impressions: '10000', clicks: '200',
      actions: [{ action_type: 'purchase', value: '5' }] },                      // CPP 80 > 55*1.1 → alert
    { adset_id: 'a2', campaign_id: 'c2', campaign_name: 'Wart Cream test', spend: '120', impressions: '5000', clicks: '90',
      actions: [{ action_type: 'purchase', value: '4' }] },                      // CPP 30 < 85*0.6 → scale
    { adset_id: 'a1x', campaign_id: 'c9', campaign_name: 'x', spend: '10' },     // adset متوقف → يتجاهل
  ];
  metaData.getActiveAdsets.toString();
  t.setAccounts('tiktok', ['adv1']); t.setCredential('tiktokToken', 'TT');
  ttData.getCampaigns = async () => [{ campaign_id: 'tc1', campaign_name: 'سم النحل tiktok' }];
  ttData.getAdgroups = async () => [{ adgroup_id: 'g1', adgroup_name: 'ag1', campaign_id: 'tc1', budget: 200 }];
  ttData.getAdgroupInsightsToday = async () => [{ dimensions: { adgroup_id: 'g1' }, metrics: { spend: '90', conversion: '1' } }];

  const sent = [];
  const alerts = require('../src/telegram/alerts');
  alerts.sendCppAlert = async (tt, it) => sent.push(['cpp', it.adset.name]);
  alerts.sendScaleAlert = async (tt, it) => sent.push(['scale', it.adset.name]);
  const engine = require('../src/core/engine');
  t.bot = {};
  const r = await engine.runCycle(t);
  assert.deepStrictEqual(sent.map(s => s[0]).sort(), ['cpp', 'scale']);
  assert.strictEqual(r.unmatched, 1); // حملة سم النحل على TikTok
  const rows = t.db.getAllAdsetMetricsForDate(t.today());
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.find(x => x.adset_id === 'a1').daily_budget, 500);
  // الدورة التانية: الـ cooldown يمنع التكرار
  sent.length = 0;
  await engine.runCycle(t);
  assert.strictEqual(sent.length, 0);
  ok('engine: alert + scale + unmatched + cooldown');

  // 7) التنسيق: اسم فيه * ما يكسرش الرسالة
  const { formatCppAlert, escapeMd } = require('../src/utils/format');
  const txt = formatCppAlert({ tenant: t, product: t.products[0], campaign: { name: 'x_y*z' }, adset: { name: 'Set-3--2*27', dailyBudget: 500 },
    metrics: { costPerPurchase: 80, spend: 400, purchases: 5 }, alertInfo: { reason: 'high_cpp' }, platform: 'meta', extras: { rollingCpp: 60, rollingDays: 3, ageDays: 25 } });
  assert(!txt.includes('2*27') && txt.includes('Set-3--227') && escapeMd('a_b') === 'a-b');
  ok('format: markdown-safe names');

  // 8) الاكتشاف: تحقق كلمات المطابقة
  const { validateGroups } = require('../src/discovery/discovery');
  const unmatched = [
    { platform: 'meta', id: '1', name: 'عرض قطعتين eecm test - 26/5 بخاخ علاج البواسير', spend: 1000, purchases: 15 },
    { platform: 'meta', id: '2', name: 'Retarget - بخاخ البواسير', spend: 300, purchases: 3 },
    { platform: 'meta', id: '3', name: 'عرض قطعتين eecm test - 26/5 سيروم الفطريات', spend: 500, purchases: 5 }
  ];
  const groups = validateGroups([
    { display_name: 'البواسير', match_keys: ['البواسير', 'عرض قطعتين'], campaigns: [0, 1], existing_product: null },
    { display_name: 'فطريات', match_keys: ['الفطريات'], campaigns: [2] }
  ], unmatched, unmatched);
  const b = groups.find(g => g.name === 'البواسير');
  assert.deepStrictEqual(b.keys, ['البواسير'], 'generic key must be rejected');
  assert.strictEqual(b.purchases, 18);
  assert.strictEqual(b.suggested, Math.ceil((1300 / 18) * 1.1 / 5) * 5);
  ok(`discovery: generic keys rejected, suggested Max CPP = ${b.suggested}`);

  // 9) الرسائل الطويلة
  const { chunk } = require('../src/telegram/messenger');
  const parts = chunk(Array(400).fill('سطر تجريبي طويل شوية للاختبار').join('\n'));
  assert(parts.length > 1 && parts.every(p => p.length <= 3820));
  ok(`messenger: long text split into ${parts.length} parts`);

  // 10) تسجيل الأوامر على بوت وهمي + حارس الصلاحيات
  const handlersMap = [];
  const fakeBot = { onText: (re, fn) => handlersMap.push([re, fn]), on: () => {}, sendMessage: async (id, text) => ({ message_id: 1, id, text }) };
  t.bot = fakeBot;
  require('../src/telegram/commands').register(t);
  const cmds = ['/status', '/top', '/worst', '/budget', '/product خرز', '/week خرز', '/pause_product خرز', '/check', '/ask سؤال',
    '/setup', '/discover', '/unmatched', '/products', '/add_product سم النحل 90', '/edit_cpp خرز 60', '/remove_product خرز',
    '/add_alias خرز = beads', '/remove_alias خرز = beads', '/accounts', '/add_account meta 123', '/remove_account meta 123',
    '/settings', '/set cooldown 4', '/users', '/invite', '/add_user 123456', '/remove_user 123456', '/help', '/start abc'];
  const unhandled = cmds.filter(c => !handlersMap.some(([re]) => re.test(c)));
  assert.deepStrictEqual(unhandled, []);
  // /products ما يتلخبطش مع /product
  assert(!handlersMap.find(([re]) => String(re).includes('product (.+)'))[0].test('/products'));
  // مستخدم غريب: يتجاهل بصمت
  const replies = [];
  t.bot.sendMessage = async (id, text) => { replies.push(text); return { message_id: 1 }; };
  await handlersMap.find(([re]) => re.test('/products'))[1]({ chat: { id: 999, type: 'private' }, text: '/products' }, ['/products']);
  assert.strictEqual(replies.length, 0);
  await handlersMap.find(([re]) => re.test('/add_product x 1'))[1]({ chat: { id: 890006956, type: 'private' }, text: '/add_product سم النحل 90' }, [null, 'سم النحل 90']);
  assert(t.products.some(p => p.name === 'سم النحل' && p.maxCpp === 90));
  ok(`commands: ${cmds.length} commands routed, strangers ignored, /add_product works`);

  // 11) دعوة: لينك يستخدم مرة واحدة
  const code = t.record.inviteCode;
  const start = handlersMap.find(([re]) => re.test('/start x'))[1];
  await start({ chat: { id: 555, type: 'private' }, from: {}, text: `/start ${code}` }, [null, code]);
  assert(t.isAuthorized('555') && t.record.inviteCode !== code);
  await start({ chat: { id: 666, type: 'private' }, from: {}, text: `/start ${code}` }, [null, code]);
  assert(!t.isAuthorized('666'));
  ok('invite link: single use');


  // 12) اختيار الحسابات: 129 حساب → صفحات + بحث + حفظ
  const setup = require('../src/telegram/setup');
  const metaClient = require('../src/meta/client');
  const accs = Array.from({ length: 129 }, (_, i) => ({ id: String(900000 + i), name: i === 120 ? 'Goldbloom Main' : `Account ${i}`, active: i % 3 !== 0, currency: 'EGP', timezone: 'Africa/Cairo' }));
  metaClient.listAdAccounts = async () => accs;
  const sentMsgs = [];
  t.bot = {
    sendMessage: async (id, text, o) => { sentMsgs.push({ text, kb: o?.reply_markup }); return { message_id: sentMsgs.length }; },
    editMessageText: async (text, o) => { sentMsgs.push({ text, kb: o?.reply_markup }); return {}; },
    deleteMessage: async () => {}
  };
  const st = require('../src/telegram/state');
  await setup.handleText(t, { chat: { id: 890006956 }, message_id: 1, text: 'EAAB-new-token' }, { type: 'setup_meta_token' });
  let last = sentMsgs[sentMsgs.length - 1];
  const btns = (m) => m.kb.inline_keyboard.flat();
  assert(last.text.includes('129 حساب') && last.text.includes('صفحة 1/17'), last.text);
  assert(!btns(last).some(b => b.text.startsWith('✅')), 'nothing preselected with many accounts');
  const pkey = btns(last).find(b => b.callback_data.startsWith('su:save:')).callback_data.split(':')[2];
  const q = (data) => ({ data, message: { chat: { id: 890006956 }, message_id: 99 } });
  await setup.handleCallback(t, q(`su:pg:${pkey}:16`));
  last = sentMsgs[sentMsgs.length - 1];
  assert(last.text.includes('صفحة 17/17'));
  // بحث بالاسم
  await setup.handleCallback(t, q(`su:find:${pkey}`));
  await setup.handleText(t, { chat: { id: 890006956 }, message_id: 2, text: 'goldbloom' }, st.get(t, '890006956'));
  last = sentMsgs[sentMsgs.length - 1];
  const target = btns(last).find(b => b.text.includes('Goldbloom Main'));
  assert(target && last.text.includes('1 نتيجة'));
  await setup.handleCallback(t, q(target.callback_data));
  last = sentMsgs[sentMsgs.length - 1];
  assert(btns(last).some(b => b.text.startsWith('✅') && b.text.includes('Goldbloom')) && last.text.includes('مختار: 1'));
  // بحث برقم الحساب مع act_
  await setup.handleCallback(t, q(`su:find:${pkey}`));
  await setup.handleText(t, { chat: { id: 890006956 }, message_id: 3, text: 'act_900005' }, st.get(t, '890006956'));
  last = sentMsgs[sentMsgs.length - 1];
  assert(btns(last).some(b => b.text.includes('Account 5')));
  // رقم مش موجود → رسالة إرشاد
  await setup.handleCallback(t, q(`su:find:${pkey}`));
  await setup.handleText(t, { chat: { id: 890006956 }, message_id: 4, text: '123456789' }, st.get(t, '890006956'));
  assert(sentMsgs.some(m => m.text.includes('مش ضمن الحسابات')));
  // حفظ
  await setup.handleCallback(t, q(`su:save:${pkey}`));
  assert.deepStrictEqual(t.metaAccounts, ['900120']);
  assert.strictEqual(t.metaToken, 'EAAB-new-token');
  assert(btns(sentMsgs.find(m => m.text.includes('129'))).every(b => Buffer.byteLength(b.callback_data) <= 64));
  ok('account picker: 129 accounts, pages, search by name/ID, save');

  console.log(`\n🎉 ${passed}/12 checks passed`);
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
})().catch(err => { console.error('❌ CHECK FAILED:', err); process.exit(1); });
