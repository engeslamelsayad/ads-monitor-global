const axios = require('axios');
const config = require('../config');

// TikTok Marketing API v1.3 — بيرجع HTTP 200 حتى مع الأخطاء، لازم نفحص data.code
const BASE = config.tiktok.baseUrl;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function tokenOf(tenant) {
  const t = typeof tenant === 'string' ? tenant : tenant?.tiktokToken;
  if (!t) throw new Error('TIKTOK_NOT_CONFIGURED');
  return t;
}

function check(res, path) {
  if (res.data.code === 40101 || res.data.code === 40105) throw new Error('TIKTOK_TOKEN_EXPIRED');
  if (res.data.code !== 0) {
    const e = new Error(`TikTok [${res.data.code}] ${path}: ${res.data.message}`);
    e.code = res.data.code;
    throw e;
  }
  return res.data;
}

async function tiktokGet(tenant, path, params = {}) {
  await sleep(200);
  const res = await axios.get(`${BASE}${path}`, {
    headers: { 'Access-Token': tokenOf(tenant) }, params, timeout: 30000
  });
  return check(res, path);
}

async function tiktokPost(tenant, path, body = {}) {
  await sleep(200);
  const res = await axios.post(`${BASE}${path}`, body, {
    headers: { 'Access-Token': tokenOf(tenant), 'Content-Type': 'application/json' }, timeout: 30000
  });
  return check(res, path);
}

async function tiktokGetAllPages(tenant, path, params = {}) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const d = await tiktokGet(tenant, path, { ...params, page, page_size: 100 });
    const list = d.data?.list || [];
    out.push(...list);
    if (!list.length || out.length >= (d.data?.page_info?.total_number || 0)) break;
  }
  return out;
}

// ---------- OAuth: ربط حساب TikTok لعميل ----------

function authUrl(state) {
  const p = new URLSearchParams({
    app_id: config.tiktok.appId, state, redirect_uri: config.tiktok.redirectUri
  });
  return `https://business-api.tiktok.com/portal/auth?${p.toString()}`;
}

// يقبل الكود نفسه أو اللينك الكامل اللي اتحوّل له المتصفح
function extractAuthCode(input) {
  const s = String(input || '').trim();
  const m = s.match(/auth_code=([A-Za-z0-9]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{20,}$/.test(s) ? s : null;
}

async function exchangeAuthCode(authCode) {
  const res = await axios.post(`${BASE}/oauth2/access_token/`, {
    app_id: config.tiktok.appId, secret: config.tiktok.appSecret, auth_code: authCode
  }, { timeout: 30000 });
  const d = check(res, '/oauth2/access_token/').data;
  return { accessToken: d.access_token, advertiserIds: (d.advertiser_ids || []).map(String) };
}

// أسماء الحسابات المتاحة للتوكن
async function listAdvertisers(token) {
  const d = await tiktokGet(token, '/oauth2/advertiser/get/', {
    app_id: config.tiktok.appId, secret: config.tiktok.appSecret
  });
  return (d.data?.list || []).map(a => ({ id: String(a.advertiser_id), name: a.advertiser_name }));
}

module.exports = { tiktokGet, tiktokPost, tiktokGetAllPages, authUrl, extractAuthCode, exchangeAuthCode, listAdvertisers };
