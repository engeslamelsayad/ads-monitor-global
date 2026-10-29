const axios = require('axios');
const config = require('../config');

// Meta Graph API — كل طلب بيستخدم توكن العميل نفسه (System User Token)
const BASE = `${config.meta.baseUrl}/${config.meta.apiVersion}`;
const DELAY_MS = 150;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class MetaApiError extends Error {
  constructor(apiErr, path) {
    super(`Meta [${apiErr.code}] ${path}: ${apiErr.message}`);
    this.code = apiErr.code;
    this.expired = apiErr.code === 190;
  }
}

function wrap(err, path) {
  const apiErr = err.response?.data?.error;
  if (apiErr) {
    const e = new MetaApiError(apiErr, path);
    if (e.expired) e.message = 'META_TOKEN_EXPIRED';
    return e;
  }
  return err;
}

function tokenOf(tenantOrToken) {
  const t = typeof tenantOrToken === 'string' ? tenantOrToken : tenantOrToken?.metaToken;
  if (!t) throw new Error('META_NOT_CONFIGURED');
  return t;
}

async function metaGet(tenant, path, params = {}) {
  await sleep(DELAY_MS);
  try {
    const res = await axios.get(`${BASE}${path}`, {
      params: { access_token: tokenOf(tenant), ...params }, timeout: 30000
    });
    return res.data;
  } catch (err) { throw wrap(err, path); }
}

async function metaPost(tenant, path, data = {}) {
  await sleep(DELAY_MS);
  try {
    const res = await axios.post(`${BASE}${path}`, { access_token: tokenOf(tenant), ...data }, { timeout: 30000 });
    return res.data;
  } catch (err) { throw wrap(err, path); }
}

async function metaGetAll(tenant, path, params = {}, maxPages = 50) {
  const out = [];
  let data = await metaGet(tenant, path, params);
  out.push(...(data.data || []));
  let pages = 1;
  while (data.paging?.next && pages < maxPages) {
    await sleep(DELAY_MS);
    try {
      data = (await axios.get(data.paging.next, { timeout: 30000 })).data;
    } catch (err) { throw wrap(err, path); }
    out.push(...(data.data || []));
    pages++;
  }
  return out;
}

// التحقق من التوكن + قائمة الحسابات الإعلانية المتاحة له (للـ /setup)
async function listAdAccounts(token) {
  const accounts = await metaGetAll(token, '/me/adaccounts', {
    fields: 'account_id,name,currency,account_status,timezone_name', limit: 100
  });
  return accounts.map(a => ({
    id: a.account_id, name: a.name, currency: a.currency,
    active: a.account_status === 1, timezone: a.timezone_name
  }));
}

// صلاحية التوكن (System User tokens عادة لا تنتهي)
async function checkToken(tenant) {
  try {
    const me = await metaGet(tenant, '/me', { fields: 'id,name' });
    return { valid: true, name: me.name };
  } catch (err) {
    return { valid: false, expired: err.message === 'META_TOKEN_EXPIRED', error: err.message };
  }
}

module.exports = { metaGet, metaPost, metaGetAll, listAdAccounts, checkToken, MetaApiError };
