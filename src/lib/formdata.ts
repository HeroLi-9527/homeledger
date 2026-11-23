import type { AccountRow, CategoryRow, Db, Role } from '../types.js';

export async function categoryTree(
  db: Db,
  ledgerId: number,
  kind: 'expense' | 'income' = 'expense',
): Promise<CategoryRow[]> {
  const rows = await db.all<CategoryRow>(
    `SELECT * FROM categories WHERE kind = ? AND is_archived = 0 AND (ledger_id IS NULL OR ledger_id = ?)
     ORDER BY sort_order, id`,
    kind,
    ledgerId,
  );
  const roots = rows.filter((r) => !r.parent_id);
  return roots.map((r) => ({
    ...r,
    children: rows.filter((c) => Number(c.parent_id) === Number(r.id)),
  }));
}

export async function flatCategories(
  db: Db,
  ledgerId: number,
  kind: 'expense' | 'income' | null = null,
): Promise<Array<CategoryRow & { path: string }>> {
  let sql = `SELECT c.*, p.name AS parent_name FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
             WHERE c.is_archived = 0 AND (c.ledger_id IS NULL OR c.ledger_id = ?)`;
  const params: unknown[] = [ledgerId];
  if (kind) {
    sql += ' AND c.kind = ?';
    params.push(kind);
  }
  sql += ' ORDER BY c.kind DESC, COALESCE(p.sort_order, c.sort_order), c.sort_order, c.id';
  return (await db.all<CategoryRow>(sql, ...params)).map((c) => ({
    ...c,
    path: c.parent_name ? `${c.parent_name}/${c.name}` : c.name,
  }));
}

export async function accounts(db: Db, ledgerId: number): Promise<AccountRow[]> {
  return db.all<AccountRow>(
    'SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id',
    ledgerId,
  );
}

export async function archivedAccounts(db: Db, ledgerId: number): Promise<AccountRow[]> {
  return db.all<AccountRow>(
    'SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 1 ORDER BY sort_order, id',
    ledgerId,
  );
}

export interface LedgerMemberView {
  id: number;
  ledger_id: number;
  user_id: number;
  role: Role;
  nickname: string | null;
  joined_at: string;
  display_name: string;
  username: string;
  avatar_color: string;
  last_login_at: string | null;
}

export async function members(db: Db, ledgerId: number): Promise<LedgerMemberView[]> {
  return db.all<LedgerMemberView>(
    `SELECT m.*, u.display_name, u.username, u.avatar_color, u.last_login_at
     FROM ledger_members m JOIN users u ON u.id = m.user_id
     WHERE m.ledger_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, m.id`,
    ledgerId,
  );
}

export interface TagWithCount {
  id: number;
  ledger_id: number;
  name: string;
  color: string;
  cnt: number;
}

export async function tags(db: Db, ledgerId: number): Promise<TagWithCount[]> {
  return db.all<TagWithCount>(
    `SELECT t.*, (SELECT COUNT(*) FROM transaction_tags tt WHERE tt.tag_id = t.id) AS cnt
     FROM tags t WHERE t.ledger_id = ? ORDER BY cnt DESC, t.id LIMIT 100`,
    ledgerId,
  );
}

export async function txFormData(db: Db, ledgerId: number) {
  const [cats, expenseTree, incomeTree, accts, mems, tgs] = await Promise.all([
    flatCategories(db, ledgerId),
    categoryTree(db, ledgerId, 'expense'),
    categoryTree(db, ledgerId, 'income'),
    accounts(db, ledgerId),
    members(db, ledgerId),
    tags(db, ledgerId),
  ]);
  return {
    expenseCats: cats.filter((c) => c.kind === 'expense'),
    incomeCats: cats.filter((c) => c.kind === 'income'),
    expenseTree,
    incomeTree,
    accounts: accts,
    members: mems,
    tags: tgs,
  };
}

export function kindOf(type: string): 'income' | 'expense' {
  return ['income', 'interest', 'refund', 'reimburse'].includes(type) ? 'income' : 'expense';
}
