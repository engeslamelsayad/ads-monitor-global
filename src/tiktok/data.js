const { tiktokGet, tiktokGetAllPages } = require('./client');

// ملاحظة: status و operation_status مش صالحين كـ fields في الـ GET
const CAMPAIGN_FIELDS = ['campaign_id', 'campaign_name', 'budget', 'budget_mode'];
const ADGROUP_FIELDS = ['adgroup_id', 'adgroup_name', 'campaign_id', 'budget', 'budget_mode', 'create_time'];

const METRICS_SAFE = ['spend', 'impressions', 'clicks', 'ctr', 'cpm', 'frequency', 'reach',
  'conversion', 'cost_per_conversion', 'total_purchase_value'];
const METRICS_EXTENDED = [...METRICS_SAFE, 'conversion_rate', 'purchase_roas', 'add_to_cart', 'checkout',
  'video_watched_2s', 'video_watched_6s', 'video_play_complete_rate'];

const getCampaigns = (t, adv) => tiktokGetAllPages(t, '/campaign/get/', {
  advertiser_id: adv, fields: JSON.stringify(CAMPAIGN_FIELDS) });
const getAdgroups = (t, adv) => tiktokGetAllPages(t, '/adgroup/get/', {
  advertiser_id: adv, fields: JSON.stringify(ADGROUP_FIELDS) });

// تقرير — GET (مش POST). AUCTION_ADGROUP لا يقبل campaign_id في الـ dimensions
async function report(t, adv, { dimensions, metrics, level, start, end }) {
  const d = await tiktokGet(t, '/report/integrated/get/', {
    advertiser_id: adv, report_type: 'BASIC', data_level: level,
    dimensions: JSON.stringify(dimensions), metrics: JSON.stringify(metrics),
    start_date: start, end_date: end, page: 1, page_size: 1000
  });
  return d.data?.list || [];
}

// insights اليوم per adgroup — extended ثم fallback لـ safe لو الحساب لا يدعمها (40002)
async function getAdgroupInsightsToday(tenant, adv) {
  const today = tenant.today();
  const opts = { dimensions: ['adgroup_id'], level: 'AUCTION_ADGROUP', start: today, end: today };
  let rows;
  try {
    rows = await report(tenant, adv, { ...opts, metrics: METRICS_EXTENDED });
  } catch (err) {
    if (err.code !== 40002) throw err;
    rows = await report(tenant, adv, { ...opts, metrics: METRICS_SAFE });
  }
  return rows.filter(r => parseFloat(r.metrics?.spend || 0) > 0);
}

// مستوى الحملة لآخر N يوم (للـ discovery)
// TikTok بيحدد مدى التقرير — بنقسم الفترة لشرائح 30 يوم ونجمع النتايج لكل حملة
async function getCampaignInsights(tenant, adv, days = 7) {
  const totals = {};
  for (let end = 0; end < days; end += 30) {
    const span = Math.min(30, days - end);
    const rows = await report(tenant, adv, {
      dimensions: ['campaign_id'], level: 'AUCTION_CAMPAIGN', metrics: ['spend', 'conversion'],
      start: tenant.daysAgo(end + span - 1), end: tenant.daysAgo(end)
    });
    for (const r of rows) {
      const id = String(r.dimensions?.campaign_id);
      const x = totals[id] ||= { spend: 0, conversion: 0 };
      x.spend += parseFloat(r.metrics?.spend || 0);
      x.conversion += parseFloat(r.metrics?.conversion || 0);
    }
  }
  return Object.entries(totals).filter(([, m]) => m.spend > 0)
    .map(([id, m]) => ({ dimensions: { campaign_id: id }, metrics: { spend: String(m.spend), conversion: String(m.conversion) } }));
}

