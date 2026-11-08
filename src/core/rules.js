const crypto = require('crypto');
const actions = require('./actions');

// القواعد التلقائية — العميل بيكتبها من الداشبورد، وبتتقيّم في كل دورة على كل Ad Set متطابق
// مثال: "لو CPP فوق 130% من Max لمدة يومين → قلل الميزانية 30% وبلغني"

const CONDITIONS = {
  cpp_above: { label: 'CPP فوق', unit: '% من Max CPP', min: 100, max: 500, daysAllowed: true },
  cpp_below: { label: 'CPP تحت', unit: '% من Max CPP', min: 10, max: 100, daysAllowed: true },
  spend_no_sales: { label: 'صرف من غير ولا بيعة', unit: '% من Max CPP', min: 50, max: 1000, daysAllowed: false }
};
const ACTIONS = {
  budget_down: 'قلل الميزانية',
  budget_up: 'ارفع الميزانية',
  pause: 'أوقف الـ Ad Set',
  notify: 'بلغني بس'
};
const MAX_AUTO_UP = 50; // أقصى رفع تلقائي في المرة الواحدة

class RuleError extends Error { constructor(m) { super(m); this.status = 400; this.expose = true; } }

function validateRule(t, input, existing = {}) {
  const r = { ...existing, ...input };
  const out = {
    id: existing.id || `r${crypto.randomBytes(4).toString('hex')}`,
    name: String(r.name || '').trim().slice(0, 60),
    enabled: r.enabled !== false,
    product: r.product ? String(r.product) : null,
    condition: r.condition,
    threshold: parseFloat(r.threshold),
    days: parseInt(r.days) || 1,
    action: r.action,
    pct: r.action === 'budget_down' || r.action === 'budget_up' ? parseInt(r.pct) : null,
    mode: r.mode === 'auto' ? 'auto' : 'confirm',
    cooldownHours: parseInt(r.cooldownHours) || 24,
    createdAt: existing.createdAt || Date.now()
  };
  const c = CONDITIONS[out.condition];
  if (!c) throw new RuleError('اختار الشرط');
  if (!ACTIONS[out.action]) throw new RuleError('اختار الإجراء');
  if (isNaN(out.threshold) || out.threshold < c.min || out.threshold > c.max) throw new RuleError(`النسبة لازم تكون بين ${c.min}% و ${c.max}%`);
  if (!c.daysAllowed) out.days = 1;
  if (out.days < 1 || out.days > 7) throw new RuleError('عدد الأيام من 1 لـ 7');
  if (out.product && !t.products.some(p => p.name === out.product)) throw new RuleError('المنتج مش موجود');
  if (out.pct != null) {
    if (isNaN(out.pct) || out.pct < 5 || out.pct > (out.action === 'budget_down' ? 90 : 200)) throw new RuleError('نسبة الميزانية غير صالحة');
    if (out.action === 'budget_up' && out.mode === 'auto' && out.pct > MAX_AUTO_UP) throw new RuleError(`الرفع التلقائي أقصاه ${MAX_AUTO_UP}% — أو خليه بتأكيد`);
  }
  if (out.action === 'notify') out.mode = 'auto';
  if (out.cooldownHours < 1 || out.cooldownHours > 168) throw new RuleError('الانتظار بين مرتين من 1 لـ 168 ساعة');
  if (!out.name) out.name = describeCondition(out);
  return out;
}

function describeCondition(r) {
  const c = CONDITIONS[r.condition];
  const daysTxt = c?.daysAllowed && r.days > 1 ? ` لمدة ${r.days} أيام متتالية` : '';
  return `${c?.label || r.condition} ${r.threshold}%${daysTxt}`;
}
function describeAction(r) {
  return r.pct ? `${ACTIONS[r.action]} ${r.pct}%` : ACTIONS[r.action];
}

// هل الشرط متحقق؟ history = صفوف الـ Ad Set مرتبة بالتاريخ (آخرها النهارده)
function conditionMet(rule, history, maxCpp, settings) {
  if (!maxCpp) return false;
  const lim = maxCpp * rule.threshold / 100;
  const days = rule.days || 1;
  const recent = history.slice(-days);
  if (recent.length < days) return false;
  // الأيام لازم تكون متتالية
  for (let i = 1; i < recent.length; i++) {
    if ((Date.parse(recent[i].date) - Date.parse(recent[i - 1].date)) !== 86400000) return false;
  }
  return recent.every(r => {
    const sp = r.spend || 0, pu = r.purchases || 0;
    if (rule.condition === 'cpp_above') return pu > 0 ? sp / pu > lim : sp > lim;
    if (rule.condition === 'cpp_below') return pu >= (settings.minPurchases || 1) && sp / pu < lim;
    if (rule.condition === 'spend_no_sales') return pu === 0 && sp >= lim;
    return false;
  });
}

