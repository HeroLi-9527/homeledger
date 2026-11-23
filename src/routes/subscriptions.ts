import { Hono } from 'hono';
import { nowStr, todayStr } from '../db.js';
import { ledgerWriterIds, notify } from '../lib/auth.js';
import * as fd from '../lib/formdata.js';
import * as subs from '../lib/subscriptions.js';
import * as u from '../lib/util.js';
import { esc } from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { layout } from '../views/layout.js';
import { subscriptionsPage } from '../views/planning.js';
import { bodyOf, dbOf, requireLogin, requireWrite, setFlash, siteMeta, takeFlash, toPublicError } from './helpers.js';

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
  const r = requireLogin(c);
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
      body: subscriptionsPage({ ov, accounts, cats, today: todayStr(), csrf: c.get('csrf') || '' }),
    }),
  );
});

subscriptionsRoutes.get('/subscriptions/:id/edit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const s = await db.get<subs.SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(c.req.param('id')), lid);
  if (!s) return c.redirect('/subscriptions');
  const [accounts, cats] = await Promise.all([fd.accounts(db, lid), fd.flatCategories(db, lid, 'expense')]);
  const csrf = c.get('csrf') || '';
  return c.html(
    layout({
      title: '编辑订阅',
      activeNav: 'subscriptions',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      body: `<div class="card"><form method="post" action="/subscriptions/${s.id}" data-require-trial-end><input type="hidden" name="_csrf" value="${esc(csrf)}">
<div class="grid grid-2">
  <div class="field"><label>名称</label><input name="name" value="${esc(s.name)}" required></div>
  <div class="field"><label>金额（元）</label><input name="amount" inputmode="decimal" value="${(s.amount_cents / 100).toFixed(2)}" required></div>
  <div class="field"><label>周期</label><select name="cycle">${Object.entries(subs.CYCLE_LABEL).map(([k, v]) => `<option value="${k}" ${s.cycle === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
  <div class="field"><label>每 N 个周期</label><input name="cycle_n" type="number" min="1" max="12" value="${s.cycle_n || 1}"></div>
  <div class="field"><label>下次扣费</label><input type="date" name="next_charge_at" value="${esc(s.next_charge_at)}"></div>
  <div class="field"><label>扣费日（锚点）</label><input name="anchor_day" type="number" min="1" max="31" value="${s.anchor_day || ''}"></div>
  <div class="field"><label>试用到期日</label><input type="date" name="trial_ends_on" value="${esc(s.trial_ends_on || '')}"></div>
  <div class="field"><label>状态</label><select name="status"><option value="active" ${s.status === 'active' ? 'selected' : ''}>生效中</option><option value="trial" ${s.status === 'trial' ? 'selected' : ''}>试用中</option><option value="paused" ${s.status === 'paused' ? 'selected' : ''}>已暂停</option></select></div>
  <div class="field"><label>扣费账户</label><select name="account_id"><option value="">—</option>${accounts.map((a) => `<option value="${a.id}" ${Number(s.account_id) === Number(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
  <div class="field"><label>分类</label><select name="category_id"><option value="">—</option>${cats.map((cc) => `<option value="${cc.id}" ${Number(s.category_id) === Number(cc.id) ? 'selected' : ''}>${esc(cc.path)}</option>`).join('')}</select></div>
  <div class="field"><label>套餐</label><input name="plan" value="${esc(s.plan || '')}"></div>
  <div class="field"><label><input type="checkbox" name="auto_renew" ${s.auto_renew ? 'checked' : ''}> 到期自动扣费记账</label></div>
</div>
<div class="row mt12"><button class="btn btn-primary" type="submit">保存</button><a class="btn" href="/subscriptions">取消</a></div></form></div>`,
    }),
  );
});

subscriptionsRoutes.post('/subscriptions', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  try {
    const d = readSubForm(body, ctx.user!.id);
    if (!d.name || !d.amount_cents) throw new Error('请填写订阅名称与金额');
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
  await dbOf(c).run('DELETE FROM subscriptions WHERE id = ? AND ledger_id = ?', Number(c.req.param('id')), ledgerId(c));
  return c.redirect('/subscriptions');
});
