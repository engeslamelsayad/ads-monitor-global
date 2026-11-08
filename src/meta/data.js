const { metaGet, metaGetAll } = require('./client');

// كل استعلامات القراءة من Meta (adsets / insights / creatives) — per tenant

const INSIGHTS_FIELDS = [
  'adset_id', 'adset_name', 'campaign_id', 'campaign_name',
  'spend', 'impressions', 'frequency', 'reach', 'clicks', 'ctr', 'cpm', 'cpc',
  'actions', 'cost_per_action_type', 'action_values',
  'purchase_roas', 'video_thruplay_watched_actions'
].join(',');

const act = (id) => `/act_${id}`;

// الـ adsets الفعالة (المتوقفة يدوياً مستبعدة)
async function getActiveAdsets(tenant, accountId) {
  const list = await metaGetAll(tenant, `${act(accountId)}/adsets`, {
    fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id,created_time',
    filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]),
    limit: 200
  });
  return list.filter(a => a.status === 'ACTIVE');
}

async function getAdsetInsightsToday(tenant, accountId) {
  const rows = await metaGetAll(tenant, `${act(accountId)}/insights`, {
    fields: INSIGHTS_FIELDS, level: 'adset', date_preset: 'today',
    filtering: JSON.stringify([{ field: 'adset.effective_status', operator: 'IN', value: ['ACTIVE'] }]),
    limit: 200
  });
  return rows.filter(r => parseFloat(r.spend || 0) > 0);
}

// على مستوى الحملة لآخر N يوم شامل النهارده (للـ discovery)
async function getCampaignInsights(tenant, accountId, days = 7) {
  const rows = await metaGetAll(tenant, `${act(accountId)}/insights`, {
    fields: 'campaign_id,campaign_name,spend,actions', level: 'campaign',
    time_range: JSON.stringify({ since: tenant.daysAgo(days - 1), until: tenant.today() }), limit: 200
  });
  return rows.filter(r => parseFloat(r.spend || 0) > 0);
}

async function getActiveCampaigns(tenant, accountId) {
  const list = await metaGetAll(tenant, `${act(accountId)}/campaigns`, {
    fields: 'id,name,status,effective_status',
    filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]),
    limit: 200
  });
  return list.filter(c => c.status === 'ACTIVE');
}

// بيانات تاريخية أسبوعية (للتحليل العميق)
async function getHistoricalInsights(tenant, accountId, campaignIds, from, to) {
  return metaGetAll(tenant, `${act(accountId)}/insights`, {
    fields: INSIGHTS_FIELDS, level: 'adset',
    time_range: JSON.stringify({ since: from, until: to }), time_increment: 7,
    filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]),
    limit: 500
  });
}

// توزيع المشتريات حسب ساعات اليوم
async function getHourlyToday(tenant, accountId) {
  return metaGetAll(tenant, `${act(accountId)}/insights`, {
    fields: 'spend,actions', level: 'account', date_preset: 'today',
    breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone', limit: 50
  });
}

// خريطة الساعات: صرف ومشتريات لكل يوم × ساعة (بتوقيت الحساب) — اختيارياً لحملات معينة
async function getHourlyRange(tenant, accountId, from, to, campaignIds = null) {
  const params = {
    fields: 'spend,actions', level: 'account', time_increment: 1,
    time_range: JSON.stringify({ since: from, until: to }),
    breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone', limit: 500
  };
  if (campaignIds?.length) params.filtering = JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]);
  const rows = await metaGetAll(tenant, `${act(accountId)}/insights`, params);
  const { getActionValue } = require('../utils/metrics');
  return rows.map(r => ({
    date: r.date_start,
    hour: parseInt(String(r.hourly_stats_aggregated_by_advertiser_time_zone || '0').slice(0, 2)),
    spend: parseFloat(r.spend || 0),
    purchases: getActionValue(r.actions, 'purchase')
  }));
}

// مستوى الإعلان جوه Ad Set: الأداء + الكريتيف + العمر
async function getAdsOfAdset(tenant, adsetId, from, to) {
  const [ads, rows] = await Promise.all([
    metaGetAll(tenant, `/${adsetId}/ads`, { fields: 'id,name,effective_status,created_time,creative{thumbnail_url}', limit: 100 }, 3),
    metaGetAll(tenant, `/${adsetId}/insights`, {
      fields: 'ad_id,ad_name,spend,impressions,clicks,ctr,cpm,frequency,actions,video_thruplay_watched_actions',
      level: 'ad', time_range: JSON.stringify({ since: from, until: to }), limit: 200
    }, 3)
  ]);
  const { parseInsights } = require('../utils/metrics');
  const byAd = Object.fromEntries(rows.map(r => [r.ad_id, r]));
  return ads.map(a => {
    const m = byAd[a.id] ? parseInsights(byAd[a.id]) : null;
    return {
      id: a.id, name: a.name, status: a.effective_status, createdAt: a.created_time || null,
      thumb: a.creative?.thumbnail_url || null,
      spend: m?.spend || 0, impressions: m?.impressions || 0, clicks: m?.clicks || 0, ctr: m?.ctr || 0,
      frequency: m?.frequency || 0, purchases: m?.purchases || 0,
      cpp: m && m.purchases ? m.spend / m.purchases : null,
      hookRate: m?.hookRate || 0, holdRate: m?.holdRate || 0
    };
  });
}

// نص الإعلانات + Landing Page (للتحليل العميق)
async function getAdCopyAndLanding(tenant, campaignId, max = 3) {
  const adsets = await metaGetAll(tenant, `/${campaignId}/adsets`, { fields: 'id', limit: 3 }, 1);
  const copies = [];
  let landing = null;
  for (const adset of adsets.slice(0, 2)) {
    const ads = await metaGetAll(tenant, `/${adset.id}/ads`, { fields: 'id', limit: 5 }, 1);
    for (const ad of ads.slice(0, 2)) {
      try {
        const d = await metaGet(tenant, `/${ad.id}`, {
          fields: 'creative{body,title,description,object_url,link_url,call_to_action}'
        });
        const c = d.creative || {};
        copies.push({ title: c.title || '', body: c.body || '', cta: c.call_to_action?.type || '' });
        landing ||= c.object_url || c.link_url || null;
      } catch { /* إعلان بدون creative قابل للقراءة */ }
      if (copies.length >= max) return { copies, landing };
    }
  }
  return { copies, landing };
}

module.exports = {
  getActiveAdsets, getAdsetInsightsToday, getCampaignInsights, getActiveCampaigns,
  getHistoricalInsights, getHourlyToday, getAdCopyAndLanding, getHourlyRange, getAdsOfAdset
};