// خريطة الساعات — التقرير بالساعة بنطلبه يوم بيوم (TikTok بيحدد مداه)
async function getHourlyRange(tenant, adv, dates, campaignIds = null) {
  const out = [];
  const only = campaignIds ? new Set(campaignIds.map(String)) : null;
  for (const date of dates) {
    const rows = await report(tenant, adv, only
      ? { dimensions: ['campaign_id', 'stat_time_hour'], level: 'AUCTION_CAMPAIGN', metrics: ['spend', 'conversion'], start: date, end: date }
      : { dimensions: ['stat_time_hour'], level: 'AUCTION_ADVERTISER', metrics: ['spend', 'conversion'], start: date, end: date });
    for (const r of rows) {
      if (only && !only.has(String(r.dimensions?.campaign_id))) continue;
      const st = String(r.dimensions?.stat_time_hour || '');
      out.push({ date: st.slice(0, 10) || date, hour: parseInt(st.slice(11, 13)) || 0,
        spend: parseFloat(r.metrics?.spend || 0), purchases: parseFloat(r.metrics?.conversion || 0) });
    }
  }
  return out;
}

// مستوى الإعلان جوه Ad Group
async function getAdsOfAdgroup(tenant, adv, adgroupId, from, to) {
  const [ads, rows] = await Promise.all([
    tiktokGetAllPages(tenant, '/ad/get/', {
      advertiser_id: adv, fields: JSON.stringify(['ad_id', 'ad_name', 'adgroup_id', 'create_time', 'operation_status']),
      filtering: JSON.stringify({ adgroup_ids: [adgroupId] })
    }),
    (async () => {
      const opts = { dimensions: ['ad_id'], level: 'AUCTION_AD', start: from, end: to };
      try { return await report(tenant, adv, { ...opts, metrics: ['spend', 'impressions', 'clicks', 'ctr', 'frequency', 'conversion', 'video_watched_2s', 'video_play_complete_rate'] }); }
      catch (err) { if (err.code !== 40002) throw err; return report(tenant, adv, { ...opts, metrics: ['spend', 'impressions', 'clicks', 'ctr', 'conversion'] }); }
    })()
  ]);
  const byAd = Object.fromEntries(rows.map(r => [String(r.dimensions?.ad_id), r]));
  return ads.map(a => {
    const row = byAd[String(a.ad_id)];
    const m = row ? parseTiktokInsights(row) : null;
    return {
      id: String(a.ad_id), name: a.ad_name, status: a.operation_status === 'ENABLE' ? 'ACTIVE' : (a.operation_status || ''),
      createdAt: a.create_time ? a.create_time.replace(' ', 'T') + 'Z' : null, thumb: null,
      spend: m?.spend || 0, impressions: m?.impressions || 0, clicks: m?.clicks || 0, ctr: m?.ctr || 0,
      frequency: m?.frequency || 0, purchases: m?.purchases || 0,
      cpp: m && m.purchases ? m.spend / m.purchases : null, hookRate: m?.hookRate || 0, holdRate: m?.holdRate || 0
    };
  });
}

// تحويل صف TikTok لنفس شكل metrics بتاع Meta
function parseTiktokInsights(row) {
  const m = row.metrics || {};
  const n = (k) => parseFloat(m[k] || 0);
  const spend = n('spend'), impressions = n('impressions'), clicks = n('clicks');
  const purchases = n('conversion');
  const completion = n('video_play_complete_rate');
  const twoS = n('video_watched_2s');
  const thruPlays = completion > 0 && impressions > 0 ? (completion / 100) * impressions : 0;
  return {
    spend, impressions, clicks, frequency: n('frequency'), reach: n('reach'),
    ctr: n('ctr'), cpm: n('cpm'), cpc: clicks > 0 ? spend / clicks : 0,
    purchases, costPerPurchase: purchases > 0 ? (n('cost_per_conversion') || spend / purchases) : 0,
    purchaseValue: n('total_purchase_value'), purchaseRoas: n('purchase_roas'),
    addToCart: n('add_to_cart'), costPerATC: n('add_to_cart') > 0 ? spend / n('add_to_cart') : 0,
    checkouts: n('checkout'), lpViews: 0, lpViewRate: 0, purchaseRateLP: 0,
    threeSPlays: twoS, thruPlays,
    hookRate: impressions > 0 ? (twoS / impressions) * 100 : 0,
    holdRate: completion,
    ctaRate: thruPlays > 0 ? (clicks / thruPlays) * 100 : 0
  };
}

module.exports = { getCampaigns, getAdgroups, getAdgroupInsightsToday, getCampaignInsights, parseTiktokInsights, getHourlyRange, getAdsOfAdgroup };
