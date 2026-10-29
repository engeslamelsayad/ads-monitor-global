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
async function getCampaignInsights(tenant, adv, days = 7) {
  const rows = await report(tenant, adv, {
    dimensions: ['campaign_id'], level: 'AUCTION_CAMPAIGN',
    metrics: ['spend', 'conversion'], start: tenant.daysAgo(days - 1), end: tenant.today()
  });
  return rows.filter(r => parseFloat(r.metrics?.spend || 0) > 0);
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

module.exports = { getCampaigns, getAdgroups, getAdgroupInsightsToday, getCampaignInsights, parseTiktokInsights };
