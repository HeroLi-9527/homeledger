ALTER TABLE debts ADD COLUMN manual_balance_cents INTEGER;
ALTER TABLE transactions ADD COLUMN settlement_debt_id INTEGER;
ALTER TABLE transactions ADD COLUMN settlement_auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN recurring_rule_id INTEGER;
ALTER TABLE transactions ADD COLUMN scheduled_period TEXT;
ALTER TABLE attachments ADD COLUMN delete_started INTEGER NOT NULL DEFAULT 0;
