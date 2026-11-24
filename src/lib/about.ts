export const GITHUB_REPO = 'https://github.com/sucraft-hub/homeledger';

export const APP = {
  name: '家账簿 HomeLedger',
  slogan: '为家庭打造的轻量自托管记账系统',
  description:
    'Cloudflare Workers 自托管版：数据存储在 Cloudflare D1（SQLite）+ R2（附件），全球边缘运行。' +
    '支持文字与截图 AI 自动记账、账户三层分组与次卡核销、订阅扣费、预算目标与开放 API。',
  author: '蘇先生',
  aiNote: '本项目的部分代码与文档由 AI 辅助生成。',
} as const;

export const FEATURES = [
  { ico: '🤖', title: 'AI 智能记账', desc: '发一句「午饭 35 元」或一张账单截图，自动识别分类与账户并入库' },
  { ico: '💳', title: '三层账户与次卡', desc: '资金账户、充值账户与次卡核销、信用账期额度追踪一目了然' },
  { ico: '🧾', title: '订阅与周期账单', desc: '管理周期性扣费与试用期提醒，月均与年化成本自动统计' },
  { ico: '🎯', title: '预算、借贷与目标', desc: '分类/账户预算超支预警，借贷台账自动汇总，储蓄目标进度可视' },
  { ico: '📥', title: '账单导入导出', desc: '支持微信、支付宝 CSV 账单去重导入，支持全量 CSV 与 JSON 恢复' },
  { ico: '🔌', title: '开放 API 与离线图表', desc: '零写库 Bearer Token 开放接口与无依赖服务端 SVG 报表图表' },
] as const;

export const CHANGELOG = [
  {
    version: '1.0.0',
    date: '2026-11-24',
    tag: '当前版本',
    items: [
      'Cloudflare Workers 原生重构：TypeScript + Hono 4 + D1 + R2 + 4 小时 Cron Triggers',
      '无状态 HMAC-SHA256 会话与 token_version 吊销、OpenAPI 鉴权零 D1 写，极致节省 D1 读写配额',
      '账户三层分组、信用账单/还款日追踪、充值次卡核销与 R2 附件全生命周期联动',
      '补齐关于页、多维搜索筛选、报表自定义区间与星期分布、CSV 预览标注、OpenAPI 全资源 CRUD 与 PWA 移动端导航',
    ],
  },
  {
    version: '1.0.0-upstream',
    date: '2026-09-25',
    tag: '上游版本',
    items: [
      '首个公开发布版本：核心记账、预算与储蓄目标、借贷台账、账单导入',
      '订阅扣费管理：周期扣费自动生成流水，月均/年化成本统计与到期提醒',
      'AI 记账助手：站内文字/截图自动记账，规则引擎兜底，模型可自由切换',
      '开放 API：令牌鉴权 REST 接口，支持自动化脚本与快捷指令接入',
    ],
  },
] as const;

export const TECH = [
  { name: 'Cloudflare Workers + Hono 4', desc: 'TypeScript 边缘路由与 SSR 服务端渲染，零构建前端' },
  { name: 'Cloudflare D1', desc: '极简表结构与 SQL 迁移初始化，控制读写消耗于免费额度内' },
  { name: 'Cloudflare R2', desc: '账单截图、凭证附件与用户头像安全隔离存储' },
  { name: 'Cron Triggers (0 */4 * * *)', desc: '每 4 小时定时触发周期账单、订阅扣费与预算/信用/次卡提醒' },
] as const;

export function repoUrl(env: { HOMELEDGER_GITHUB_REPO?: string } = {}): string {
  const raw = String(env.HOMELEDGER_GITHUB_REPO || GITHUB_REPO || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function issuesUrl(env: { HOMELEDGER_GITHUB_REPO?: string } = {}): string | null {
  const repo = repoUrl(env);
  if (!repo || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return `${repo}/issues`;
}
