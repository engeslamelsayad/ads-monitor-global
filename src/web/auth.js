const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const { JsonFile } = require('../core/store');

// دخول الداشبورد بلينك من البوت (مرة واحدة، 15 دقيقة) → session cookie لمدة 7 أيام
// التوكنات بتتخزن hashed (sha256) — لو حد قرا ملف البيانات ما يقدرش يستخدمها

const LINK_TTL = 15 * 60 * 1000;
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const store = new JsonFile(path.join(config.paths.data, 'web.json'), () => ({ links: {}, sessions: {} }));

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

function purge(d) {
  const now = Date.now();
  for (const [k, v] of Object.entries(d.links)) if (v.exp < now || v.used) delete d.links[k];
  for (const [k, v] of Object.entries(d.sessions)) if (v.exp < now) delete d.sessions[k];
}

function baseUrl() {
  if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

// role: 'tenant' (tenantId مطلوب) أو 'admin'
function createLoginLink({ role, tenantId = null, chatId }) {
  const base = baseUrl();
  if (!base) return null;
  const t = token();
  store.mutate(d => {
    purge(d);
    d.links[hash(t)] = { role, tenantId, chatId: String(chatId), exp: Date.now() + LINK_TTL, used: false };
  });
  return `${base}/auth?t=${t}`;
}

// يستهلك اللينك ويرجع session token جديد (أو null)
function consumeLink(t) {
  if (!t) return null;
  return store.mutate(d => {
    const link = d.links[hash(t)];
    if (!link || link.used || link.exp < Date.now()) return null;
    link.used = true;
    const s = token();
    d.sessions[hash(s)] = { role: link.role, tenantId: link.tenantId, chatId: link.chatId, exp: Date.now() + SESSION_TTL, created: Date.now() };
    purge(d);
    return s;
  });
}

function getSession(s) {
  if (!s) return null;
  const sess = store.load().sessions[hash(s)];
  return sess && sess.exp > Date.now() ? sess : null;
}

function destroySession(s) {
  if (!s) return;
  store.mutate(d => { delete d.sessions[hash(s)]; });
}

// لما مستخدم يتشال من العميل، جلساته على الداشبورد تتلغي
function revokeUser(tenantId, chatId) {
  store.mutate(d => {
    for (const [k, v] of Object.entries(d.sessions)) {
      if (v.tenantId === tenantId && v.chatId === String(chatId)) delete d.sessions[k];
    }
  });
}

module.exports = { createLoginLink, consumeLink, getSession, destroySession, revokeUser, baseUrl, SESSION_TTL };
