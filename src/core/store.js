const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// تخزين JSON بكتابة ذرّية (tmp + rename) — ملف مستقل لكل عميل
// لا يحتاج native compilation (نفس قرار النسخة القديمة)

const RETENTION_DAYS = 120; // الاحتفاظ ببيانات الأداء اليومية 4 شهور

class JsonFile {
  constructor(filePath, emptyFactory) {
    this.filePath = filePath;
    this.emptyFactory = emptyFactory;
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      this.data = fs.existsSync(this.filePath)
        ? { ...this.emptyFactory(), ...JSON.parse(fs.readFileSync(this.filePath, 'utf8')) }
        : this.emptyFactory();
    } catch (err) {
      // لا نمسح ملف تالف — نحتفظ بنسخة منه للمراجعة
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.filePath, backup); } catch {}
      logger.error(`ملف بيانات تالف، تم حفظ نسخة في ${backup}`, err);
      this.data = this.emptyFactory();
    }
    return this.data;
  }

  save() {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  mutate(fn) {
    const d = this.load();
    const out = fn(d);
    this.save();
    return out;
  }
}

// ==================== بيانات عميل واحد ====================

function emptyTenantData() {
  return {
    settings: {},         // تعديلات /set فوق القيم الافتراضية
    credentials: {},      // metaToken, tiktokToken (مشفرة)
    accounts: { meta: [], tiktok: [] },
    products: [],         // [{ name, maxCpp, aliases: [] }]
    users: [],            // chat ids
    daily_metrics: {},    // "date:adsetId" → row
    alert_log: [],
    breaches: {},         // "product:date" → row
    state: {},            // key → string
    contexts: {},         // ctxKey → { ..., timestamp }
    actions: []           // سجل الإجراءات (مين عمل إيه وإمتى)
  };
}

class TenantDb extends JsonFile {
  constructor(dataDir, tenantId) {
    super(path.join(dataDir, 'tenants', `${tenantId}.json`), emptyTenantData);
  }

  // ---------- Daily metrics ----------
  upsertDailyMetrics(date, adsetId, row) {
    this.mutate(d => { d.daily_metrics[`${date}:${adsetId}`] = { date, adset_id: adsetId, ...row }; });
  }

  pruneOldMetrics(todayStr) {
    const cutoff = new Date(new Date(todayStr).getTime() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
    let removed = 0;
    this.mutate(d => {
      for (const k of Object.keys(d.daily_metrics)) {
        if (d.daily_metrics[k].date < cutoff) { delete d.daily_metrics[k]; removed++; }
      }
    });
    return removed;
  }

  rows() { return Object.values(this.load().daily_metrics); }

  getDailyMetricsByProduct(product, from, to) {
    return this.rows()
      .filter(r => r.product_name === product && r.date >= from && r.date <= to)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  getAllAdsetMetricsForDate(date) {
    return this.rows().filter(r => r.date === date)
      .sort((a, b) => (a.product_name || '').localeCompare(b.product_name || '') ||
        (a.adset_name || '').localeCompare(b.adset_name || ''));
  }

  getProductSummaryForDate(date) {
    const by = {};
    for (const r of this.rows()) {
      if (r.date !== date) continue;
      const p = by[r.product_name] ||= {
        product_name: r.product_name, total_spend: 0, total_purchases: 0,
        max_cpp: r.max_cpp, adsets: new Set(), meta: { spend: 0, purchases: 0 }, tiktok: { spend: 0, purchases: 0 }
      };
      p.total_spend += r.spend || 0;
      p.total_purchases += r.purchases || 0;
      p.adsets.add(r.adset_id);
      const plat = String(r.adset_id).startsWith('tt_') ? p.tiktok : p.meta;
      plat.spend += r.spend || 0;
      plat.purchases += r.purchases || 0;
    }
    return Object.values(by).map(p => ({
      ...p,
      adset_count: p.adsets.size,
      adsets: undefined,
      cpp: p.total_purchases > 0 ? p.total_spend / p.total_purchases : 0
    }));
  }

  getAdsetHistory(adsetId, fromDate) {
    return this.rows().filter(r => r.adset_id === adsetId && r.date >= fromDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---------- Alerts ----------
  wasAlertedRecently(adsetId, product, type, ms) {
    const cutoff = Date.now() - ms;
    return this.load().alert_log.some(a =>
      a.adset_id === adsetId && a.product_name === product && a.alert_type === type && a.sent_at > cutoff);
  }

  logAlert(product, adsetId, type, reason) {
    this.mutate(d => {
      d.alert_log.push({ product_name: product, adset_id: adsetId, alert_type: type, reason, sent_at: Date.now() });
      if (d.alert_log.length > 1000) d.alert_log = d.alert_log.slice(-1000);
    });
  }

  // ---------- Consecutive breaches ----------
  recordBreach(product, date, spend, purchases, cpp) {
    this.mutate(d => {
      const k = `${product}:${date}`;
      d.breaches[k] = { product_name: product, date, total_spend: spend, total_purchases: purchases,
        total_cpp: cpp, analysis_done: d.breaches[k]?.analysis_done || 0 };
    });
  }

  getProductsNeedingAnalysis(today, yesterday) {
    const b = this.load().breaches;
    const names = [...new Set(Object.values(b).map(r => r.product_name))];
    return names.flatMap(n => {
      const t = b[`${n}:${today}`], y = b[`${n}:${yesterday}`];
      return t && y && !t.analysis_done
        ? [{ product_name: n, today_date: today, total_cpp: t.total_cpp, yesterday_cpp: y.total_cpp }] : [];
    });
  }

  markAnalysisDone(product, date) {
    this.mutate(d => { if (d.breaches[`${product}:${date}`]) d.breaches[`${product}:${date}`].analysis_done = 1; });
  }

  // ---------- State ----------
  getState(k, def = null) { const v = this.load().state[k]; return v === undefined ? def : v; }
  setState(k, v) { this.mutate(d => { d.state[k] = String(v); }); }
  deleteState(k) { this.mutate(d => { delete d.state[k]; }); }

  // ---------- سياق الأزرار (يعيش بعد الـ restart، 48 ساعة) ----------
  storeContext(key, record) {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    this.mutate(d => {
      d.contexts[key] = record;
      for (const [k, v] of Object.entries(d.contexts)) if (!v.timestamp || v.timestamp < cutoff) delete d.contexts[k];
    });
  }
  getContext(key) { return this.load().contexts[key] || null; }
}

// ==================== سجل العملاء ====================

class RegistryDb extends JsonFile {
  constructor(dataDir) {
    super(path.join(dataDir, 'registry.json'), () => ({ tenants: [] }));
  }
}

module.exports = { JsonFile, TenantDb, RegistryDb };
