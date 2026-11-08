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
    '/settings', '/set cooldown 4', '/decisions', '/rules', '/users', '/invite', '/add_user 123456', '/remove_user 123456', '/help', '/start abc'];
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


  // 13) فترة الاكتشاف: Meta بـ time_range، و TikTok متقسم لشرائح 30 يوم ومتجمع
  const mc = require('../src/meta/client'), tc = require('../src/tiktok/client');
  const realGetAll = mc.metaGetAll, realTtGet = tc.tiktokGet;
  let metaParams = null; const ttRanges = [];
  mc.metaGetAll = async (tt, path, params) => { metaParams = params; return [{ campaign_id: 'c1', campaign_name: 'x', spend: '10', actions: [] }]; };
  tc.tiktokGet = async (tt, path, params) => { ttRanges.push([params.start_date, params.end_date]); return { data: { list: [{ dimensions: { campaign_id: 'k1' }, metrics: { spend: '100', conversion: '2' } }] } }; };
  for (const m of ['../src/meta/data', '../src/tiktok/data']) delete require.cache[require.resolve(m)];
  const md2 = require('../src/meta/data'), td2 = require('../src/tiktok/data');
  await md2.getCampaignInsights(t, '111', 30);
  const tr = JSON.parse(metaParams.time_range);
  assert.strictEqual(tr.until, t.today()); assert.strictEqual(tr.since, t.daysAgo(29)); assert(!metaParams.date_preset);
  const ttRows = await td2.getCampaignInsights(t, 'adv', 90);
  assert.strictEqual(ttRanges.length, 3, 'TikTok 90 days → 3 chunks');
  assert.strictEqual(ttRanges[0][1], t.today()); assert.strictEqual(ttRanges[2][0], t.daysAgo(89));
  assert.strictEqual(ttRows[0].metrics.spend, '300'); assert.strictEqual(ttRows[0].metrics.conversion, '6');
  ttRanges.length = 0; await td2.getCampaignInsights(t, 'adv', 7);
  assert.deepStrictEqual(ttRanges, [[t.daysAgo(6), t.today()]]);
  mc.metaGetAll = realGetAll; tc.tiktokGet = realTtGet;
  // الأمر يقبل الرقم
  assert(handlersMap.find(([re]) => re.test('/discover 30'))[0].exec('/discover 30')[1] === '30');
  assert(handlersMap.find(([re]) => re.test('/discover'))[0].exec('/discover')[1] === undefined);
  ok('discovery period: Meta time_range, TikTok 30-day chunks summed, /discover N');


  // 14) الداشبورد: الدخول، CSRF، الصلاحيات، الـ API
  process.env.DASHBOARD_URL = 'http://dash.test';
  const webAuth = require('../src/web/auth');
  const http = require('http');
  const app = require('../src/web/server').createApp();
  const srv = await new Promise(r => { const s2 = app.listen(0, () => r(s2)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = (method, p, { body, cookie, csrf = true, tenantHdr } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-Requested-With': 'dashboard' } : {}), ...(tenantHdr ? { 'X-Tenant': tenantHdr } : {}) };
    const r = http.request(base + p, { method, headers: h }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, json: j, text: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  // بدون دخول
  assert.strictEqual((await req('GET', '/api/me')).status, 401);
  // اللينك
  const link = webAuth.createLoginLink({ role: 'tenant', tenantId: t.id, chatId: '890006956' });
  assert(link.startsWith('http://dash.test/auth?t='));
  const tok = link.split('t=')[1];
  const login = await req('GET', `/auth?t=${tok}`);
  assert.strictEqual(login.status, 302);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert(login.headers['set-cookie'][0].includes('HttpOnly'));
  // اللينك مرة واحدة
  const again = await req('GET', `/auth?t=${tok}`);
  assert(again.headers.location.includes('expired'));
  // الهوية
  const me = await req('GET', '/api/me', { cookie });
  assert.strictEqual(me.json.role, 'tenant'); assert.strictEqual(me.json.tenant.id, t.id);
  assert(!JSON.stringify(me.json).includes('META-TOKEN'), 'no secrets in /me');
  // CSRF: POST من غير الهيدر مرفوض
  assert.strictEqual((await req('POST', '/api/products', { cookie, csrf: false, body: { name: 'x', maxCpp: 5 } })).status, 403);
  // الأداء
  const ov = await req('GET', '/api/overview?days=7', { cookie });
  assert.strictEqual(ov.status, 200);
  assert(ov.json.products.some(p => p.name === 'خرز' && p.cpp === 80));
  assert(ov.json.adsets.find(a => a.id === 'a1').budget === 500);
  // المنتجات: إضافة / تعارض / تعديل اسم (القديم يبقى اسم بديل) / حذف
  assert.strictEqual((await req('POST', '/api/products', { cookie, body: { name: 'فطريات', maxCpp: 110, aliases: ['الفطريات', 'خرز'] } })).status, 400, 'alias clash rejected');
  assert.strictEqual((await req('POST', '/api/products', { cookie, body: { name: 'فطريات', maxCpp: 110, aliases: ['الفطريات'] } })).status, 200);
  const ren = await req('PUT', `/api/products/${encodeURIComponent('فطريات')}`, { cookie, body: { name: 'سيروم الفطريات', maxCpp: 100 } });
  const fp = ren.json.products.find(p => p.name === 'سيروم الفطريات');
  assert(fp && fp.maxCpp === 100 && fp.aliases.includes('فطريات'));
  assert.strictEqual((await req('DELETE', `/api/products/${encodeURIComponent('سيروم الفطريات')}`, { cookie })).status, 200);
  // الإعدادات: قيمة غلط مرفوضة كلها، صح تتحفظ
  const cdBefore = t.settings.cooldownHours;
  assert.strictEqual((await req('PUT', '/api/settings', { cookie, body: { values: { cooldown: 5, buffer: 999 } } })).status, 400);
  assert.strictEqual(t.settings.cooldownHours, cdBefore, 'invalid batch must not partially apply');
  assert.strictEqual((await req('PUT', '/api/settings', { cookie, body: { values: { cooldown: 5, report_time: '23:15', timezone: 'Asia/Dubai' } } })).status, 200);
  assert(t.settings.cooldownHours === 5 && t.settings.reportTime === '23:15' && t.settings.timezone === 'Asia/Dubai');
  t.setSetting('timezone', 'Africa/Cairo');
  assert.strictEqual((await req('PUT', '/api/settings', { cookie, body: { values: { timezone: 'Mars/Base' } } })).status, 400);
  // إجراء ميزانية من الداشبورد → سجل الإجراءات + إخطار الفريق
  const metaActions = require('../src/meta/actions');
  metaActions.reduceBudget = async (tt, id, p) => ({ success: true, oldBudget: 500, newBudget: 500 * (1 - p / 100), adsetName: 'خرز adset' });
  const notified = [];
  t.bot = { sendMessage: async (id, text) => { notified.push([String(id), text]); return { message_id: 1 }; } };
  const bud = await req('POST', '/api/adsets/a1/budget', { cookie, body: { pct: -30 } });
  assert.strictEqual(bud.status, 200); assert.strictEqual(bud.json.to, 350);
  assert(notified.some(([, txt]) => txt.includes('من الداشبورد')));
  const logs = await req('GET', '/api/logs', { cookie });
  assert(logs.json.actions[0].action === 'budget_down' && logs.json.actions[0].via === 'dashboard');
  assert.strictEqual((await req('POST', '/api/adsets/a1/budget', { cookie, body: { pct: -95 } })).status, 400);
  assert.strictEqual((await req('POST', '/api/adsets/nope/pause', { cookie })).status, 404);
  // مستخدم اتشال → الجلسة تتقفل
  const link2 = webAuth.createLoginLink({ role: 'tenant', tenantId: t.id, chatId: '555' });
  const c2 = (await req('GET', `/auth?t=${link2.split('t=')[1]}`)).headers['set-cookie'][0].split(';')[0];
  assert.strictEqual((await req('GET', '/api/me', { cookie: c2 })).status, 200);
  assert.strictEqual((await req('DELETE', '/api/users/555', { cookie })).status, 200);
  assert.strictEqual((await req('GET', '/api/me', { cookie: c2 })).status, 401);
  // ما ينفعش يحذف نفسه
  assert.strictEqual((await req('DELETE', '/api/users/890006956', { cookie })).status, 400);
  // الأدمن: يشوف كل العملاء ويبدّل بينهم؛ والأدمن اللي مش في القائمة مرفوض
  const config = require('../src/config');
  config.admin.chatIds.splice(0, config.admin.chatIds.length, '111');
  const t2 = registry.add({ name: 'Second Client', botToken: '999:XYZ' });
  const la = webAuth.createLoginLink({ role: 'admin', chatId: '111' });
  const ca = (await req('GET', `/auth?t=${la.split('t=')[1]}`)).headers['set-cookie'][0].split(';')[0];
  const ma = await req('GET', '/api/me', { cookie: ca, tenantHdr: t2.id });
  assert(ma.json.role === 'admin' && ma.json.tenants.length === 2 && ma.json.tenant.id === t2.id);
  config.admin.chatIds.splice(0);
  assert.strictEqual((await req('GET', '/api/me', { cookie: ca })).status, 401);
  // الواجهة نفسها + الهيدرز الأمنية
  const page = await req('GET', '/', { csrf: false });
  assert(page.status === 200 && page.text.includes('app.js') && page.headers['content-security-policy'] && page.headers['x-frame-options'] === 'DENY');

  // 15) متابعة القرار + القواعد + الإجراءات الجماعية + التحليل
  {
    const oc = require('../src/core/outcomes');
    const rules = require('../src/core/rules');
    const time = require('../src/utils/time');
    const D = t.daysAgo(5);
    const seed = (id, date, spend, purchases) => t.db.upsertDailyMetrics(date, id, { product_name: 'خرز', adset_name: id, account_id: '111', platform: 'meta', campaign_id: 'c1', campaign_name: 'خرز camp', spend, purchases, daily_budget: 300 });
    for (let i = 1; i <= 3; i++) {
      seed('o1', time.shiftDate(D, -i), 300, 6); seed('o1', time.shiftDate(D, i), 500, 12); // نجاح: مبيعات أكتر و CPP أقل
      seed('o2', time.shiftDate(D, -i), 300, 6); seed('o2', time.shiftDate(D, i), 500, 4);  // فشل
    }
    const at = Date.now() - 5 * 86400000;
    t.db.mutate(d => {
      d.actions.push({ at, via: 'telegram', by: '1', action: 'budget_up', adset: 'o1', adsetId: 'o1', product: 'خرز', platform: 'meta', pct: 40, from: 300, to: 420 });
      d.actions.push({ at: at + 1, via: 'dashboard', by: '1', action: 'budget_up', adset: 'o2', adsetId: 'o2', product: 'خرز', platform: 'meta', pct: 40, from: 300, to: 420 });
      d.actions.push({ at: Date.now() - 86400000, via: 'telegram', by: '1', action: 'budget_down', adset: 'o1', adsetId: 'o1', product: 'خرز', platform: 'meta', pct: -20 });
    });
    const list = oc.computeOutcomes(t);
    const o1 = list.find(o => o.adsetId === 'o1' && o.action === 'budget_up');
    const o2 = list.find(o => o.adsetId === 'o2');
    assert.strictEqual(o1.verdict, 'success'); assert.strictEqual(o1.before.cpp, 50); assert.strictEqual(o1.status, 'final');
    assert.strictEqual(o2.verdict, 'fail');
    assert.strictEqual(list.find(o => o.action === 'budget_down').status, 'pending');
    assert(oc.describe(o1, 'ج.م').includes('من 50 لـ'));
    assert.strictEqual(oc.collectNewFinals(t).length, 2); assert.strictEqual(oc.collectNewFinals(t).length, 0, 'notify once');
    const ocApi = await req('GET', '/api/outcomes', { cookie });
    assert(ocApi.status === 200 && ocApi.json.summary.budget_up.success === 1 && ocApi.json.summary.budget_up.fail === 1);

    // القواعد
    assert.throws(() => rules.validateRule(t, { condition: 'cpp_below', threshold: 60, action: 'budget_up', pct: 80, mode: 'auto' }), /50%/);
    const hist = [{ date: t.daysAgo(1), spend: 400, purchases: 4 }, { date: t.today(), spend: 300, purchases: 2 }];
    const maxX = t.products.find(p => p.name === 'خرز').maxCpp;
    const r130 = { condition: 'cpp_above', threshold: 100 * 90 / maxX, days: 2 };
    assert(rules.conditionMet({ ...r130, threshold: 120 }, hist, 60, t.settings));        // 100 & 150 > 72
    assert(!rules.conditionMet({ ...r130, threshold: 120, days: 3 }, hist, 60, t.settings)); // مفيش 3 أيام
    assert(!rules.conditionMet({ condition: 'cpp_above', threshold: 120, days: 2 }, [{ date: t.daysAgo(2), spend: 400, purchases: 4 }, hist[1]], 60, t.settings), 'must be consecutive');
    const add = await req('POST', '/api/rules', { cookie, body: { condition: 'cpp_above', threshold: 120, days: 1, action: 'budget_down', pct: 30, mode: 'auto' } });
    assert.strictEqual(add.status, 200);
    const addC = await req('POST', '/api/rules', { cookie, body: { condition: 'cpp_above', threshold: 120, days: 1, action: 'pause', mode: 'confirm', name: 'وقف' } });
    assert.strictEqual(addC.status, 200);
    notified.length = 0;
    const item = { platform: 'meta', accountId: '111', adsetKey: 'r1', product: t.products.find(p => p.name === 'خرز'),
      campaign: { id: 'c1', name: 'خرز camp' }, adset: { id: 'r1', name: 'r1 adset', dailyBudget: 300 }, metrics: { spend: 300, purchases: 1 } };
    seed('r1', t.today(), 300, 1);
    const ev = await rules.evaluate(t, [item]);
    assert.strictEqual(ev.fired, 2);
    assert(t.recentActions(5).some(a => a.via === 'rule' && a.action === 'budget_down' && a.adsetId === 'r1'), 'auto rule executed');
    assert(notified.some(([, txt]) => txt.includes('قاعدة تلقائية')));
    assert.strictEqual((await rules.evaluate(t, [item])).fired, 0, 'rule cooldown');
    const rl = await req('GET', '/api/rules', { cookie });
    assert(rl.json.rules.length === 2 && rl.json.rules[0].fires.count === 1);
    assert.strictEqual((await req('PUT', `/api/rules/${rl.json.rules[0].id}`, { cookie, body: { ...rl.json.rules[0], enabled: false } })).json.rule.enabled, false);
    assert.strictEqual((await req('DELETE', `/api/rules/${rl.json.rules[1].id}`, { cookie })).status, 200);

    // جماعي: إشعار واحد
    notified.length = 0;
    const bulk = await req('POST', '/api/adsets/bulk', { cookie, body: { ids: ['a1', 'o1', 'nope'], op: 'budget', pct: -20 } });
    assert(bulk.status === 200 && bulk.json.ok.length === 2 && bulk.json.failed.length === 1);
    assert.strictEqual(new Set(notified.map(([, txt]) => txt)).size, 1, 'one summary message');
    assert.strictEqual((await req('POST', '/api/adsets/bulk', { cookie, body: { ids: ['a1'], op: 'budget', pct: 500 } })).status, 400);

    // التحليل
    const tr = await req('GET', `/api/trend?product=${encodeURIComponent('خرز')}&days=14`, { cookie });
    assert(tr.status === 200 && tr.json.days.length === 14 && tr.json.actions.length >= 2);
    const cmp = await req('GET', '/api/compare?days=3', { cookie });
    assert(cmp.status === 200 && cmp.json.products.length && cmp.json.current.to === t.daysAgo(1));
    // الفحص الدوري: من آخر محاولة محفوظة
    t.db.setState('last_cycle_attempt', String(Date.now()));
    assert(Math.abs(t.nextCycleAt - (Date.now() + t.settings.intervalMinutes * 60000)) < 2000);
    assert.strictEqual((await req('PUT', '/api/settings', { cookie, body: { values: { interval: 20 } } })).status, 400);
    assert.strictEqual((await req('PUT', '/api/settings', { cookie, body: { values: { interval: 60 } } })).status, 200);
    assert.strictEqual(t.settings.intervalMinutes, 60);
    ok('decisions before/after + notify once, rules (auto/confirm/cooldown/consecutive), bulk, trend, compare, interval');
  }
  srv.close();
  ok('dashboard API: magic link single-use, CSRF, permissions, products, settings, budget action + team notify, admin switch');

  console.log(`\n🎉 ${passed}/15 checks passed`);
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
})().catch(err => { console.error('❌ CHECK FAILED:', err); process.exit(1); });
