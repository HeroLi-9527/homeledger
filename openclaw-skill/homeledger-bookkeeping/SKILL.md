---
name: homeledger-bookkeeping
description: 使用家账簿 HomeLedger（Cloudflare Workers 版）开放 API 进行 AI 账单识别/记账、流水查询、账户/分类查询与理财规划管理。当用户发送账单文字、付款截图、小票或要求记账/查账时使用。
---

# HomeLedger 家庭记账 Skill（Cloudflare Workers 版）

适用于部署在 Cloudflare Workers + D1 + R2 上的 **HomeLedger（家账簿）** 自托管实例。

## 环境配置

调用前需要以下环境变量：

- `HOMELEDGER_URL`：HomeLedger 服务根地址，例如 `https://homeledger.example.workers.dev` 或自定义域名（末尾不要带 `/`）
- `HOMELEDGER_TOKEN`：在网页端「系统设置 → 开放 API 令牌」创建的 `hl_...` Bearer Token

可选指定目标账本（不传则使用令牌绑定的默认账本）：

- 请求头：`x-ledger-id: <ledger_id>`
- 或查询参数：`?ledger_id=<ledger_id>`

> 注意：Workers 版开放 API 的 Bearer Token 鉴权为纯只读校验（不写 `last_used_at`），不额外消耗 D1 写入配额；写操作需令牌所属成员角色为 `member`、`admin` 或 `owner`（`viewer` 仅允许 `GET` 请求）。

## 核心工作流

### 1. 连通性与当前上下文检查

```bash
curl -sS -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  "$HOMELEDGER_URL/api/open/ping"
```

返回包含 `ok`、`app`（`"homeledger"`）、`today`（`YYYY-MM-DD`）、`time`、`user`、`ledger_id`、`role`、`token`。

### 2. AI 账单文字 / 截图自动记账（推荐入口）

端点：`POST /api/open/ai/bill`

请求体字段（JSON）：
- `text`（可选，最多 4000 字）：消费描述，如 `"今天午饭 35 元 支付宝"` 或多行账单文字
- `images`（可选，最多 6 张，单张 ≤ 8MB）：`data:image/png;base64,...` 字符串数组或 `[{ "dataUrl": "data:image/...;base64,...", "name": "receipt.png" }]`
- `confirm` / `auto_save`（布尔，默认 `true`）：
  - `false`：仅做 AI / 规则解析，返回 `drafts`（及 `items`）草稿预览，**不写流水库、不存图片到 R2、不自动建户**
  - `true`（默认）：解析后自动去重入库并按需存档原图到 R2
- `save_images`（布尔，默认 `true`）：设为 `false` 时即使入库也不将截图上传至 R2 / `attachments` 表
- `default_account` / `default_account_name` / `default_account_id` / `account_id`（可选）：未识别出账户时的默认账户；传名称且不存在时（`auto_create_account !== false`）在确认入库阶段自动创建账户
- `source`（可选）：自定义来源标记（默认截图为 `ai_screenshot`，纯文本为 `openapi`）

响应同时兼容上下游字段：
- `ok`、`confirmed`、`engine`（`llm` | `rule`）、`model`
- `drafts` 与 `items`（识别条目数组，含 `draft_id`、`type`、`amount_cents`、`currency`、`txn_date`、`category_id`、`category_path`、`account_id`、`account_name`、`merchant`、`note`、`confidence`）
- `created`（入库笔数）、`duplicates`（重复跳过笔数）、`ids`（新建流水 ID 列表）
- `images`（已保存附件列表，含 `id`、`rel`、`path`、`url`、`txn_id`）
- `accounts_created`（自动创建的账户名称列表）
- `warnings`、`errors`

#### 推荐两步交互（先预览再确认）

```bash
# 第一步：仅预览不入库
curl -sS -X POST "$HOMELEDGER_URL/api/open/ai/bill" \
  -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"瑞幸咖啡 19.9 元 支付宝","confirm":false}'

# 第二步：用户确认后入库（或直接 POST /api/open/transactions 精确写入）
curl -sS -X POST "$HOMELEDGER_URL/api/open/ai/bill" \
  -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"瑞幸咖啡 19.9 元 支付宝","confirm":true,"default_account":"支付宝"}'
```

### 3. 结构化直接记账

端点：`POST /api/open/transactions`

支持中英文类型与别名：
- `type`：`expense`（支出）、`income`（收入）、`transfer`（转账）、`lend`（借出）、`borrow`（借入）、`repay_receive`（收款）、`repay_pay`（还款）、`reimburse`（报销）、`refund`（退款）、`fee`（手续费）、`interest`（利息）、`invest_buy`（投资买入）、`invest_sell`（投资卖出）、`adjust`（校准）
- 金额支持 `amount`（元）或 `amount_cents`（整数分）
- 账户支持 `account_id` 或 `account` / `account_name`，以及转入账户 `to_account_id` 或 `to_account` / `to_account_name`（不存在时默认自动创建，传 `auto_create_account: false` 则报错）
- 分类支持 `category_id` 或 `category` / `category_name`（按路径或名称自动匹配）
- 日期支持 `txn_date` 或 `date`（`YYYY-MM-DD`，默认当天）

```bash
curl -sS -X POST "$HOMELEDGER_URL/api/open/transactions" \
  -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "支出",
    "amount": "45.50",
    "category": "餐饮/午餐",
    "account": "支付宝",
    "date": "2026-11-24",
    "merchant": "海底捞",
    "note": "工作餐"
  }'
```

返回包含 `id`、`transaction`、`accounts_created`、`category_resolved`。

### 4. 查询近期流水与账本概览

- `GET /api/open/transactions/recent?limit=15`：返回近期流水（同时包含 `transactions` 与 `items`、`count` 与 `total`，每笔流水含 `images` 附件数组）
- `GET /api/open/transactions?from=2026-11-01&to=2026-11-30&q=咖啡`：多条件分页查询
- `GET /api/open/overview?month=2026-11`：月度收支、资产负债、预算/订阅/借贷/目标概览
- `GET /api/open/reports?preset=month&month=2026-11`：分类构成、趋势、日统计与成员拆分
- `GET /api/open/accounts`、`GET /api/open/categories`、`GET /api/open/tags`
- `GET /api/open/budgets`、`GET /api/open/subscriptions`、`GET /api/open/session-cards`、`GET /api/open/debts`、`GET /api/open/goals`
- `GET /api/open/attachments/:id`：读取 R2 存档的账单截图原图

## 使用准则

1. 金额以「元」向用户展示和确认，调用底层接口时可传元字符串或 `amount_cents` 整数分。
2. 当用户发来模糊或大额账单时，优先使用 `confirm: false` 先预览草稿，再向用户确认入库；明确指令“记一笔 xxx”可直接入库并在回复中给出入库金额、分类、账户和日期。
3. 严禁在回复或日志中泄露 `HOMELEDGER_TOKEN`。
