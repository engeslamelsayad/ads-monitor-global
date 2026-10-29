const { tiktokGet, tiktokPost } = require('./client');

// TikTok: الميزانية بالعملة مباشرة (مش بأصغر وحدة)

async function fetchAdgroup(tenant, adv, adgroupId) {
  const d = await tiktokGet(tenant, '/adgroup/get/', {
    advertiser_id: adv,
    filtering: JSON.stringify({ adgroup_ids: [String(adgroupId)] }),
    fields: JSON.stringify(['adgroup_id', 'adgroup_name', 'budget', 'budget_mode'])
  });
  return d.data?.list?.[0] || null;
}

async function pauseAdgroup(tenant, adv, adgroupId) {
  const ag = await fetchAdgroup(tenant, adv, adgroupId);
  if (!ag) throw new Error(`Adgroup ${adgroupId} غير موجود`);
  const name = ag.adgroup_name || '';
  const newName = name.includes('claude edit') ? name : `${name} claude edit`;
  await tiktokPost(tenant, '/adgroup/status/update/', {
    advertiser_id: adv, adgroup_ids: [String(adgroupId)], operation_status: 'DISABLE'
  });
  try {
    await tiktokPost(tenant, '/adgroup/update/', { advertiser_id: adv, adgroup_id: String(adgroupId), adgroup_name: newName });
  } catch (err) { tenant.log.warn(`TikTok rename skipped: ${err.message}`); }
  tenant.log.alert(`TikTok adgroup paused: ${newName}`);
  return { success: true, newName, previousName: name };
}

async function getAdgroupBudget(tenant, adv, adgroupId) {
  const ag = await fetchAdgroup(tenant, adv, adgroupId) || {};
  const budget = parseFloat(ag.budget || 0);
  return { name: ag.adgroup_name, dailyBudget: budget, isCBO: !budget || ag.budget_mode === 'BUDGET_MODE_INFINITE' };
}

async function changeBudget(tenant, adv, adgroupId, pct) {
  const b = await getAdgroupBudget(tenant, adv, adgroupId);
  if (b.isCBO) return { success: false, error: 'الـ Ad Group على ميزانية الحملة (CBO) — عدّل من الحملة' };
  const newBudget = Math.round(b.dailyBudget * (1 + pct / 100) * 100) / 100;
  if (pct < 0 && newBudget < tenant.settings.budgetFloor) {
    return { success: false, error: `الميزانية الجديدة (${newBudget}) أقل من الحد الأدنى (${tenant.settings.budgetFloor})` };
  }
  // البنية الصحيحة: adgroup_budgets كقائمة
  await tiktokPost(tenant, '/adgroup/budget/update/', {
    advertiser_id: adv, adgroup_budgets: [{ adgroup_id: String(adgroupId), budget: newBudget }]
  });
  tenant.log.success(`TikTok budget ${adgroupId}: ${b.dailyBudget} → ${newBudget} (${pct > 0 ? '+' : ''}${pct}%)`);
  return { success: true, oldBudget: b.dailyBudget, newBudget, adsetName: b.name };
}

const reduceBudget = (t, adv, id, pct) => changeBudget(t, adv, id, -Math.max(1, Math.min(90, pct)));
const increaseBudget = (t, adv, id, pct) => changeBudget(t, adv, id, Math.max(1, Math.min(200, pct)));

module.exports = { pauseAdgroup, getAdgroupBudget, reduceBudget, increaseBudget };
