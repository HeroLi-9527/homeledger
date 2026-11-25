import { Hono, type Context } from 'hono';
import { nowStr, todayStr } from '../db.js';
import { canWrite, ledgerWriterIds, notify } from '../lib/auth.js';
import * as fd from '../lib/formdata.js';
import * as subs from '../lib/subscriptions.js';
import * as u from '../lib/util.js';
import { esc } from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { layout, simpleTable } from '../views/layout.js';
import { subscriptionsPage } from '../views/planning.js';
import { bodyOf, dbOf, requireLedger, requireWrite, setFlash, siteMeta, takeFlash, toPublicError } from './helpers.js';
import { assertAccountInLedger, assertCategoryInLedger } from './openapi-helpers.js';

export const subscriptionsRoutes = new Hono<HonoEnv>();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ledgerId = (c: { get: (k: 'ctx') => { ledger: { id: number } | null } }) => Number(c.get('ctx').ledger!.id);

function readSubForm(
  body: Record<string, unknown>,
  userId: number,
  opts: { keepNext?: boolean; oldNext?: string } = {},
) {
  const name = String(body.name || '').trim();
  const amount = u.parseAmountToCents(body.amount);
  const cycle = subs.cycleOf(String(body.cycle || 'monthly'));
  const cycleN = Math.max(1, Math.min(12, Number(body.cycle_n) || 1));
  const anchorMonth = body.anchor_month ? Math.max(1, Math.min(12, Number(body.anchor_month))) : null;
  const trialEnds = DAY_RE.test(String(body.trial_ends_on || '')) ? String(body.trial_ends_on) : null;
  const status = ['trial', 'active', 'paused'].includes(String(body.status)) ? String(body.status) : 'active';
  if (status === 'trial' && !trialEnds) throw new Error('试用中必须填写试用结束日');

  const rawNext = DAY_RE.test(String(body.next_charge_at || '')) ? String(body.next_charge_at) : '';
  let next = '';
  if (opts.keepNext && opts.oldNext) {
    next = rawNext && rawNext !== opts.oldNext ? rawNext : opts.oldNext;
  } else {
    next = rawNext || trialEnds || todayStr();
  }
  const anchorDay = Math.max(1, Math.min(31, Number(body.anchor_day) || Number(next.slice(8, 10))));
  if (status === 'trial' && trialEnds && next < trialEnds) next = trialEnds;
  if (!opts.keepNext || (rawNext && rawNext !== opts.oldNext)) {
    let guard = 0;
    while (next < todayStr() && guard++ < 500) {
      next = subs.advance(next, { cycle, cycle_n: cycleN, anchor_day: anchorDay });
    }
  }

  return {
    name: name.slice(0, 40),
    icon: String(body.icon || '🧾').slice(0, 8) || '🧾',
    plan: body.plan ? String(body.plan).slice(0, 40) : null,
    vendor_url: body.vendor_url ? String(body.vendor_url).slice(0, 200) : null,
    amount_cents: Math.abs(amount),
    currency: String(body.currency || 'CNY'),
    cycle,
    cycle_n: cycleN,
    anchor_month: anchorMonth,
    anchor_day: anchorDay,
    account_id: body.account_id ? Number(body.account_id) : null,
    category_id: body.category_id ? Number(body.category_id) : null,
    auto_renew: body.auto_renew ? 1 : 0,
    trial_ends_on: trialEnds,
    next_charge_at: next,
    reminder_days: Math.max(0, Math.min(60, Number(body.reminder_days ?? 3) || 0)),
    status,
    note: body.note ? String(body.note).slice(0, 200) : null,
    created_by_user_id: userId,
  };
}

subscriptionsRoutes.get('/subscriptions', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const [ov, accounts, cats] = await Promise.all([
    subs.overview(db, lid),
    fd.accounts(db, lid),
    fd.flatCategories(db, lid, 'expense'),
  ]);
  return c.html(
    layout({
      title: '订阅扣费',
      activeNav: 'subscriptions',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: subscriptionsPage({ writable: canWrite(ctx.ledger?.role), ov, accounts, cats, today: todayStr(), csrf: c.get('csrf') || '' }),
    }),
  );
});

