// Callers supply scope(ledger_id, boundary), where boundary is the first excluded day.
export const debtBalancesCte = `
  , debt_txns AS (
    SELECT t.id, t.type, t.account_id, t.currency, t.amount_cents, t.amount_base_cents,
           t.settlement_debt_id, t.settlement_auto,
           CASE WHEN type IN ('lend','repay_receive') THEN 'receivable' ELSE 'payable' END AS direction,
           COALESCE(NULLIF(merchant, ''), '未指定') AS counterparty
    FROM transactions t, scope s
    WHERE t.ledger_id = s.ledger_id AND t.deleted_at IS NULL
      AND (s.boundary IS NULL OR t.txn_date < s.boundary)
      AND t.type IN ('lend','borrow','repay_receive','repay_pay')
  ), directed_payments AS (
    SELECT settlement_debt_id, SUM(amount_cents) AS paid
    FROM debt_txns WHERE settlement_debt_id IS NOT NULL AND settlement_auto = 0
      AND type IN ('repay_receive','repay_pay')
    GROUP BY settlement_debt_id
  ), unallocated_openings AS (
    SELECT d.*, UPPER(d.currency) AS currency_key, MAX(0, d.opening_cents - COALESCE(p.paid, 0)) AS remaining
    FROM debts d JOIN scope s ON d.ledger_id = s.ledger_id
    LEFT JOIN directed_payments p ON p.settlement_debt_id = d.id
    WHERE d.opening_cents > 0 AND (s.boundary IS NULL OR d.created_at < s.boundary)
  ), openings AS (
    SELECT *, SUM(remaining) OVER (
      PARTITION BY direction, counterparty, currency_key ORDER BY id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running
    FROM unallocated_openings
  ), payments AS (
    SELECT *, UPPER(currency) AS currency_key, SUM(amount_cents) OVER (
      PARTITION BY direction, counterparty, UPPER(currency) ORDER BY id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running
    FROM debt_txns WHERE type IN ('repay_receive','repay_pay') AND settlement_debt_id IS NULL AND settlement_auto = 0
  ), payment_totals AS (
    SELECT direction, counterparty, currency_key, MAX(running) AS paid
    FROM payments GROUP BY direction, counterparty, currency_key
  ), opening_state AS (
    SELECT o.id, o.direction, o.counterparty, o.currency, o.account_id, o.due_date, o.note,
           MIN(o.remaining, MAX(0, o.running - COALESCE(p.paid, 0))) AS balance_cents
    FROM openings o LEFT JOIN payment_totals p USING(direction, counterparty, currency_key)
  ), opening_totals AS (
    SELECT direction, counterparty, currency_key, MAX(running) AS principal
    FROM openings GROUP BY direction, counterparty, currency_key
  ), auto_payments AS (
    SELECT p.direction, p.counterparty, p.amount_base_cents - ROUND(1.0 * p.amount_base_cents *
      MIN(p.amount_cents, MAX(0, COALESCE(o.principal, 0) - (p.running - p.amount_cents))) / NULLIF(p.amount_cents, 0)) AS paid
    FROM payments p LEFT JOIN opening_totals o USING(direction, counterparty, currency_key)
    UNION ALL
    SELECT direction, counterparty, amount_base_cents FROM debt_txns
    WHERE settlement_auto = 1 AND type IN ('repay_receive','repay_pay')
  ), residual AS (
    SELECT direction, counterparty, SUM(paid) AS paid FROM auto_payments GROUP BY direction, counterparty
  ), loans AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY direction, counterparty ORDER BY id) AS seq,
           SUM(amount_base_cents) OVER (PARTITION BY direction, counterparty) AS principal
    FROM debt_txns WHERE type IN ('lend','borrow')
  ), auto_state AS (
    SELECT a.id, a.direction, a.counterparty,
           COALESCE((SELECT value FROM settings WHERE key = 'site.currency'), 'CNY') AS currency,
           a.account_id,
           (SELECT d.due_date FROM debts d, scope s WHERE d.ledger_id = s.ledger_id AND d.opening_cents = 0
             AND d.note = '系统自动汇总' AND d.direction = a.direction AND d.counterparty = a.counterparty
             AND d.due_date IS NOT NULL ORDER BY d.id DESC LIMIT 1) AS due_date,
           '系统自动汇总' AS note, a.principal AS principal_cents,
           MAX(0, a.principal - COALESCE(r.paid, 0)) AS balance_cents
    FROM loans a LEFT JOIN residual r USING(direction, counterparty) WHERE a.seq = 1
  ), manual_state AS (
    SELECT d.id, d.direction, d.counterparty, d.currency, d.account_id, d.due_date, d.note,
           d.status, d.balance_cents AS current_balance, d.manual_balance_cents,
           CASE WHEN d.manual_balance_cents IS NULL THEN d.balance_cents
                ELSE MAX(0, d.manual_balance_cents - COALESCE(p.paid, 0)) END AS balance_cents
    FROM debts d JOIN scope s ON d.ledger_id = s.ledger_id
    LEFT JOIN directed_payments p ON p.settlement_debt_id = d.id
    WHERE d.opening_cents = 0 AND d.note IS NOT '系统自动汇总'
      AND (s.boundary IS NULL OR d.created_at < s.boundary)
  ), outstanding_debts AS (
    SELECT 0 AS carry_kind, id, direction, counterparty, currency, account_id, due_date, note, balance_cents FROM opening_state
    WHERE balance_cents > 0
    UNION ALL
    SELECT 1, id, direction, counterparty, currency, account_id, due_date, note, balance_cents FROM auto_state
    WHERE balance_cents > 0
    UNION ALL
    SELECT 2, id, direction, counterparty, currency, account_id, due_date, note, balance_cents FROM manual_state
    WHERE (status = 'open' OR (manual_balance_cents IS NOT NULL AND current_balance = 0)) AND balance_cents > 0
  )`;

export const debtScope = 'WITH scope(ledger_id, boundary) AS (VALUES (?, ?))';

export const activeDebtScope = (guard?: string) => `WITH scope(ledger_id, boundary) AS (
  SELECT id, NULL FROM ledgers WHERE id = ? AND is_archived = 0 ${guard ? `AND (${guard})` : ''}
)`;
