const metaData = require('../meta/data');
const ttData = require('../tiktok/data');
const { parseInsights, shouldAlert, isScaleOpportunity } = require('../utils/metrics');

// محرك الفحص — دورة واحدة لعميل واحد (Meta + TikTok)
// كل منصة بتتحول لنفس الشكل الموحد (item) وبعدين نفس منطق التنبيه للاتنين

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ageInDays = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : null);

// ---------- جمع البيانات: Meta ----------
async function collectMeta(tenant, unmatched) {
  const items = [];
  for (const accountId of tenant.metaAccounts) {
    try {
      const [adsets, insights] = await Promise.all([
        metaData.getActiveAdsets(tenant, accountId),
        metaData.getAdsetInsightsToday(tenant, accountId)
      ]);
      const byId = Object.fromEntries(adsets.map(a => [a.id, a]));
      let n = 0;
      for (const row of insights) {
        const adset = byId[row.adset_id];
        if (!adset) continue; // متوقف يدوياً
        const product = tenant.matchProduct(row.campaign_name);
        if (!product) {
          unmatched[`meta:${row.campaign_id}`] = { platform: 'meta', account: accountId, name: row.campaign_name, spend: parseFloat(row.spend || 0) };
          continue;
        }
        items.push({
          platform: 'meta', accountId, product,
          adsetKey: adset.id,
          campaign: { id: row.campaign_id, name: row.campaign_name },
          adset: { id: adset.id, name: adset.name, dailyBudget: parseInt(adset.daily_budget || 0) / 100 },
          metrics: parseInsights(row),
          createdAt: adset.created_time || null
        });
        n++;
      }
      tenant.log.info(`Meta ${accountId}: ${n} adsets`);
    } catch (err) {
      if (err.message === 'META_TOKEN_EXPIRED') throw err;
      tenant.log.error(`Meta account ${accountId} failed`, err);
    }
  }
  return items;
}

// ---------- جمع البيانات: TikTok ----------
async function collectTiktok(tenant, unmatched) {
  const items = [];
  for (const adv of tenant.tiktokAdvertisers) {
    try {
      const [campaigns, adgroups, insights] = await Promise.all([
        ttData.getCampaigns(tenant, adv),
        ttData.getAdgroups(tenant, adv),
        ttData.getAdgroupInsightsToday(tenant, adv)
      ]);
      const camps = Object.fromEntries(campaigns.map(c => [c.campaign_id, c]));
      const ags = Object.fromEntries(adgroups.map(a => [a.adgroup_id, a]));
      let n = 0;
      for (const row of insights) {
        const ag = ags[row.dimensions?.adgroup_id];
        if (!ag) continue;
        // campaign_id من بيانات الـ adgroup (مش من الـ dimensions)
        const camp = camps[ag.campaign_id];
        const campName = camp?.campaign_name || ag.adgroup_name || '';
        const product = tenant.matchProduct(campName) || tenant.matchProduct(ag.adgroup_name);
        if (!product) {
          unmatched[`tiktok:${ag.campaign_id}`] = { platform: 'tiktok', account: adv, name: campName, spend: parseFloat(row.metrics?.spend || 0) };
          continue;
        }
        items.push({
          platform: 'tiktok', accountId: adv, product,
          adsetKey: `tt_${ag.adgroup_id}`,
          campaign: { id: ag.campaign_id, name: campName },
          adset: { id: `tt_${ag.adgroup_id}`, name: ag.adgroup_name, dailyBudget: parseFloat(ag.budget || 0) },
          metrics: ttData.parseTiktokInsights(row),
          createdAt: ag.create_time ? ag.create_time.replace(' ', 'T') : null
        });
        n++;
      }
      tenant.log.info(`TikTok ${adv}: ${n} adgroups`);
    } catch (err) {
      if (err.message === 'TIKTOK_TOKEN_EXPIRED') throw err;
      tenant.log.error(`TikTok advertiser ${adv} failed`, err);
    }
  }
  return items;
}