async function subscriptionDetails(c: Context<HonoEnv, '/subscriptions/:id' | '/subscriptions/:id/edit'>) {
  const editing = c.req.path.endsWith('/edit');
  const r = editing ? requireWrite(c) : requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const id = Number(c.req.param('id'));
  const s = await db.get<subs.SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', id, lid);
  if (!s) return c.redirect('/subscriptions');
  const [accounts, cats, charges, statRow] = await Promise.all([
    editing ? fd.accounts(db, lid) : [],
    editing ? fd.flatCategories(db, lid, 'expense') : [],
    subs.chargesOf(db, lid, s.id, 50),
    db.get<{ cnt: number; total: number }>(
      'SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_base_cents),0) AS total FROM transactions WHERE ledger_id = ? AND subscription_id = ? AND deleted_at IS NULL',
      lid,
      s.id,
    ),
  ]);
  const csrf = c.get('csrf') || '';
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const chargeRows =
    charges
      .map(
        (ch) => `<tr>
  <td>${esc(ch.txn_date)}</td>
  <td class="num amount">-${u.fmtAmount(ch.amount_base_cents)}</td>
  <td><span class="chip ${ch.status === 'pending' ? 'warn' : 'income'}">${ch.status === 'pending' ? '待确认' : '已入账'}</span></td>
  <td>${esc(ch.note || '—')}</td>
  <td>${canWrite(ctx.ledger?.role) ? `<a class="btn btn-sm" href="/transactions/${ch.id}/edit">查看流水 →</a>` : esc(ch.id)}</td>
</tr>`,
      )
      .join('') || '<tr><td colspan="5">暂无历史扣费流水</td></tr>';

  return c.html(
    layout({
      title: editing ? '编辑订阅' : '订阅扣费历史',
      activeNav: 'subscriptions',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `${editing ? `<div class="card mb16"><div class="card-head"><b>编辑订阅：${esc(s.name)}</b><form method="post" action="/subscriptions/${s.id}/delete" style="display:inline" data-confirm="确认永久删除该订阅？（不会删除已生成的历史扣费流水）">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除订阅</button></form></div>
<form method="post" action="/subscriptions/${s.id}" data-require-trial-end>${csrfInput}
<div class="grid grid-2">
  <div class="field"><label>名称</label><input name="name" value="${esc(s.name)}" required></div>
  <div class="field"><label>图标</label><input name="icon" value="${esc(s.icon || '🧾')}" maxlength="8"></div>
  <div class="field"><label>金额（元）</label><input name="amount" inputmode="decimal" value="${(s.amount_cents / 100).toFixed(2)}" required></div>
  <div class="field"><label>币种</label><input name="currency" value="${esc(s.currency || 'CNY')}" maxlength="8"></div>
  <div class="field"><label>周期</label><select name="cycle">${Object.entries(subs.CYCLE_LABEL).map(([k, v]) => `<option value="${k}" ${s.cycle === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
  <div class="field"><label>每 N 个周期</label><input name="cycle_n" type="number" min="1" max="12" value="${s.cycle_n || 1}"></div>
  <div class="field"><label>下次扣费</label><input type="date" name="next_charge_at" value="${esc(s.next_charge_at)}"></div>
  <div class="field"><label>扣费日（锚点 1-31）</label><input name="anchor_day" type="number" min="1" max="31" value="${s.anchor_day || ''}"></div>
  <div class="field"><label>年付扣费月（1-12）</label><input name="anchor_month" type="number" min="1" max="12" value="${s.anchor_month ?? ''}"></div>
  <div class="field"><label>试用到期日</label><input type="date" name="trial_ends_on" value="${esc(s.trial_ends_on || '')}"></div>
  <div class="field"><label>状态</label><select name="status"><option value="active" ${s.status === 'active' ? 'selected' : ''}>生效中</option><option value="trial" ${s.status === 'trial' ? 'selected' : ''}>试用中</option><option value="paused" ${s.status === 'paused' ? 'selected' : ''}>已暂停</option></select></div>
  <div class="field"><label>扣费账户</label><select name="account_id"><option value="">—</option>${accounts.map((a) => `<option value="${a.id}" ${Number(s.account_id) === Number(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
  <div class="field"><label>分类</label><select name="category_id"><option value="">—</option>${cats.map((cc) => `<option value="${cc.id}" ${Number(s.category_id) === Number(cc.id) ? 'selected' : ''}>${esc(cc.path)}</option>`).join('')}</select></div>
  <div class="field"><label>套餐</label><input name="plan" value="${esc(s.plan || '')}"></div>
  <div class="field"><label>提前提醒天数</label><input name="reminder_days" type="number" min="0" max="60" value="${Number(s.reminder_days ?? 3)}"></div>
  <div class="field"><label>官网 / 退订链接${s.vendor_url && /^https?:\/\//i.test(s.vendor_url) ? ` <a href="${esc(s.vendor_url)}" target="_blank" rel="noopener noreferrer">打开 ↗</a>` : ''}</label><input name="vendor_url" type="url" value="${esc(s.vendor_url || '')}" maxlength="200"></div>
  <div class="field"><label>备注</label><input name="note" value="${esc(s.note || '')}"></div>
  <div class="field" style="justify-content:flex-end"><label class="check"><input type="checkbox" name="auto_renew" ${s.auto_renew ? 'checked' : ''}> 到期自动扣费记账</label></div>
</div>
<div class="row mt12"><button class="btn btn-primary" type="submit">保存</button><a class="btn" href="/subscriptions">取消</a></div></form></div>` : `<div class="between mb16"><h2>${esc(s.name)}</h2><a href="/subscriptions">返回订阅</a></div>`}
${simpleTable('历史扣费记录', ['扣费日期', '本位币金额', '状态', '备注', '操作'], chargeRows, `<span class="muted small amount">累计 ${Number(statRow?.cnt || 0)} 期 · 合计 ${u.fmtAmount(Number(statRow?.total || 0))}</span>`)}`,
    }),
  );
}

subscriptionsRoutes.get('/subscriptions/:id', subscriptionDetails);
subscriptionsRoutes.get('/subscriptions/:id/edit', subscriptionDetails);

subscriptionsRoutes.post('/subscriptions', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  try {
    const d = readSubForm(body, ctx.user!.id);
    if (!d.name || !d.amount_cents) throw new Error('请填写订阅名称与金额');
    if (d.account_id !== null) await assertAccountInLedger(db, ledgerId(c), d.account_id);
    if (d.category_id !== null) await assertCategoryInLedger(db, ledgerId(c), d.category_id, 'expense');
    await db.run(
      `INSERT INTO subscriptions (ledger_id, name, icon, plan, vendor_url, amount_cents, currency, cycle, cycle_n,
        anchor_month, anchor_day, account_id, category_id, auto_renew, trial_ends_on, next_charge_at,
        reminder_days, status, note, created_by_user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ledgerId(c),
      d.name,
      d.icon,
      d.plan,
      d.vendor_url,
      d.amount_cents,
      d.currency,
      d.cycle,
      d.cycle_n,
      d.anchor_month,
      d.anchor_day,
      d.account_id,
      d.category_id,
      d.auto_renew,
      d.trial_ends_on,
      d.next_charge_at,
      d.reminder_days,
      d.status,
      d.note,
      d.created_by_user_id,
      nowStr(),
    );
    setFlash(c, 'success', `订阅「${d.name}」已添加`);
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
  }
  return c.redirect('/subscriptions');
});

subscriptionsRoutes.post('/subscriptions/:id', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const id = Number(c.req.param('id'));
  const old = await db.get<subs.SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', id, ledgerId(c));
  if (!old) return c.redirect('/subscriptions');
  try {
    const d = readSubForm(body, ctx.user!.id, { keepNext: true, oldNext: old.next_charge_at });
    if (!d.name || !d.amount_cents) throw new Error('名称与金额不能为空');
    if (d.account_id !== null) {
      await assertAccountInLedger(db, ledgerId(c), d.account_id, {
        allowArchived: d.account_id === old.account_id,
      });
    }
    if (d.category_id !== null) {
      await assertCategoryInLedger(db, ledgerId(c), d.category_id, 'expense', {
        allowArchived: d.category_id === old.category_id,
      });
    }
    await db.run(
      `UPDATE subscriptions SET name=?, icon=?, plan=?, vendor_url=?, amount_cents=?, currency=?, cycle=?, cycle_n=?,
        anchor_month=?, anchor_day=?, account_id=?, category_id=?, auto_renew=?, trial_ends_on=?, next_charge_at=?,
        reminder_days=?, status=?, note=? WHERE id=? AND ledger_id=?`,
      d.name,
      d.icon,
      d.plan,
      d.vendor_url,
      d.amount_cents,
      d.currency,
      d.cycle,
      d.cycle_n,
      d.anchor_month,
      d.anchor_day,
      d.account_id,
      d.category_id,
      d.auto_renew,
      d.trial_ends_on,
      d.next_charge_at,
      d.reminder_days,
      d.status,
      d.note,
      id,
      ledgerId(c),
    );
    setFlash(c, 'success', '订阅已更新');
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
  }
  return c.redirect('/subscriptions');
});

subscriptionsRoutes.post('/subscriptions/:id/charge', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const s = await db.get<subs.SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(c.req.param('id')), ledgerId(c));
  if (!s) return c.redirect('/subscriptions');
  if (!['active', 'trial'].includes(s.status)) {
    setFlash(c, 'error', '已暂停或取消的订阅无法扣费');
    return c.redirect('/subscriptions');
  }
  if (s.status === 'trial' && s.trial_ends_on && s.trial_ends_on > todayStr()) {
    setFlash(c, 'error', `订阅仍在试用期（到期日 ${s.trial_ends_on}），暂不可手动扣费`);
    return c.redirect('/subscriptions');
  }
  const period = DAY_RE.test(String(body.next_charge_at || '')) ? String(body.next_charge_at) : s.next_charge_at;
  const next = subs.advance(period, s);
  const claim = await db.run('UPDATE subscriptions SET next_charge_at = ? WHERE id = ? AND next_charge_at = ?', next, s.id, period);
  if (claim.changes !== 1) {
    setFlash(c, 'error', '该期已扣费，请勿重复提交');
    return c.redirect('/subscriptions');
  }
  try {
    await subs.charge(db, { ...s, next_charge_at: period }, ctx.user!.id, {
      date: period,
      expectedNextChargeAt: next,
      prevLastChargeAt: s.last_charge_at ?? null,
    });
    setFlash(c, 'success', `已扣费入账（${period}）`);
  } catch (e) {
    const rb = await db.run('UPDATE subscriptions SET next_charge_at = ? WHERE id = ? AND next_charge_at = ?', period, s.id, next).catch(() => null);
    if (!rb || rb.changes !== 1) {
      const key = `sub-rollback-fail:${s.id}:${period}`;
      for (const uid of await ledgerWriterIds(db, s.ledger_id)) {
        await notify(db, uid, {
          kind: 'danger',
          ledgerId: s.ledger_id,
          title: `订阅扣费异常：${s.name}（${period}）`,
          body: `${period} 一期扣费失败且抢占回滚失败，请检查订阅与流水`,
          link: '/subscriptions',
          dedupeKey: key,
        });
      }
    }
    setFlash(c, 'error', `扣费失败：${toPublicError(e)}`);
  }
  return c.redirect('/subscriptions');
});

subscriptionsRoutes.post('/subscriptions/:id/skip', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const s = await db.get<subs.SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(c.req.param('id')), ledgerId(c));
  if (s) {
    const period = DAY_RE.test(String(body.next_charge_at || '')) ? String(body.next_charge_at) : s.next_charge_at;
    const next = subs.advance(period, s);
    await db.run('UPDATE subscriptions SET next_charge_at = ? WHERE id = ? AND next_charge_at = ?', next, s.id, period);
    setFlash(c, 'success', `已跳过本期，下次扣费顺延至 ${next}`);
  }
  return c.redirect('/subscriptions');
});

subscriptionsRoutes.post('/subscriptions/:id/toggle', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const s = await db.get<subs.SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(c.req.param('id')), ledgerId(c));
  if (s) {
    const back = s.status === 'paused' || s.status === 'canceled';
    let next = s.next_charge_at;
    if (back && next && next < todayStr()) {
      next = subs.firstChargeDate({
        cycle: s.cycle,
        cycle_n: s.cycle_n,
        anchor_month: s.anchor_month,
        anchor_day: s.anchor_day,
        startFrom: todayStr(),
      });
    }
    const restoreStatus = back && s.trial_ends_on && s.trial_ends_on > todayStr() ? 'trial' : 'active';
    await db.run(
      'UPDATE subscriptions SET status = ?, next_charge_at = ?, canceled_at = ? WHERE id = ?',
      back ? restoreStatus : 'paused',
      next,
      back ? null : s.canceled_at,
      s.id,
    );
  }
  return c.redirect('/subscriptions');
});

subscriptionsRoutes.post('/subscriptions/:id/cancel', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  await dbOf(c).run(
    "UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE id = ? AND ledger_id = ?",
    nowStr(),
    Number(c.req.param('id')),
    ledgerId(c),
  );
  return c.redirect('/subscriptions');
});

subscriptionsRoutes.post('/subscriptions/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const res = await dbOf(c).run(
    'DELETE FROM subscriptions WHERE id = ? AND ledger_id = ?',
    Number(c.req.param('id')),
    ledgerId(c),
  );
  setFlash(c, res.changes ? 'success' : 'error', res.changes ? '订阅已删除（历史扣费流水已保留）' : '订阅不存在');
  return c.redirect('/subscriptions');
});
