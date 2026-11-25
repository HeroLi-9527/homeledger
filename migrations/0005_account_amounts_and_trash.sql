ALTER TABLE transactions ADD COLUMN account_amount_cents INTEGER;
ALTER TABLE transactions ADD COLUMN to_account_amount_cents INTEGER;
ALTER TABLE transactions ADD COLUMN purge_started INTEGER NOT NULL DEFAULT 0;

WITH base AS (SELECT UPPER(COALESCE((SELECT value FROM settings WHERE key = 'site.currency'), 'CNY')) AS code)
UPDATE transactions AS t
SET account_amount_cents = (
      SELECT CASE
        WHEN UPPER(a.currency) = UPPER(t.currency) THEN t.amount_cents
        WHEN UPPER(a.currency) = base.code THEN t.amount_base_cents
      END
      FROM accounts a, base WHERE a.id = t.account_id AND a.ledger_id = t.ledger_id
    ),
    to_account_amount_cents = (
      SELECT CASE
        WHEN UPPER(a.currency) = UPPER(t.currency) THEN t.amount_cents
        WHEN UPPER(a.currency) = base.code THEN t.amount_base_cents
      END
      FROM accounts a, base WHERE a.id = t.to_account_id AND a.ledger_id = t.ledger_id
    );

-- Unresolved historical sides remain NULL and are listed for reconciliation.
WITH sides AS (
  SELECT account_id AS id, CASE
    WHEN type = 'invest_sell' AND to_account_id IS NULL THEN 0
    WHEN type IN ('income','borrow','repay_receive','reimburse','refund','interest','invest_sell','adjust')
      THEN account_amount_cents ELSE -account_amount_cents END AS delta
  FROM transactions WHERE deleted_at IS NULL AND account_id IS NOT NULL
  UNION ALL
  SELECT to_account_id, CASE WHEN type = 'invest_sell' THEN -to_account_amount_cents ELSE to_account_amount_cents END
  FROM transactions WHERE deleted_at IS NULL AND to_account_id IS NOT NULL AND type IN ('transfer','invest_buy','invest_sell')
), totals AS (SELECT id, SUM(delta) AS delta FROM sides GROUP BY id)
UPDATE accounts SET balance_cents = initial_cents + COALESCE((SELECT delta FROM totals WHERE id = accounts.id), 0);


CREATE UNIQUE INDEX idx_homeledger_csv_row
ON transactions(ledger_id, ai_json) WHERE source = 'homeledger_csv';

CREATE TRIGGER accounts_currency_history_guard
BEFORE UPDATE OF currency ON accounts
WHEN UPPER(NEW.currency) <> UPPER(OLD.currency) AND EXISTS (
  SELECT 1 FROM transactions WHERE account_id = OLD.id OR to_account_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'account currency has transaction history');
END;

CREATE TRIGGER site_currency_history_guard
BEFORE UPDATE OF value ON settings
WHEN OLD.key = 'site.currency' AND UPPER(NEW.value) <> UPPER(OLD.value)
  AND EXISTS (SELECT 1 FROM transactions)
BEGIN
  SELECT RAISE(ABORT, 'site currency has transaction history');
END;