// ---------- الدورة ----------
async function runCycle(tenant) {
  if (tenant.cycleRunning) return { skipped: true };
  if (!tenant.isReady) return { skipped: true, reason: 'not_ready' };
  tenant.cycleRunning = true;

  const { sendCppAlert, sendScaleAlert, sendToAll } = require('../telegram/alerts');
  const s = tenant.settings;
  const today = tenant.today();
  const unmatched = {};
  const scaledProducts = new Set(); // Scale alert واحد لكل منتج لكل منصة في الدورة
  let alerts = 0, scales = 0;

  try {
    const items = [];
    for (const [platform, fn] of [['meta', collectMeta], ['tiktok', collectTiktok]]) {
      const enabled = platform === 'meta' ? tenant.setupStatus.meta : tenant.setupStatus.tiktok;
      if (!enabled) continue;
      try {
        items.push(...await fn(tenant, unmatched));
      } catch (err) {
        if (/TOKEN_EXPIRED/.test(err.message)) {
          await notifyTokenExpired(tenant, platform, sendToAll);
        } else tenant.log.error(`${platform} collection failed`, err);
      }
    }

    for (const it of items) {
      const { product, metrics: m } = it;
      if (!m.spend) continue;

      const row = {
        product_name: product.name, account_id: it.accountId, platform: it.platform,
        campaign_id: it.campaign.id, campaign_name: it.campaign.name, adset_name: it.adset.name,
        spend: m.spend, purchases: m.purchases, cpp: m.costPerPurchase, max_cpp: product.maxCpp,
        impressions: m.impressions, frequency: m.frequency, ctr: m.ctr, cpm: m.cpm, clicks: m.clicks,
        add_to_cart: m.addToCart, checkouts: m.checkouts, lp_views: m.lpViews,
        three_s_plays: m.threeSPlays, thru_plays: m.thruPlays, hook_rate: m.hookRate, hold_rate: m.holdRate,
        purchase_roas: m.purchaseRoas, daily_budget: it.adset.dailyBudget, adset_created_at: it.createdAt
      };
      tenant.db.upsertDailyMetrics(today, it.adsetKey, row);

      // Rolling 3-day CPP + العمر
      const hist = tenant.db.getAdsetHistory(it.adsetKey, tenant.daysAgo(2));
      const hs = hist.reduce((a, h) => a + (h.spend || 0), 0);
      const hp = hist.reduce((a, h) => a + (h.purchases || 0), 0);
      const extras = { rollingCpp: hp > 0 ? hs / hp : 0, rollingDays: 3, ageDays: ageInDays(it.createdAt) };

      // تنبيه تجاوز
      const decision = shouldAlert(m, product, s);
      if (decision.trigger && !tenant.db.wasAlertedRecently(it.adsetKey, product.name, 'hourly', s.cooldownHours * 3600000)) {
        await sendCppAlert(tenant, { ...it, alertInfo: decision, extras });
        tenant.db.logAlert(product.name, it.adsetKey, 'hourly', decision.reason);
        alerts++;
        await sleep(800);
      }

      // فرصة Scale
      const scaleKey = `${it.platform}:${product.name}`;
      if (isScaleOpportunity(m, product, s) && !scaledProducts.has(scaleKey) &&
          !tenant.db.wasAlertedRecently(it.adsetKey, product.name, 'scale', s.scaleCooldownHours * 3600000)) {
        await sendScaleAlert(tenant, { ...it, extras });
        tenant.db.logAlert(product.name, it.adsetKey, 'scale', 'scale_opportunity');
        scaledProducts.add(scaleKey);
        scales++;
        await sleep(500);
      }
    }

    // حفظ الحملات غير المطابقة لأمر /unmatched
    tenant.db.setState('unmatched', JSON.stringify({ at: Date.now(), list: Object.values(unmatched) }));
    tenant.db.setState('last_cycle', String(Date.now()));
    tenant.log.info(`Cycle done — ${items.length} items | ${alerts} alerts | ${scales} scale | ${Object.keys(unmatched).length} unmatched`);
    return { items: items.length, alerts, scales, unmatched: Object.keys(unmatched).length };
  } finally {
    tenant.cycleRunning = false;
  }
}

async function notifyTokenExpired(tenant, platform, sendToAll) {
  const key = `token_expired_notified:${platform}`;
  const last = parseInt(tenant.db.getState(key, '0'));
  if (Date.now() - last < 12 * 3600000) return; // مرة كل 12 ساعة بالكتير
  tenant.db.setState(key, String(Date.now()));
  const name = platform === 'meta' ? 'Meta' : 'TikTok';
  await sendToAll(tenant, `⚠️ توكن ${name} منتهي أو تم إلغاؤه — المراقبة على ${name} متوقفة.\n\nجدّد الربط من: /setup`, { plain: true });
}

// تسجيل التجاوزات اليومية → المنتجات اللي محتاجة تحليل عميق (يومين متتاليين)
function checkConsecutiveBreaches(tenant) {
  const today = tenant.today();
  const s = tenant.settings;
  for (const p of tenant.db.getProductSummaryForDate(today)) {
    const product = tenant.products.find(x => x.name === p.product_name);
    if (product && p.cpp > product.maxCpp * (s.bufferPct / 100)) {
      tenant.db.recordBreach(p.product_name, today, p.total_spend, p.total_purchases, p.cpp);
    }
  }
  return tenant.db.getProductsNeedingAnalysis(today, tenant.daysAgo(1));
}

module.exports = { runCycle, checkConsecutiveBreaches };
