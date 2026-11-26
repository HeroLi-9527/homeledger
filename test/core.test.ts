import { rolloverPeriod } from '../src/lib/ledger-rollover.js';
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
import { APP, CHANGELOG, FEATURES, TECH, fmtBytes, issuesUrl, repoLabel, repoUrl } from '../src/lib/about.js';
import { barChart, donutChart, heatmapChart, lineChart } from '../src/lib/charts.js';
import { advanceDate } from '../src/lib/scheduler.js';
import { decorateCard } from '../src/lib/session-cards.js';
import { advance, firstChargeDate } from '../src/lib/subscriptions.js';
import { BACKUP_TABLES, MAX_SQL_PARAMS, validateAndBuildRestorePlan, type TableColumnInfo } from '../src/lib/backup.js';
import { csvEscape } from '../src/lib/importers.js';
import { safeInternalPath } from '../src/lib/util.js';
import { parseReportRange } from '../src/routes/reports.js';

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

test('safeInternalPath 仅放行单斜杠站内路径并拦截伪协议与协议相对 URL', () => {
  assert.equal(safeInternalPath('/accounts/1?tab=edit#sec'), '/accounts/1?tab=edit#sec');
  assert.equal(safeInternalPath('  /transactions?page=2  '), '/transactions?page=2');
  assert.equal(safeInternalPath('//evil.com/phish', '/notifications'), '/notifications');
  assert.equal(safeInternalPath('/\\evil.com', '/notifications'), '/notifications');
  assert.equal(safeInternalPath('https://evil.com', '/'), '/');
  assert.equal(safeInternalPath('javascript:alert(1)', '/'), '/');
  assert.equal(safeInternalPath('/foo\r\nSet-Cookie: a=1', '/'), '/');
  assert.equal(safeInternalPath(null, '/fallback'), '/fallback');
});

