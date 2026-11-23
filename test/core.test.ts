import assert from 'node:assert/strict';
import test from 'node:test';
import { accountGroupOf, balanceDeltaStmts, isCreditGroupType, txnEffects } from '../src/db.js';
import { creditMetrics, nextMonthlyDay } from '../src/lib/accounts.js';
import { parseTextByRules } from '../src/lib/ai.js';
import {
  createSessionPayload,
  hashPassword,
  needsRefresh,
  REFRESH_THRESHOLD_MS,
  signSession,
  verifyPassword,
  verifySession,
} from '../src/lib/auth.js';
import { barChart, donutChart, heatmapChart, lineChart } from '../src/lib/charts.js';
import { advanceDate } from '../src/lib/scheduler.js';
import { decorateCard } from '../src/lib/session-cards.js';
import { advance, firstChargeDate } from '../src/lib/subscriptions.js';

test('PBKDF2 密码哈希与校验', async () => {
  const hash = await hashPassword('secret-pass-123');
  assert.ok(hash.startsWith('pbkdf2$100000$'));
  assert.equal(await verifyPassword('secret-pass-123', hash), true);
  assert.equal(await verifyPassword('wrong-pass', hash), false);
  assert.equal(await verifyPassword('secret-pass-123', 'scrypt$16384$8$1$abc$def'), false);
});

test('无状态 HMAC 会话签发、验签、篡改/过期拒绝与续期阈值', async () => {
  const secret = 'test-session-secret-with-32-plus-bytes';
  const now = 1_700_000_000_000;
  const payload = createSessionPayload(7, 2, 3, 'csrf-tok', now);
  const token = await signSession(payload, secret);

  const verified = await verifySession(token, secret, now + 1000);
  assert.deepEqual(verified, payload);

  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(await verifySession(tampered, secret, now + 1000), null);
  assert.equal(await verifySession(token, 'another-wrong-secret-123456', now + 1000), null);
  assert.equal(await verifySession(token, secret, payload.exp + 1), null);

  assert.equal(needsRefresh(payload, now + 1000), false);
  assert.equal(needsRefresh(payload, payload.exp - REFRESH_THRESHOLD_MS + 1000), true);
});

test('14 种交易类型 txnEffects 与 balanceDeltaStmts', () => {
  const cases: Array<[string, number, number | null, number | null, Array<[number, number]>]> = [
    ['expense', 500, 1, null, [[1, -500]]],
    ['income', 1000, 1, null, [[1, 1000]]],
    ['transfer', 300, 1, 2, [[1, -300], [2, 300]]],
    ['lend', 200, 1, null, [[1, -200]]],
    ['borrow', 200, 1, null, [[1, 200]]],
    ['repay_receive', 150, 1, null, [[1, 150]]],
    ['repay_pay', 150, 1, null, [[1, -150]]],
    ['reimburse', 400, 1, null, [[1, 400]]],
    ['refund', 80, 1, null, [[1, 80]]],
    ['fee', 10, 1, null, [[1, -10]]],
    ['interest', 25, 1, null, [[1, 25]]],
    ['invest_buy', 1000, 1, 3, [[1, -1000], [3, 1000]]],
    ['invest_sell', 1200, 1, 3, [[3, -1200], [1, 1200]]],
    ['adjust', -75, 1, null, [[1, -75]]],
  ];

  for (const [type, amount_base_cents, account_id, to_account_id, expected] of cases) {
    const got = txnEffects({ type, amount_base_cents, account_id, to_account_id }).map((e) => [e.accountId, e.delta]);
    assert.deepEqual(got, expected, `type=${type}`);
  }

  const stmts = balanceDeltaStmts([
    [{ type: 'expense', amount_base_cents: 500, account_id: 1, to_account_id: null }, 1],
    [{ type: 'expense', amount_base_cents: 500, account_id: 1, to_account_id: null }, -1],
    [{ type: 'transfer', amount_base_cents: 200, account_id: 1, to_account_id: 2 }, 1],
  ]);
  assert.deepEqual(stmts, [
    ['UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?', [-200, 1]],
    ['UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?', [200, 2]],
  ]);
});

test('离线 AI 规则引擎解析中文文本', () => {
  const lunch = parseTextByRules('午饭 35 元', { today: '2026-11-23' });
  assert.equal(lunch.length, 1);
  assert.equal(lunch[0].type, 'expense');
  assert.equal(lunch[0].amount_cents, 3500);
  assert.equal(lunch[0].category_name, '午餐');
  assert.equal(lunch[0].txn_date, '2026-11-23');

  const salary = parseTextByRules('昨天发工资 15000 元 到银行卡', { today: '2026-11-23' });
  assert.equal(salary.length, 1);
  assert.equal(salary[0].type, 'income');
  assert.equal(salary[0].amount_cents, 1500000);
  assert.equal(salary[0].category_name, '工资');
  assert.equal(salary[0].account_name, '银行卡');
  assert.equal(salary[0].txn_date, '2026-11-22');
});

