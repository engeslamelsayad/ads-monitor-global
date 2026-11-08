const path = require('path');
const express = require('express');
const config = require('../config');
const registry = require('../core/registry');
const auth = require('./auth');
const api = require('./api');
const logger = require('../utils/logger').child('web');

// خادم الداشبورد — نفس الـ Railway service، على الـ PORT اللي Railway بيحدده

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=')).filter(p => p[0])
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

// حد بسيط لمحاولات الدخول (منع تخمين اللينكات)
const hits = new Map();
function rateLimited(ip, max = 20, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, tenants: registry.list().length }));

  // ---------- الدخول ----------
  app.get('/auth', (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).send('محاولات كتير — استنى دقيقة');
    const sid = auth.consumeLink(String(req.query.t || ''));
    if (!sid) return res.redirect('/?expired=1');
    res.cookie('sid', sid, {
      httpOnly: true, secure: req.secure, sameSite: 'lax', maxAge: auth.SESSION_TTL, path: '/'
    });
    return res.redirect('/');
  });

  // ---------- الـ API ----------
  app.use('/api', express.json({ limit: '200kb' }), (req, res, next) => {
    // حماية CSRF: أي طلب بيغيّر بيانات لازم يكون من الواجهة نفسها
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'dashboard') {
      return res.status(403).json({ error: 'طلب غير مسموح' });
    }
    const sid = parseCookies(req.headers.cookie).sid;
    const sess = auth.getSession(sid);
    if (!sess) return res.status(401).json({ error: 'سجّل الدخول من البوت: /dashboard' });

    // صلاحية لسه سارية؟ (المستخدم ممكن يكون اتشال)
    if (sess.role === 'admin') {
      if (!config.admin.chatIds.includes(sess.chatId)) return res.status(401).json({ error: 'الصلاحية انتهت' });
      const tid = req.get('X-Tenant') || req.query.tenant;
      req.tenant = tid ? registry.get(tid) : registry.list()[0] || null;
    } else {
      req.tenant = registry.get(sess.tenantId);
      if (!req.tenant || !req.tenant.isAuthorized(sess.chatId)) {
        auth.destroySession(sid);
        return res.status(401).json({ error: 'الصلاحية انتهت — اطلب لينك جديد من البوت' });
      }
    }
    req.session = sess;
    req.sid = sid;
    req.actor = { via: 'dashboard', chatId: sess.chatId };
    next();
  });
  app.use('/api', api.router);

  // ---------- الواجهة ----------
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '5m' }));
  app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.use((err, req, res, next) => {
    if (!(err.expose && err.status < 500)) logger.error(`${req.method} ${req.path}`, err);
    res.status(err.status || 500).json({ error: err.expose ? err.message : (err.message || 'خطأ في السيرفر') });
  });
  return app;
}

function start() {
  const port = parseInt(process.env.PORT) || 3000;
  return new Promise((resolve) => {
    const server = createApp().listen(port, () => {
      const url = auth.baseUrl();
      logger.success(`Dashboard on :${port}${url ? ` — ${url}` : ' (لا يوجد دومين عام بعد — فعّل Public Networking في Railway)'}`);
      resolve(server);
    });
  });
}

module.exports = { createApp, start };
