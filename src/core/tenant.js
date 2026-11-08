const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { TenantDb } = require('./store');
const { encrypt, decrypt } = require('./crypto');
const time = require('../utils/time');

// عميل واحد = بوت Telegram + بياناته + حساباته + منتجاته
// كل كود النظام بيستقبل الـ tenant كأول معامل بدل الإعدادات العامة

class Tenant {
  constructor(record) {
    this.id = record.id;
    this.record = record;
    this.db = new TenantDb(config.paths.data, record.id);
    this.log = logger.child(record.name || record.id);
    this.bot = null;          // يُعيَّن من طبقة Telegram
    this.botUsername = null;
    this.cycleRunning = false;
  }

  get name() { return this.record.name; }
  get active() { return this.record.active !== false; }
  get botToken() { return decrypt(this.record.botToken); }

  // ---------- الإعدادات ----------
  get settings() {
    return { ...config.tenantDefaults, ...(this.db.load().settings || {}) };
  }
  setSetting(key, value) { this.db.mutate(d => { d.settings[key] = value; }); }
  get tz() { return this.settings.timezone; }
  get currency() { return this.settings.currency; }
  today() { return time.todayString(this.tz); }
  daysAgo(n) { return time.daysAgoString(n, this.tz); }
  nowTime() { return time.timeString(this.tz); }

  // ---------- بيانات الاعتماد (مشفرة) ----------
  get metaToken() { return decrypt(this.db.load().credentials.metaToken) || null; }
  get tiktokToken() { return decrypt(this.db.load().credentials.tiktokToken) || null; }
  setCredential(name, value) {
    this.db.mutate(d => { d.credentials[name] = value ? encrypt(value) : undefined; });
  }

  // ---------- الحسابات ----------
  get metaAccounts() { return this.db.load().accounts.meta || []; }
  get tiktokAdvertisers() { return this.db.load().accounts.tiktok || []; }
  setAccounts(platform, list) {
    this.db.mutate(d => { d.accounts[platform] = [...new Set(list.map(String))]; });
  }

  // ---------- المنتجات ----------
  get products() { return this.db.load().products || []; }
  saveProducts(list) { this.db.mutate(d => { d.products = list; }); }

  findProduct(query) {
    const q = String(query || '').trim();
    const ps = this.products;
    return ps.find(p => p.name === q)
      || ps.find(p => (p.aliases || []).includes(q))
      || ps.find(p => p.name.includes(q) || q.includes(p.name))
      || null;
  }

  // مطابقة اسم حملة بمنتج — الاسم الأساسي أو أي اسم بديل (غير حساس لحالة الأحرف)
  matchProduct(campaignName) {
    if (!campaignName) return null;
    const lower = campaignName.toLowerCase();
    return this.products.find(p =>
      campaignName.includes(p.name) ||
      (p.aliases || []).some(a => a && lower.includes(String(a).toLowerCase()))
    ) || null;
  }

  // ---------- المستخدمون ----------
  get users() { return (this.db.load().users || []).map(String); }
  saveUsers(list) { this.db.mutate(d => { d.users = [...new Set(list.map(String))]; }); }
  isAuthorized(chatId) { return this.users.includes(String(chatId)); }

  // ---------- جاهزية الإعداد ----------
  get setupStatus() {
    return {
      meta: !!this.metaToken && this.metaAccounts.length > 0,
      tiktok: !!this.tiktokToken && this.tiktokAdvertisers.length > 0,
      products: this.products.length > 0,
      users: this.users.length > 0
    };
  }
  get isReady() {
    const s = this.setupStatus;
    return (s.meta || s.tiktok) && s.products && s.users;
  }

  // ---------- سجل الإجراءات ----------
  // actor: { via: 'telegram'|'dashboard', chatId }
  logAction(actor, action, detail = {}) {
    this.db.mutate(d => {
      (d.actions ||= []).push({ at: Date.now(), via: actor?.via || 'system', by: String(actor?.chatId || ''), action, ...detail });
      if (d.actions.length > 1000) d.actions = d.actions.slice(-1000);
    });
  }
  recentActions(limit = 200) { return (this.db.load().actions || []).slice(-limit).reverse(); }

  // ---------- سياق الأزرار ----------
  storeContext(data) {
    const key = `c${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    this.db.storeContext(key, { ...data, timestamp: Date.now() });
    return key;
  }
  getContext(key) { return this.db.getContext(key); }
}

module.exports = Tenant;