test('订阅与周期账单月末锚点推进', () => {
  assert.equal(advance('2026-01-31', { cycle: 'monthly', cycle_n: 1, anchor_day: 31 }), '2026-02-28');
  assert.equal(advance('2026-02-28', { cycle: 'monthly', cycle_n: 1, anchor_day: 31 }), '2026-03-31');
  assert.equal(advance('2024-01-31', { cycle: 'monthly', cycle_n: 1, anchor_day: 31 }), '2024-02-29');
  assert.equal(firstChargeDate({ cycle: 'yearly', anchor_month: 3, anchor_day: 15, startFrom: '2026-04-01' }), '2027-03-15');
  assert.equal(advanceDate('2026-01-31', { frequency: 'monthly', interval_n: 1, day_of_month: 31 }), '2026-02-28');
  assert.equal(advanceDate('2026-02-28', { frequency: 'monthly', interval_n: 1, day_of_month: 31 }), '2026-03-31');
});

test('服务端 SVG 图表输出合法 SVG', () => {
  const bar = barChart({
    labels: ['10月', '11月'],
    series: [{ name: '支出', color: '#f5222d', data: [1200, 950] }],
  });
  assert.ok(bar.startsWith('<svg') && bar.endsWith('</svg>'));

  const line = lineChart({
    labels: ['10月', '11月'],
    series: [{ name: '净资产', color: '#4f7cff', data: [10000, 12500] }],
  });
  assert.ok(line.startsWith('<svg') && line.includes('<polyline') && line.endsWith('</svg>'));

  const donut = donutChart(
    [{ name: '餐饮', value: 800, color: '#ff7a45' }],
    { centerValue: '¥800', centerTitle: '总支出' },
  );
  assert.ok(donut.startsWith('<svg') && donut.includes('<circle') && donut.endsWith('</svg>'));

  const heat = heatmapChart({
    month: '2026-11',
    days: [{ date: '2026-11-23', expense: 3500, income: 0, count: 1 }],
  });
  assert.ok(heat.startsWith('<svg') && heat.includes('2026-11-23') && heat.endsWith('</svg>'));
});

test('账户三层分组、账单/还款日月末截断与信用额度计算', () => {
  assert.equal(accountGroupOf('cash'), 'funds');
  assert.equal(accountGroupOf('virtual'), 'funds');
  assert.equal(accountGroupOf('prepaid'), 'prepaid');
  assert.equal(accountGroupOf('credit'), 'credit');
  assert.equal(accountGroupOf('loan'), 'credit');
  assert.equal(isCreditGroupType('credit'), true);
  assert.equal(isCreditGroupType('debit'), false);

  assert.deepEqual(nextMonthlyDay(31, '2026-02-15'), {
    date: '2026-02-28',
    daysUntil: 13,
    cycleKey: '2026-02-28',
  });
  assert.deepEqual(nextMonthlyDay(31, '2024-02-29'), {
    date: '2024-02-29',
    daysUntil: 0,
    cycleKey: '2024-02-29',
  });
  assert.deepEqual(nextMonthlyDay(5, '2026-12-20'), {
    date: '2027-01-05',
    daysUntil: 16,
    cycleKey: '2027-01-05',
  });
  assert.equal(nextMonthlyDay(null, '2026-11-23'), null);

  const m1 = creditMetrics(
    { balance_cents: -250000, credit_limit: 1000000, bill_day: 5, due_day: 25 },
    '2026-11-23',
  );
  assert.equal(m1.debtCents, 250000);
  assert.equal(m1.overflowCents, 0);
  assert.equal(m1.availableCents, 750000);
  assert.equal(m1.usagePct, 25);
  assert.equal(m1.nextDue?.daysUntil, 2);

  const m2 = creditMetrics(
    { balance_cents: 5000, credit_limit: 100000, bill_day: null, due_day: null },
    '2026-11-23',
  );
  assert.equal(m2.debtCents, 0);
  assert.equal(m2.overflowCents, 5000);
  assert.equal(m2.availableCents, 105000);
  assert.equal(m2.usagePct, 0);
});

test('次卡状态派生与单次成本计算', () => {
  const base = {
    id: 1,
    ledger_id: 1,
    name: '洗车卡',
    icon: '🚿',
    merchant: '途虎',
    total_sessions: 10,
    remaining_sessions: 2,
    total_cost_cents: 50000,
    currency: 'CNY',
    purchase_date: '2026-10-01',
    expires_at: '2026-11-28',
    purchase_txn_id: 10,
    is_archived: 0,
    note: null,
    created_at: '2026-10-01 10:00:00',
    updated_at: '2026-10-01 10:00:00',
  };
  const d1 = decorateCard(base, '2026-11-23');
  assert.equal(d1.usedSessions, 8);
  assert.equal(d1.unitCostCents, 5000);
  assert.equal(d1.daysUntilExpiry, 5);
  assert.equal(d1.isExpiringSoon, true);
  assert.equal(d1.isExpired, false);
  assert.equal(d1.isLowSessions, true);
  assert.equal(d1.status, 'active');

  // 总次数 <= 2 的体验卡不触发余次不足误报
  const small = decorateCard({ ...base, total_sessions: 2, remaining_sessions: 1, expires_at: '2026-11-20' }, '2026-11-23');
  assert.equal(small.isLowSessions, false);
  assert.equal(small.isExpired, true);
  assert.equal(small.status, 'expired');

  const empty = decorateCard({ ...base, remaining_sessions: 0 }, '2026-11-23');
  assert.equal(empty.isExhausted, true);
  assert.equal(empty.status, 'exhausted');
});
