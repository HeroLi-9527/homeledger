export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  ASSETS?: Fetcher;
  TZ?: string;
  SITE_NAME?: string;
  SESSION_SECRET?: string;
  COOKIE_SECURE?: string;
  ALLOW_REGISTER?: string;
  HOMELEDGER_GITHUB_REPO?: string;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export type BatchStatement = [string, unknown[]?];

export interface Db {
  d1: D1Database;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  batch(statements: BatchStatement[]): Promise<D1Result[]>;
}

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface SessionPayload {
  uid: number;
  lid: number | null;
  tv: number;
  csrf: string;
  exp: number;
}

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  password_hash: string;
  display_name: string;
  avatar_color: string;
  avatar_path: string | null;
  avatar_ver: number;
  theme: string;
  is_admin: number;
  status: string;
  token_version: number;
  last_login_at: string | null;
  created_at: string;
}

export interface LedgerRow {
  id: number;
  name: string;
  kind: string;
  currency: string;
  icon: string;
  color: string;
  owner_id: number;
  note: string | null;
  is_archived: number;
  sort_order: number;
  created_at: string;
  rollover_year?: number | null;
  rolled_over_to_id?: number | null;
  role?: Role;
}

export interface AppContext {
  user: UserRow | null;
  ledgers: LedgerRow[];
  ledger: LedgerRow | null;
  isAdmin: boolean;
  unreadCount: number;
}

export interface OpenAuth {
  userId: number;
  username: string;
  displayName?: string;
  isAdmin?: boolean;
  ledgerId: number;
  archived: boolean;
  tokenId: number;
  tokenName: string;
  role: Role;
}

export interface FlashMessage {
  type: 'success' | 'error' | 'warn' | 'info';
  message: string;
}

export interface AppVars {
  db: Db;
  sess: SessionPayload | null;
  ctx: AppContext;
  csrf: string;
  cspNonce: string;
  body?: Record<string, unknown>;
  openAuth?: OpenAuth;
  flash?: FlashMessage | null;
}

export type HonoEnv = {
  Bindings: Env;
  Variables: AppVars;
};

export interface AccountRow {
  id: number;
  ledger_id: number;
  name: string;
  type: string;
  icon: string;
  currency: string;
  initial_cents: number;
  balance_cents: number;
  credit_limit: number | null;
  bill_day: number | null;
  due_day: number | null;
  institution: string | null;
  card_no: string | null;
  note: string | null;
  include_in_net: number;
  is_archived: number;
  sort_order: number;
  created_at: string;
}

export interface CategoryRow {
  id: number;
  ledger_id: number | null;
  name: string;
  kind: 'expense' | 'income';
  parent_id: number | null;
  icon: string;
  color: string;
  is_system: number;
  is_archived: number;
  sort_order: number;
  parent_name?: string | null;
  path?: string;
  children?: CategoryRow[];
}

export interface TxnRow {
  id: number;
  ledger_id: number;
  type: string;
  amount_cents: number;
  currency: string;
  rate: number;
  amount_base_cents: number;
  account_amount_cents: number | null;
  to_account_amount_cents: number | null;
  account_id: number | null;
  to_account_id: number | null;
  category_id: number | null;
  user_id: number;
  txn_date: string;
  note: string | null;
  merchant: string | null;
  status: string;
  is_reimbursable: number;
  reimbursed_at: string | null;
  related_id: number | null;
  group_id: string | null;
  source: string;
  ai_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  subscription_id: number | null;
  settlement_debt_id?: number | null;
  category_name?: string | null;
  category_icon?: string | null;
  category_color?: string | null;
  category_parent?: string | null;
  account_name?: string | null;
  account_icon?: string | null;
  account_currency?: string | null;
  to_account_currency?: string | null;
  account_type?: string | null;
  to_account_name?: string | null;
  to_account_icon?: string | null;
  member_name?: string | null;
  member_color?: string | null;
  tag_names?: string | null;
  attachment_count?: number;
  type_label?: string;
  type_icon?: string;
  type_color?: string;
  flow?: 'out' | 'in' | 'move' | 'adjust';
  category_path?: string;
  is_income?: boolean;
  is_expense?: boolean;
}

export interface SessionCardRow {
  id: number;
  ledger_id: number;
  name: string;
  icon: string;
  merchant: string | null;
  total_sessions: number;
  remaining_sessions: number;
  total_cost_cents: number;
  currency: string;
  purchase_date: string;
  expires_at: string | null;
  purchase_txn_id: number | null;
  is_archived: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionCardLogRow {
  id: number;
  card_id: number;
  ledger_id: number;
  user_id: number;
  delta: number;
  used_at: string;
  note: string | null;
  txn_id: number | null;
  created_at: string;
  member_name?: string | null;
}
