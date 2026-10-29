const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { RegistryDb } = require('./store');
const { encrypt, decrypt } = require('./crypto');
const Tenant = require('./tenant');

// سجل العملاء — مصدر الحقيقة لكل البوتات الشغالة على السيرفر
const registryDb = new RegistryDb(config.paths.data);
const tenants = new Map(); // id → Tenant

function slug(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
  return `${base || 't'}-${crypto.randomBytes(3).toString('hex')}`;
}

function loadAll() {
  const data = registryDb.load();
  for (const rec of data.tenants) {
    if (!tenants.has(rec.id)) tenants.set(rec.id, new Tenant(rec));
  }
  return [...tenants.values()];
}

function list() { return [...tenants.values()]; }
function get(id) { return tenants.get(id) || null; }

function findByQuery(q) {
  q = String(q || '').trim().toLowerCase();
  return list().find(t => t.id === q)
    || list().find(t => t.name.toLowerCase() === q)
    || list().find(t => (t.botUsername || '').toLowerCase() === q.replace('@', ''))
    || null;
}

function add({ name, botToken }) {
  if (list().some(t => t.botToken === botToken)) throw new Error('البوت ده مسجل بالفعل');
  const rec = {
    id: slug(name),
    name,
    botToken: encrypt(botToken),
    active: true,
    inviteCode: crypto.randomBytes(6).toString('hex'),
    createdAt: Date.now()
  };
  registryDb.mutate(d => { d.tenants.push(rec); });
  const t = new Tenant(rec);
  tenants.set(rec.id, t);
  logger.success(`Tenant created: ${name} (${rec.id})`);
  return t;
}

function update(id, patch) {
  registryDb.mutate(d => {
    const rec = d.tenants.find(r => r.id === id);
    if (rec) Object.assign(rec, patch);
  });
  const t = tenants.get(id);
  if (t) Object.assign(t.record, patch);
  return t;
}

function remove(id) {
  registryDb.mutate(d => { d.tenants = d.tenants.filter(r => r.id !== id); });
  tenants.delete(id);
  // بيانات العميل نفسها تفضل على الـ Volume (أمان) — تتمسح يدوياً لو مطلوب
}

// كود دعوة جديد (يلغي القديم)
function rotateInvite(id) {
  const code = crypto.randomBytes(6).toString('hex');
  update(id, { inviteCode: code });
  return code;
}

module.exports = { loadAll, list, get, findByQuery, add, update, remove, rotateInvite, decrypt };
