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

// على مستوى الحملة لفترة (للـ discovery)
async function getCampaignInsights(tenant, accountId, datePreset = 'last_7d') {
  const rows = await metaGetAll(tenant, `${act(accountId)}/insights`, {
    fields: 'campaign_id,campaign_name,spend,actions', level: 'campaign', date_preset: datePreset, limit: 200
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
  getHistoricalInsights, getHourlyToday, getAdCopyAndLanding
};
