-- Phase 1: 次卡（按次计费预付卡）台账表与核销日志表
-- 财务口径：购卡即一次性支出（可选联动），核销仅扣减次数，不计入净资产

CREATE TABLE IF NOT EXISTS session_cards (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id          INTEGER NOT NULL,
  name               TEXT NOT NULL,
  icon               TEXT NOT NULL DEFAULT '🎟️',
  merchant           TEXT,
  total_sessions     INTEGER NOT NULL,
  remaining_sessions INTEGER NOT NULL,
  total_cost_cents   INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'CNY',
  purchase_date      TEXT NOT NULL,
  expires_at         TEXT,
  purchase_txn_id    INTEGER,
  is_archived        INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sc_ledger ON session_cards(ledger_id, is_archived);
CREATE INDEX IF NOT EXISTS idx_sc_expires ON session_cards(expires_at);

CREATE TABLE IF NOT EXISTS session_card_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    INTEGER NOT NULL,
  ledger_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  delta      INTEGER NOT NULL,
  used_at    TEXT NOT NULL,
  note       TEXT,
  txn_id     INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scl_card ON session_card_logs(card_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_scl_ledger ON session_card_logs(ledger_id);
