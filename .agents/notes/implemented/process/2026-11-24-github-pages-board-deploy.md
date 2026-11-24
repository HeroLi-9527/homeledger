# Agent Note: GitHub Actions 自动部署决策看板到 GitHub Pages

Status: implemented

## Problem

此前决策看板仅能通过本地执行 `npm run bundle-board` 生成 `demo.html`，且 `board.html` 与 `demo.html` 均被 `.gitignore` 忽略，无法在每次代码提交后自动构建并在线浏览最新的 `.agents/notes` 决策拓扑与正文。

## Decision

在 `.github/workflows/deploy-board.yml` 中配置自动部署工作流，在每次推送至 `main` 分支以及手动触发 `workflow_dispatch` 时，将决策看板自动打包并发布到 GitHub Pages：

1. **零额外依赖打包**：`build` 作业使用 `actions/setup-node@v4`（Node 24）直接执行 `.agents/skills/write-notes-like-deepseek/scripts/build-board.ts --bundle .agents/notes _site/index.html "HomeLedger 决策看板"`（该脚本仅依赖 Node 内置模块且使用可擦除 TypeScript 语法），同时生成 `_site/.nojekyll` 避免 GitHub Pages 对资源路径执行 Jekyll 过滤。
2. **官方 Pages 发布管线**：工作流声明 `contents: read`、`pages: write`、`id-token: write` 权限与 `group: pages`（`cancel-in-progress: false`）并发控制，依次通过 `actions/configure-pages@v5`、`actions/upload-pages-artifact@v3` 与 `actions/deploy-pages@v4` 将 `_site` 发布到 `github-pages` 环境。
3. **保留完整笔记正文**：由于 HomeLedger 为公开仓库且 `.agents/notes/` 已随仓库公开，构建命令不启用 `--metadata-only`，在线看板直接内嵌完整决策正文与关联拓扑。

## Alternatives considered

- **将打包产物推送到 `gh-pages` 分支**：兼容旧版 GitHub Pages 分支发布方式，但会持续污染仓库提交历史且要求工作流持有 `contents: write` 权限，因此改用 GitHub 官方 artifact 与 `actions/deploy-pages@v4`。
- **在工作流中先执行 `npm ci` 再通过 `npx tsx` 打包**：与 `package.json` 中的 `bundle-board` 脚本完全一致，但每次触发都会产生不必要的依赖安装耗时；`build-board.ts` 本身无第三方依赖，由 Node 24 原生执行更轻量快速。
- **使用 `paths: ['.agents/notes/**']` 过滤触发条件**：可在无关提交时减少 Actions 消耗，但无法满足每次提交均触发同步部署的要求且单次打包耗时极短，因此对 `main` 分支全量 `push` 触发。

## Consequences

- **收益**：每次推送到 `main` 后自动更新在线决策看板，不污染仓库 git 历史，且构建阶段无需 `npm ci` 安装项目依赖。
- **代价与约束**：需在 GitHub 仓库 `Settings → Pages → Build and deployment → Source` 一次性选择 `GitHub Actions` 方可完成部署；若未来 `build-board.ts` 引入第三方包或非可擦除 TypeScript 语法，工作流需调整为安装依赖后通过 `npx tsx` 执行。

## Verification

- 本地运行与工作流完全一致的打包命令 `node .agents/skills/write-notes-like-deepseek/scripts/build-board.ts --bundle .agents/notes _site/index.html "HomeLedger 决策看板"`，确认生成自包含 HTML 且内嵌全量笔记数据与标题后清理临时目录。
- 全量门禁 `npm run verify-notes`、`npm run typecheck` 与 `npm test` 均通过。
