# Agent Note: 移除 Cloudflare 一键部署入口并统一为手动 Wrangler CLI 部署

Status: implemented

## Problem

在 [README.md](../../../../README.md) 中通过 `https://deploy.workers.cloudflare.com/?url=https://github.com/HeroLi-9527/homeledger` 提供的 **Deploy to Cloudflare** 一键部署按钮，在实际使用中持续出现无法获取 GitHub 仓库的问题（可能受仓库归属账户类型或 Cloudflare 一键模板拉取机制限制）。该入口长期失效导致首次部署引导不可用，且故障位于 Cloudflare 托管向导侧，项目侧无法可靠排查或修复。

## Decision

项目移除 Cloudflare 一键部署入口，统一采用基于 Wrangler CLI 的手动部署流程，同时保留对手动部署同样有价值的密钥缺失防护与自动迁移脚本：

1. **移除一键部署入口与向导**：删除 `README.md` 顶部与部署章节中的 `Deploy to Cloudflare` 按钮及一键部署说明，改为顺序明确的 `### 手动部署步骤`（前置 Node.js ≥ 20 与 R2 开通条件、克隆与依赖安装、`wrangler login`、创建 D1/R2、填写 `database_id`、设置 `SESSION_SECRET` 与 `npm run deploy`）。
2. **对齐工具配置注释与引导主次**：同步更新 `wrangler.toml` 顶部注释为手动 CLI 部署顺序；调整 `src/index.ts` 中 `SESSION_SECRET` 缺失或不足 16 位时的 503 引导页，将 Wrangler CLI 与 `.dev.vars` 配置提升为主要指引，Cloudflare 控制台 **Variables and Secrets** 作为备选说明保留。
3. **保留部署安全与自动化基础**：保留 `package.json` 中按绑定名 `DB` 执行远程迁移的 `npm run deploy`（`wrangler d1 migrations apply DB --remote && wrangler deploy`），以及 `src/index.ts` / `src/routes/helpers.ts` 中的 `hasValidSessionSecret` 503 拦截机制，避免手动部署遗漏密钥或迁移引发 `/setup` 半初始化与 Schema 漂移。

## Alternatives considered

- **继续排障并保留 `Deploy to Cloudflare` 按钮**：该方案可在理想情况下降低非开发者的首次部署门槛，免去本地安装 Node.js 与执行 CLI 的成本；但 `deploy.workers.cloudflare.com` 对 GitHub 个人/组织账户及仓库抓取属于外部黑盒，已在当前仓库反复验证无法拉取成功，继续保留失效按钮只会误导部署者。
- **整笔回滚 `20c1336` 提交**：回滚可快速清除一键部署改动并让 `npm run deploy` 恢复单一 `wrangler deploy` 职责；但 `20c1336` 中新增的 `SESSION_SECRET` 缺失 503 拦截与 `npm run deploy` 自动执行 `wrangler d1 migrations apply DB --remote` 对手动部署同样能防止未设密钥就初始化和忘记执行迁移的问题，因此仅移除一键部署按钮与文案，保留其余基础能力。

## Consequences

- **部署流程确定可控**：部署完全依托本地标准 `wrangler` CLI 命令完成，不再受第三方一键按钮对账户类型、GitHub 授权或仓库拉取策略的影响。
- **首次部署门槛小幅提升**：部署者需在本地准备 Node.js（≥ 20）与 Git 环境，并手动创建 D1/R2 资源及将 `database_id` 写入 `wrangler.toml`。

## Verification

- 全量门禁 `npm run verify-notes && npm run typecheck && npm test` 通过。
- 检索确认 `README.md`、`wrangler.toml`、`src/` 与 `package.json` 中已无 `deploy.workers.cloudflare`、`Deploy to Cloudflare` 或 `一键部署` 残留。
