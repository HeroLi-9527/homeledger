import { Hono } from 'hono';
import { todayStr } from '../db.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { layout } from '../views/layout.js';
import { reportsPage } from '../views/reports.js';
import { dbOf, requireLogin, siteMeta, takeFlash } from './helpers.js';

export const reportsRoutes = new Hono<HonoEnv>();

export function parseReportRange(q: Record<string, string | undefined>) {
  const today = todayStr();
  const defMonth = today.slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? String(q.month) : defMonth;
  const preset = ['month', 'quarter', 'year', 'all'].includes(String(q.preset)) ? String(q.preset) : 'month';

  if (preset === 'quarter') {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const qi = Math.floor((m - 1) / 3);
    const sm = qi * 3 + 1;
    const em = qi * 3 + 3;
    const start = `${y}-${u.pad(sm)}-01`;
    const end = u.monthEnd(`${y}-${u.pad(em)}`);
    return { start, end, label: `${y}年 Q${qi + 1}`, preset, month };
  }
  if (preset === 'year') {
    const y = month.slice(0, 4);
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}全年`, preset, month };
  }
  if (preset === 'all') {
    return { start: '1970-01-01', end: '2099-12-31', label: '全部历史', preset, month };
  }
  return {
    start: `${month}-01`,
    end: u.monthEnd(month),
    label: u.monthLabel(month),
    preset: 'month',
    month,
  };
}

reportsRoutes.get('/reports', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  if (!ctx.ledger) return c.redirect('/');

  const ledgerId = Number(ctx.ledger.id);
  const q = c.req.query();
  const range = parseReportRange(q);
  const kind: 'expense' | 'income' = q.kind === 'income' ? 'income' : 'expense';
  const heatmapMonth = range.month || todayStr().slice(0, 7);
  const prevM = u.addMonths(heatmapMonth, -1);
  const lastYearM = u.addMonths(heatmapMonth, -12);

  const [sum, cats, subcats, trend, days, members, netWorth, overview, expRow, prevSum, lastYearSum] =
    await Promise.all([
      txn.summary(db, ledgerId, range.start, range.end),
      txn.categoryBreakdown(db, ledgerId, range.start, range.end, kind),
      txn.subcategoryBreakdown(db, ledgerId, range.start, range.end, kind, q.cat || null),
      txn.monthlyTrend(db, ledgerId, 12),
      txn.dailyBreakdown(db, ledgerId, `${heatmapMonth}-01`, u.monthEnd(heatmapMonth)),
      txn.memberBreakdown(db, ledgerId, range.start, range.end),
      txn.netWorthTrend(db, ledgerId, 12),
      txn.accountOverview(db, ledgerId),
      db.get<{ c: number; avg: number }>(
        `SELECT COUNT(*) AS c, COALESCE(AVG(amount_base_cents),0) AS avg
         FROM transactions
         WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ? AND type IN ('expense','fee')`,
        ledgerId,
        range.start,
        range.end,
      ),
      range.preset === 'month' ? txn.summary(db, ledgerId, `${prevM}-01`, u.monthEnd(prevM)) : Promise.resolve(null),
      range.preset === 'month' ? txn.summary(db, ledgerId, `${lastYearM}-01`, u.monthEnd(lastYearM)) : Promise.resolve(null),
    ]);

  const compare =
    range.preset === 'month' && prevSum && lastYearSum
      ? {
          prevMonth: { label: prevM, income: prevSum.income, expense: prevSum.expense },
          lastYear: { label: lastYearM, income: lastYearSum.income, expense: lastYearSum.expense },
        }
      : null;

  const linkWith = (overrides: Record<string, string>, opts?: { keepPeriod?: boolean }) => {
    const next = new URLSearchParams();
    if (opts?.keepPeriod !== false && q.preset) next.set('preset', q.preset);
    if (opts?.keepPeriod !== false && q.month) next.set('month', q.month);
    if (q.kind) next.set('kind', q.kind);
    for (const [k, v] of Object.entries(overrides)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    return qs ? `/reports?${qs}` : '/reports';
  };

  return c.html(
    layout({
      title: '报表分析',
      activeNav: 'reports',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: reportsPage({
        range,
        kind,
        sum,
        compare,
        cats,
        subcats,
        trend,
        days,
        members,
        netWorth,
        overview,
        expenseCount: { c: Number(expRow?.c || 0), avg: Number(expRow?.avg || 0) },
        heatmapMonth,
        linkWith,
      }),
    }),
  );
});