test('validateAndBuildRestorePlan 前置校验、异构键并集、分块上限与全员 token_version 自增', () => {
  const mkSchema = () => {
    const m = new Map<string, TableColumnInfo[]>();
    for (const tbl of BACKUP_TABLES) {
      m.set(tbl, [
        { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
        { name: 'ledger_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      ]);
    }
    m.set('users', [
      { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'username', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'password_hash', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'display_name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'status', type: 'TEXT', notnull: 1, dflt_value: "'active'", pk: 0 },
      { name: 'is_admin', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    m.set('categories', [
      { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    m.set('settings', [
      { name: 'key', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'value', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    // 25 列宽表模拟 transactions，验证参数分块 ≤ MAX_SQL_PARAMS
    m.set(
      'transactions',
      Array.from({ length: 25 }, (_, i) => ({
        name: i === 0 ? 'id' : `c${i}`,
        type: i === 0 ? 'INTEGER' : 'TEXT',
        notnull: 0,
        dflt_value: null,
        pk: i === 0 ? 1 : 0,
      })),
    );
    return m;
  };
  const schema = mkSchema();
  const validBase = () => ({
    app: 'homeledger',
    version: 2,
    tables: {
      users: [
        {
          id: 1,
          username: 'admin',
          password_hash: 'pbkdf2$100000$aa$bb',
          display_name: 'Admin',
          is_admin: 1,
          status: 'active',
          created_at: '2026-11-23 10:00:00',
        },
      ],
      categories: [{ id: 1, name: '餐饮' }],
    },
  });

  // 拒绝非法 app / version / 缺活跃管理员 / 空分类
  assert.throws(() => validateAndBuildRestorePlan({ ...validBase(), app: 'other' }, schema), /app 字段/);
  assert.throws(() => validateAndBuildRestorePlan({ ...validBase(), version: 99 }, schema), /备份版本/);
  assert.throws(
    () =>
      validateAndBuildRestorePlan(
        {
          app: 'homeledger',
          version: 2,
          tables: {
            users: [{ ...validBase().tables.users[0], status: 'disabled' }],
            categories: [{ id: 1, name: '餐饮' }],
          },
        },
        schema,
      ),
    /站点管理员/,
  );
  assert.throws(
    () =>
      validateAndBuildRestorePlan(
        { app: 'homeledger', version: 2, tables: { users: validBase().tables.users, categories: [] } },
        schema,
      ),
    /categories 不能为空/,
  );

  // 拒绝缺必填列与重复主键 / 重复用户名
  assert.throws(
    () =>
      validateAndBuildRestorePlan(
        {
          app: 'homeledger',
          version: 2,
          tables: {
            users: validBase().tables.users,
            categories: [{ id: 1 }],
          },
        },
        schema,
      ),
    /缺少必填字段 name/,
  );
  assert.throws(
    () =>
      validateAndBuildRestorePlan(
        {
          app: 'homeledger',
          version: 2,
          tables: {
            users: [
              validBase().tables.users[0],
              { ...validBase().tables.users[0], id: 2 },
            ],
            categories: [{ id: 1, name: '餐饮' }],
          },
        },
        schema,
      ),
    /重复用户名/,
  );

  // 异构行键并集保留 + 宽表分块 ≤ MAX_SQL_PARAMS + token_version 自增
  const wideRows = Array.from({ length: 7 }, (_, i) => {
    const row: Record<string, unknown> = { id: i + 1 };
    for (let c = 1; c < 25; c++) row[`c${c}`] = i === 6 && c === 24 ? 'tail-val' : `v${c}`;
    if (i === 0) delete row.c24; // 第 0 行缺少 c24，仅后续行出现
    return row;
  });
  const plan = validateAndBuildRestorePlan(
    {
      app: 'homeledger',
      version: 2,
      tables: {
        users: [
          validBase().tables.users[0],
          {
            id: 2,
            username: 'bob',
            password_hash: 'pbkdf2$100000$cc$dd',
            display_name: 'Bob',
            created_at: '2026-11-23 10:00:00',
            // 故意省略带默认值的 status 与 is_admin
          },
        ],
        categories: [{ id: 1, name: '餐饮' }],
        transactions: wideRows,
      },
    },
    schema,
  );
  const txnInserts = plan.stmts.filter(([sql]) => sql.startsWith('INSERT INTO transactions'));
  assert.equal(txnInserts.length, 3, '7 行 × 25 列按 ≤95 参数应拆为 3+3+1 共 3 条多行 INSERT');
  for (const [, params] of txnInserts) {
    assert.ok((params?.length || 0) <= MAX_SQL_PARAMS);
  }
  assert.ok(
    txnInserts.some(([, params]) => params?.includes('tail-val')),
    '异构行后续出现列 c24 不得被静默丢弃',
  );
  const lastStmt = plan.stmts[plan.stmts.length - 1];
  assert.ok(lastStmt[0].includes('token_version'));
});

test('parseReportRange 支持自定义区间、反转纠偏、合法日校验与年份参数', () => {
  const rCustom = parseReportRange({ preset: 'custom', from: '2026-03-10', to: '2026-03-20' });
  assert.equal(rCustom.preset, 'custom');
  assert.equal(rCustom.start, '2026-03-10');
  assert.equal(rCustom.end, '2026-03-20');
  assert.equal(rCustom.label, '2026-03-10 ~ 2026-03-20');
  assert.equal(rCustom.from, '2026-03-10');
  assert.equal(rCustom.to, '2026-03-20');

  const rSwapped = parseReportRange({ preset: 'custom', from: '2026-05-20', to: '2026-05-01' });
  assert.equal(rSwapped.start, '2026-05-01');
  assert.equal(rSwapped.end, '2026-05-20');

  const rBadDay = parseReportRange({ preset: 'custom', month: '2026-02', from: '2026-02-30', to: '2026-02-28' });
  assert.equal(rBadDay.start, '2026-02-01');
  assert.equal(rBadDay.end, '2026-02-28');

  const rYear = parseReportRange({ preset: 'year', year: '2025' });
  assert.equal(rYear.preset, 'year');
  assert.equal(rYear.start, '2025-01-01');
  assert.equal(rYear.end, '2025-12-31');
  assert.equal(rYear.label, '2025全年');
  assert.equal(rYear.year, '2025');
});

test('about 模块常量与 GitHub Issues 链接推导', () => {
  assert.ok(APP.name.includes('HomeLedger'));
  assert.ok(FEATURES.length >= 6);
  assert.ok(CHANGELOG.length >= 2);
  assert.ok(TECH.length >= 4);
  assert.equal(repoUrl({ HOMELEDGER_GITHUB_REPO: 'https://github.com/org/repo/' }), 'https://github.com/org/repo');
  assert.equal(
    issuesUrl({ HOMELEDGER_GITHUB_REPO: 'https://github.com/org/repo///' }),
    'https://github.com/org/repo/issues',
  );
  assert.equal(issuesUrl({ HOMELEDGER_GITHUB_REPO: 'https://gitlab.example.com/org/repo' }), null);
  assert.equal(repoUrl({ HOMELEDGER_GITHUB_REPO: 'javascript:alert(1)' }), '');
  assert.equal(repoUrl({ HOMELEDGER_GITHUB_REPO: 'data:text/html,hi' }), '');
  assert.equal(repoLabel('https://github.com/HeroLi-9527/homeledger'), 'HeroLi-9527/homeledger');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(safeInternalPath('/\tevil.com', '/'), '/');
  assert.equal(safeInternalPath('/\\evil.com', '/'), '/');
  assert.equal(safeInternalPath('/transactions?a=1#h', '/'), '/transactions?a=1#h');
});

test('csvEscape 中和公式注入并保留合法负金额', () => {
  assert.equal(csvEscape('-50.00'), '-50.00');
  assert.equal(csvEscape('0'), '0');
  assert.equal(csvEscape('正常商家'), '正常商家');
  assert.equal(csvEscape('=1+1'), "'=1+1");
  assert.equal(csvEscape('+CMD()'), "'+CMD()");
  assert.equal(csvEscape('-2+3'), "'-2+3");
  assert.equal(csvEscape('-cmd'), "'-cmd");
  assert.equal(csvEscape('@SUM(A1:A2)'), "'@SUM(A1:A2)");
  assert.equal(csvEscape('\t=1+1'), "'\t=1+1");
  assert.equal(csvEscape('\r=1+1'), '"\'\r=1+1"');
  assert.equal(csvEscape('  =HYPERLINK("a","b")'), '"  \'=HYPERLINK(""a"",""b"")"'.replace('  \'', '\'  '));
});

test('年度结转以站点日期确定目标年度和元旦确认边界', () => {
  assert.deepEqual(rolloverPeriod(null, undefined, '2027-01-03'), {
    targetYear: 2027, boundary: '2027-01-01', cutoffDate: '2026-12-31 23:59:59', periodClosed: true,
  });
  assert.equal(rolloverPeriod(2026, undefined, '2026-12-31').periodClosed, false);
  assert.equal(rolloverPeriod(2026, undefined, '2027-01-01').periodClosed, true);
  assert.equal(rolloverPeriod(2026, undefined, '2028-01-01').targetYear, 2027);
  assert.throws(() => rolloverPeriod(2026, 2028, '2027-01-01'), { status: 400 });
  assert.throws(() => rolloverPeriod(null, 2027.5, '2027-01-01'), { status: 400 });
});
