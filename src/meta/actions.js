const { metaGet, metaPost } = require('./client');

// Meta: الميزانيات بأصغر وحدة للعملة (قرش) — نحوّل بـ /100

async function pauseAdset(tenant, adsetId) {
  const a = await metaGet(tenant, `/${adsetId}`, { fields: 'name' });
  const name = a.name || '';
  const newName = name.includes('claude edit') ? name : `${name} claude edit`;
  await metaPost(tenant, `/${adsetId}`, { status: 'PAUSED', name: newName });
  tenant.log.alert(`Paused adset: ${newName} (${adsetId})`);
  return { success: true, newName, previousName: name };
}

async function getAdsetBudget(tenant, adsetId) {
  const d = await metaGet(tenant, `/${adsetId}`, { fields: 'name,daily_budget,lifetime_budget,status' });
  const minor = parseInt(d.daily_budget || 0);
  return { name: d.name, dailyBudget: minor / 100, dailyBudgetMinor: minor, isCBO: !minor };
}

async function changeBudget(tenant, adsetId, pct) {
  const b = await getAdsetBudget(tenant, adsetId);
  if (!b.dailyBudgetMinor) {
    return { success: false, error: 'لا يوجد daily budget للـ Ad Set (الميزانية على مستوى الحملة CBO)' };
  }
  const floorMinor = Math.round(tenant.settings.budgetFloor * 100);
  const newMinor = Math.round(b.dailyBudgetMinor * (1 + pct / 100));
  if (pct < 0 && newMinor < floorMinor) {
    return { success: false, error: `الميزانية الجديدة (${(newMinor / 100).toFixed(2)}) أقل من الحد الأدنى (${tenant.settings.budgetFloor})` };
  }
  await metaPost(tenant, `/${adsetId}`, { daily_budget: newMinor });
  tenant.log.success(`Budget ${adsetId}: ${b.dailyBudget} → ${newMinor / 100} (${pct > 0 ? '+' : ''}${pct}%)`);
  return { success: true, oldBudget: b.dailyBudget, newBudget: newMinor / 100, adsetName: b.name };
}

const reduceBudget = (tenant, id, pct) => changeBudget(tenant, id, -Math.max(1, Math.min(90, pct)));
const increaseBudget = (tenant, id, pct) => changeBudget(tenant, id, Math.max(1, Math.min(200, pct)));

module.exports = { pauseAdset, getAdsetBudget, reduceBudget, increaseBudget };