// بيتنادي من الدورة بعد حفظ أرقام النهارده
async function evaluate(t, items) {
  const rules = t.rules.filter(r => r.enabled);
  if (!rules.length) return { fired: 0 };
  const { send } = require('../telegram/messenger');
  const s = t.settings;
  let fired = 0;
  const today = t.today();

  for (const it of items) {
    const hist = t.db.getAdsetHistory(it.adsetKey, t.daysAgo(7)).filter(r => r.date <= today);
    if (!hist.length || hist[hist.length - 1].date !== today) continue;
    for (const rule of rules) {
      if (rule.product && rule.product !== it.product.name) continue;
      if (!conditionMet(rule, hist, it.product.maxCpp, s)) continue;
      const type = `rule:${rule.id}`;
      if (t.db.wasAlertedRecently(it.adsetKey, it.product.name, type, rule.cooldownHours * 3600000)) continue;
      t.db.logAlert(it.product.name, it.adsetKey, type, rule.name);
      fired++;

      const ctx = {
        platform: it.platform, accountId: it.accountId, adsetId: it.adsetKey, adsetName: it.adset.name,
        campaignId: it.campaign.id, campaignName: it.campaign.name, productName: it.product.name, dailyBudget: it.adset.dailyBudget
      };
      const m = it.metrics;
      const facts = `${it.product.name} | النهارده: صرف ${Math.round(m.spend)} ${t.currency} | مبيعات ${m.purchases} | CPP ${m.purchases ? Math.round(m.spend / m.purchases) : '—'} (Max ${it.product.maxCpp})`;
      const head = `📐 قاعدة: ${rule.name}\nالشرط: ${describeCondition(rule)}\nالإجراء: ${describeAction(rule)}${rule.mode === 'auto' ? ' (تلقائي)' : ''}\n\n📑 ${ctx.adsetName}\n📦 ${facts}`;

      try {
        if (rule.action === 'notify') {
          for (const cid of t.users) await send(t, cid, head, { plain: true }).catch(() => {});
        } else if (rule.mode === 'auto') {
          const actor = { via: 'rule', chatId: rule.name, note: describeCondition(rule) };
          if (rule.action === 'pause') await actions.pause(t, ctx, actor, { log: { rule: rule.id } });
          else {
            const r = await actions.changeBudget(t, ctx, rule.action === 'budget_up' ? rule.pct : -rule.pct, actor, { log: { rule: rule.id } });
            if (!r.success) for (const cid of t.users) await send(t, cid, `${head}\n\n⚠️ ما اتنفذش: ${r.error}`, { plain: true }).catch(() => {});
          }
        } else {
          const key = t.storeContext({ ...ctx, ruleId: rule.id, ruleName: rule.name, ruleAction: rule.action, rulePct: rule.pct });
          const btn = rule.action === 'pause' ? '⏸ أوقفه' : `${rule.action === 'budget_up' ? '🚀 ارفع' : '💰 قلل'} ${rule.pct}%`;
          for (const cid of t.users) {
            await send(t, cid, `${head}\n\nتنفّذ؟`, { plain: true, reply_markup: { inline_keyboard: [[
              { text: `✅ ${btn}`, callback_data: `rl:${key}` }, { text: '❌ تجاهل', callback_data: 'cancel' }]] } }).catch(() => {});
          }
        }
      } catch (err) { t.log.error(`Rule ${rule.name} failed`, err); }
    }
  }
  if (fired) t.log.info(`Rules fired: ${fired}`);
  return { fired };
}

// تنفيذ قاعدة بعد التأكيد من Telegram
async function applyConfirmed(t, ctx, chatId) {
  const actor = { via: 'telegram', chatId: String(chatId) };
  const log = { log: { rule: ctx.ruleId } };
  if (ctx.ruleAction === 'pause') {
    const r = await actions.pause(t, ctx, actor, log);
    return `✅ اتوقف\n📑 ${r.newName}`;
  }
  const r = await actions.changeBudget(t, ctx, ctx.ruleAction === 'budget_up' ? ctx.rulePct : -ctx.rulePct, actor, log);
  if (!r.success) return `❌ ${r.error}`;
  return `✅ الميزانية اتغيرت\n📑 ${r.adsetName}\nمن ${Number(r.oldBudget).toFixed(0)} لـ ${Number(r.newBudget).toFixed(0)} ${t.currency}`;
}

module.exports = { CONDITIONS, ACTIONS, MAX_AUTO_UP, validateRule, conditionMet, evaluate, applyConfirmed, describeCondition, describeAction };
