-- 补充订阅关联流水索引，加速订阅历史扣费与本月已扣统计查询
CREATE INDEX IF NOT EXISTS idx_txn_subscription ON transactions(subscription_id);
