-- HomeLedger Cloudflare D1 Schema (极简低读写版)
-- 已按架构决策移除：sessions、rate_limits、login_attempts、audit_logs、notification_dedup

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#4f7cff',
  avatar_path   TEXT,
  avatar_ver    INTEGER NOT NULL DEFAULT 0,
  theme         TEXT NOT NULL DEFAULT 'light',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  token_version INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledgers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'personal',
  currency    TEXT NOT NULL DEFAULT 'CNY',
  icon        TEXT NOT NULL DEFAULT '📒',
  color       TEXT NOT NULL DEFAULT '#4f7cff',
  owner_id    INTEGER NOT NULL,
  note        TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_members (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member',
  nickname  TEXT,
  joined_at TEXT NOT NULL,
  UNIQUE(ledger_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_lm_user ON ledger_members(user_id);

CREATE TABLE IF NOT EXISTS ledger_invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id  INTEGER NOT NULL,
  code       TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'member',
  created_by INTEGER NOT NULL,
  expires_at TEXT,
  used_by    INTEGER,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id       INTEGER NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'cash',
  icon            TEXT NOT NULL DEFAULT '💵',
  currency        TEXT NOT NULL DEFAULT 'CNY',
  initial_cents   INTEGER NOT NULL DEFAULT 0,
  balance_cents   INTEGER NOT NULL DEFAULT 0,
  credit_limit    INTEGER,
  bill_day        INTEGER,
  due_day         INTEGER,
  institution     TEXT,
  card_no         TEXT,
  note            TEXT,
  include_in_net  INTEGER NOT NULL DEFAULT 1,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_ledger ON accounts(ledger_id);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id   INTEGER,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'expense',
  parent_id   INTEGER,
  icon        TEXT NOT NULL DEFAULT '🏷️',
  color       TEXT NOT NULL DEFAULT '#8c8c8c',
  is_system   INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cat_kind ON categories(kind, parent_id);

CREATE TABLE IF NOT EXISTS tags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  name      TEXT NOT NULL,
  color     TEXT NOT NULL DEFAULT '#4f7cff',
  UNIQUE(ledger_id, name)
);

CREATE TABLE IF NOT EXISTS transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id         INTEGER NOT NULL,
  type              TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'CNY',
  rate              REAL NOT NULL DEFAULT 1,
  amount_base_cents INTEGER NOT NULL,
  account_id        INTEGER,
  to_account_id     INTEGER,
  category_id       INTEGER,
  user_id           INTEGER NOT NULL,
  txn_date          TEXT NOT NULL,
  note              TEXT,
  merchant          TEXT,
  status            TEXT NOT NULL DEFAULT 'cleared',
  is_reimbursable   INTEGER NOT NULL DEFAULT 0,
  reimbursed_at     TEXT,
  related_id        INTEGER,
  group_id          TEXT,
  source            TEXT NOT NULL DEFAULT 'manual',
  ai_json           TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  subscription_id   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_txn_ledger_date ON transactions(ledger_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_txn_cat ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_group ON transactions(group_id);

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id INTEGER NOT NULL,
  tag_id         INTEGER NOT NULL,
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE TABLE IF NOT EXISTS splits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id       TEXT NOT NULL,
  transaction_id INTEGER,
  ledger_id      INTEGER NOT NULL,
  user_id        INTEGER,
  member_name    TEXT NOT NULL,
  share_cents    INTEGER NOT NULL,
  is_settled     INTEGER NOT NULL DEFAULT 0,
  settled_at     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_split_group ON splits(group_id);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id  INTEGER NOT NULL,
  txn_id     INTEGER,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'screenshot',
  file_name  TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  mime       TEXT,
  size       INTEGER,
  ai_status  TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_txn ON attachments(txn_id);

CREATE TABLE IF NOT EXISTS budgets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id    INTEGER NOT NULL,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'overall',
  category_id  INTEGER,
  account_id   INTEGER,
  period       TEXT NOT NULL DEFAULT 'monthly',
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'CNY',
  trigger_type TEXT NOT NULL DEFAULT 'expense',
  rollover     INTEGER NOT NULL DEFAULT 0,
  alert_pct    INTEGER NOT NULL DEFAULT 80,
  start_date   TEXT,
  end_date     TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id          INTEGER NOT NULL,
  name               TEXT NOT NULL,
  payload            TEXT NOT NULL,
  frequency          TEXT NOT NULL DEFAULT 'monthly',
  interval_n         INTEGER NOT NULL DEFAULT 1,
  day_of_month       INTEGER,
  weekday            INTEGER,
  next_run_at        TEXT NOT NULL,
  last_run_at        TEXT,
  auto_post          INTEGER NOT NULL DEFAULT 1,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id    INTEGER NOT NULL,
  name         TEXT NOT NULL,
  icon         TEXT NOT NULL DEFAULT '🎯',
  target_cents INTEGER NOT NULL,
  saved_cents  INTEGER NOT NULL DEFAULT 0,
  account_id   INTEGER,
  target_date  TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  note         TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id          INTEGER NOT NULL,
  name               TEXT NOT NULL,
  icon               TEXT NOT NULL DEFAULT '🧾',
  plan               TEXT,
  vendor_url         TEXT,
  amount_cents       INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'CNY',
  cycle              TEXT NOT NULL DEFAULT 'monthly',
  cycle_n            INTEGER NOT NULL DEFAULT 1,
  anchor_month       INTEGER,
  anchor_day         INTEGER,
  account_id         INTEGER,
  category_id        INTEGER,
  auto_renew         INTEGER NOT NULL DEFAULT 1,
  trial_ends_on      TEXT,
  next_charge_at     TEXT NOT NULL,
  last_charge_at     TEXT,
  reminder_days      INTEGER NOT NULL DEFAULT 3,
  charge_count       INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active',
  note               TEXT,
  created_by_user_id INTEGER,
  canceled_at        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_ledger ON subscriptions(ledger_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_next ON subscriptions(next_charge_at);

CREATE TABLE IF NOT EXISTS debts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id       INTEGER NOT NULL,
  direction       TEXT NOT NULL,
  counterparty    TEXT NOT NULL,
  principal_cents INTEGER NOT NULL,
  balance_cents   INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'CNY',
  account_id      INTEGER,
  due_date        TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  note            TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  ledger_id  INTEGER,
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  dedupe_key TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS exchange_rates (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  base     TEXT NOT NULL,
  quote    TEXT NOT NULL,
  rate     REAL NOT NULL,
  noted_at TEXT NOT NULL,
  UNIQUE(base, quote)
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  source     TEXT NOT NULL,
  file_name  TEXT,
  total      INTEGER NOT NULL DEFAULT 0,
  imported   INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'done',
  message    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  ledger_id  INTEGER,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_tail TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
