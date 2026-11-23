import { todayStr } from '../db.js';
import type { Db } from '../types.js';
import { addDays, parseAmountToCents, uid } from './util.js';

const MASKED_SECRET = /^[•·*\u2022\u00b7\s]+$/;

export const KEYWORD_RULES: Array<[RegExp, string, 'income' | 'expense']> = [
  // 收入
  [/工资|薪资|薪水|月薪|发薪|代发工资|payroll/i, '工资', 'income'],
  [/年终奖|绩效奖|季度奖|奖金|目标奖/i, '奖金', 'income'],
  [/报销|报账|差旅报销|发票回款/i, '报销回款', 'income'],
  [/退款|退货|退回|返现|价保/i, '退款', 'income'],
  [/红包(收|入)|收到红包|抢红包|微信红包(收)/i, '红包', 'income'],
  [/利息|结息|余额宝收益|零钱通收益/i, '利息收入', 'income'],
  [/基金|股票|理财|债券|黄金.*收益|证券|沪深|ETF/i, '基金收益', 'income'],
  [/房租收|租金收|收租/i, '房租收入', 'income'],
  [/分红|股息/i, '分红', 'income'],
  [/兼职|外快|稿费|劳务/i, '兼职外快', 'income'],
  [/公积金/i, '公积金提取', 'income'],
  [/理赔|赔付/i, '保险理赔', 'income'],
  // 支出 - 餐饮
  [/早餐|豆浆|包子|粥|煎饼/i, '早餐', 'expense'],
  [/午餐|中饭|午饭|快餐|盖饭|兰州|麻辣烫|黄焖/i, '午餐', 'expense'],
  [/晚餐|晚饭|夜宵|烧烤|火锅|烤鱼|西餐|晚餐/i, '晚餐', 'expense'],
  [/外卖|美团|饿了么|饿了|肯德基|麦当劳|汉堡|必胜客|披萨/i, '外卖', 'expense'],
  [/咖啡|星巴克|瑞幸|奶茶|喜茶|蜜雪|霸王茶姬|茶百道|古茗|饮料|可乐|矿泉水|果汁/i, '饮料', 'expense'],
  [/零食|薯片|坚果|巧克力|糖果/i, '零食', 'expense'],
  [/水果|超市水果|生鲜|菜市场|买菜|蔬菜/i, '水果', 'expense'],
  [/饭店|餐厅|酒楼|大排档|宴会|餐饮/i, '下馆子', 'expense'],
  [/香烟|烟草|酒(?!店)|白酒|啤酒|红酒/i, '烟酒', 'expense'],
  // 交通
  [/地铁|轨道交通|公交|巴士|公交车/i, '公交', 'expense'],
  [/出租车|滴滴|网约车|打车|曹操|T3出行|高德打车/i, '打车', 'expense'],
  [/加油|中石化|中石油|壳牌|油费/i, '加油', 'expense'],
  [/停车|停车场|停车费/i, '停车', 'expense'],
  [/高速|过路|ETC|通行费/i, '过路费', 'expense'],
  [/洗车/i, '洗车', 'expense'],
  [/保养|4S店|机油/i, '车辆保养', 'expense'],
  [/修车|维修.*车|汽车维修/i, '车辆维修', 'expense'],
  [/车险|交强险|车辆保险/i, '车险', 'expense'],
  [/高铁|火车|动车|12306|铁路/i, '火车', 'expense'],
  [/机票|航空|航班|机场/i, '飞机', 'expense'],
  [/共享单车|哈啰|青桔|摩拜|美团单车/i, '共享单车', 'expense'],
  // 居住
  [/房租|租房|租金(?!收)|押金.*房/i, '房租', 'expense'],
  [/物业|物业管理/i, '物业费', 'expense'],
  [/水费|自来水/i, '水费', 'expense'],
  [/电费|国网|电力/i, '电费', 'expense'],
  [/燃气|天然气|煤气/i, '燃气费', 'expense'],
  [/取暖|暖气|供暖/i, '取暖费', 'expense'],
  [/宽带|电信|联通|移动.*宽带/i, '宽带费', 'expense'],
  [/保洁|家政|钟点工/i, '家政保洁', 'expense'],
  [/房贷|按揭|还款.*贷/i, '房贷', 'expense'],
  [/装修|建材|瓷砖|家具城/i, '装修', 'expense'],
  // 通讯
  [/话费|充值.*移动|充值.*联通|充值.*电信|手机费/i, '手机话费', 'expense'],
  [/流量|流量包/i, '流量充值', 'expense'],
  [/快递|邮费|顺丰|中通|圆通|韵达|申通|京东物流/i, '快递邮费', 'expense'],
  // 购物
  [/超市|永辉|沃尔玛|家乐福|大润发|盒马|华润万家|便利店|罗森|全家|711/i, '日用百货', 'expense'],
  [/洗发水|沐浴露|牙膏|纸巾|洗衣液|清洁|日化/i, '个护清洁', 'expense'],
  [/淘宝|天猫|京东(?!物流)|拼多多|唯品会|苏宁|商城|网购/i, '其他购物', 'expense'],
  [/宜家|家居|收纳|锅碗|厨具/i, '家居用品', 'expense'],
  [/五金|工具|螺丝/i, '五金工具', 'expense'],
  // 服饰
  [/优衣库|衣服|服装|T恤|衬衫|外套|羽绒|连衣裙|运动服/i, '上衣', 'expense'],
  [/裤子|牛仔|长裤|短裤|瑜伽裤/i, '裤装', 'expense'],
  [/鞋|耐克|阿迪|nike|adidas|安踏|李宁|运动鞋/i, '鞋靴', 'expense'],
  [/内衣|袜子|文胸/i, '内衣袜', 'expense'],
  [/包|箱包|背包|手提包|钱包/i, '箱包', 'expense'],
  [/饰品|项链|戒指|手表|首饰/i, '配饰', 'expense'],
  [/理发|剪发|美发|烫发|染发/i, '理发美发', 'expense'],
  // 娱乐
  [/电影|影城|电影院|万达影|猫眼|淘票票/i, '电影', 'expense'],
  [/游戏|steam|王者荣耀|和平精英|原神|点券|充值.*游戏/i, '游戏', 'expense'],
  [/演唱会|话剧|展览|音乐会|演出/i, '演出展览', 'expense'],
  [/会员|订阅|爱奇艺|腾讯视频|优酷|芒果|网易云|QQ音乐|Netflix|WPS会员|百度网盘/i, '会员订阅', 'expense'],
  [/酒吧|KTV|夜店|清吧/i, '酒吧', 'expense'],
  [/书店|图书|当当|书籍/i, '书籍影音', 'expense'],
  [/景区|门票|游玩|乐园|迪士尼|环球影城/i, '旅游门票', 'expense'],
  // 医疗
  [/医院|门诊|挂号|诊所|急诊/i, '门诊', 'expense'],
  [/药|药店|大药房|医药/i, '药品', 'expense'],
  [/住院|手术|治疗/i, '住院', 'expense'],
  [/体检|健康检查/i, '体检', 'expense'],
  [/牙|口腔|齿科|正畸/i, '牙科', 'expense'],
  [/眼镜|配镜|眼科|视力/i, '眼科', 'expense'],
  [/保健|营养品|维生素/i, '保健品', 'expense'],
  [/保险|保费|重疾|医疗险|寿险|意外险/i, '重疾险', 'expense'],
  // 教育
  [/学费|学杂费/i, '学费', 'expense'],
  [/培训|课程|培训班|辅导|补习|驾校/i, '培训费', 'expense'],
  [/书|教材|文具|笔记本|钢笔/i, '教材文具', 'expense'],
  [/在线课程|网课|知识付费|得到|知乎盐选/i, '在线课程', 'expense'],
  [/考试|报名费|资格证/i, '考试报名', 'expense'],
  // 人情
  [/红包(发|出)|发红包|群收款|转账给/i, '红包', 'expense'],
  [/礼金|份子钱|随礼|婚礼|满月酒/i, '礼金', 'expense'],
  [/请客|聚餐|宴请/i, '请客', 'expense'],
  [/捐赠|公益|慈善|捐款/i, '慈善捐赠', 'expense'],
  [/孝敬|父母|爸妈|长辈/i, '孝敬长辈', 'expense'],
  // 育儿 / 宠物
  [/奶粉|尿不湿|尿布|婴儿|宝宝|童装|儿童/i, '奶粉', 'expense'],
  [/早教|兴趣班|幼儿园|托育/i, '早教', 'expense'],
  [/宠物|猫粮|狗粮|猫砂|宠物医院|宠物店/i, '宠物主粮', 'expense'],
  // 运动
  [/健身|健身房|私教|Keep|乐刻|超级猩猩/i, '健身卡', 'expense'],
  [/球|羽毛球|篮球|足球|网球|乒乓球/i, '球类', 'expense'],
  [/游泳|泳池/i, '游泳', 'expense'],
  [/露营|户外|登山|徒步/i, '户外露营', 'expense'],
  // 旅行
  [/酒店|民宿|住宿|客栈|Airbnb|携程.*酒店/i, '酒店', 'expense'],
  [/旅游|旅行|跟团|自由行|携程|飞猪|去哪儿/i, '跟团游', 'expense'],
  [/签证/i, '签证', 'expense'],
  // 美容
  [/化妆|口红|粉底|彩妆|屈臣氏|丝芙兰/i, '化妆品', 'expense'],
  [/护肤|面膜|精华|乳液|爽肤水/i, '护肤品', 'expense'],
  [/美甲|美睫/i, '美甲', 'expense'],
  [/美容|SPA|按摩|足疗/i, '美容SPA', 'expense'],
  [/医美|整形|瘦脸|光子/i, '医美', 'expense'],
  // 数码
  [/手机|iPhone|华为|小米|OPPO|vivo|荣耀|一加/i, '手机', 'expense'],
  [/电脑|笔记本|MacBook|台式机|显示器/i, '电脑', 'expense'],
  [/耳机|键盘|鼠标|充电|数据线|外设|配件/i, '外设配件', 'expense'],
  [/软件|Adobe|Office|Steam.*买|订阅.*软件/i, '软件购买', 'expense'],
  [/智能家居|扫地机器人|智能门锁|摄像头/i, '智能家居', 'expense'],
  // 办公经营
  [/办公|打印|耗材|硒鼓|A4纸/i, '办公用品', 'expense'],
  [/差旅|出差|住宿.*出差/i, '差旅', 'expense'],
  [/团建|年会/i, '团建', 'expense'],
  [/广告|推广|投放|竞价|直通车/i, '广告推广', 'expense'],
  [/云服务器|域名|服务器|阿里云|腾讯云|华为云|VPS/i, '软件服务', 'expense'],
  // 金融
  [/手续费|服务费|佣金/i, '手续费', 'expense'],
  [/税费|个税|增值税|开票.*税/i, '税费', 'expense'],
  [/罚|违章|违约金/i, '罚款违约金', 'expense'],
  [/年费|卡费/i, '信用卡年费', 'expense'],
];

export const ACCOUNT_KEYWORDS: Array<[RegExp, string]> = [
  [/支付宝|花呗|余额宝|蚂蚁|alipay/i, '支付宝'],
  [/微信|零钱通|财付通|wechat/i, '微信'],
  [/京东|白条/i, '京东'],
  [/云闪付|银联/i, '银行卡'],
  [/银行卡|储蓄卡|借记卡|提现到卡|转到卡/i, '银行卡'],
  [/现金|钞/i, '现金'],
  [/信用卡|贷记/i, '信用卡'],
];

export const SYSTEM_PROMPT = `你是一个专业的记账助手，负责把「账单截图」或「账单文字」转换成结构化记账数据。
要求：
1. 只输出 JSON，不要输出任何解释文字，不要使用 Markdown 代码块。
2. 一张截图里可能包含多笔交易（例如账单列表），必须逐笔提取。
3. 金额一律为数字（元），不要带货币符号；支出/付款为正常正数。
4. 日期格式 YYYY-MM-DD；若截图只有月日则补齐为今年；无法确定则用今天。
5. type 只能取：expense（支出）、income（收入）、transfer（转账）。
6. category_name 必须从给定的分类列表中选择最贴近的「完整路径」，若都不合适则选「其他支出/其他」这类兜底项。
7. 若能识别出付款方式，acct 填对应账户名。
8. confidence 为 0~1 的小数，表示你对这笔提取的把握。
输出格式：
{"items":[{"type":"expense","amount":35.00,"txn_date":"2026-09-15","merchant":"肯德基","note":"午餐","category_name":"餐饮/午餐","acct":"支付宝","currency":"CNY","confidence":0.95}]}`;

export const isMaskedSecret = (v: unknown): boolean => MASKED_SECRET.test(String(v == null ? '' : v).trim());

export function isHeaderSafe(v: unknown): boolean {
  const s = String(v == null ? '' : v);
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return false;
  return true;
}

export function sanitizeSecret(v: unknown): string {
  const s = String(v == null ? '' : v).trim();
  if (!s || isMaskedSecret(s) || !isHeaderSafe(s)) return '';
  return s;
}

export function isLocalUrl(url: string): boolean {
  return /(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|192\.168\.|10\.\d|172\.(1[6-9]|2\d|3[01])\.)/.test(
    String(url || ''),
  );
}

export function classifyByKeywords(text: string): { category: string; kind: 'income' | 'expense' } | null {
  const s = String(text || '');
  for (const [re, category, kind] of KEYWORD_RULES) {
    if (re.test(s)) return { category, kind };
  }
  return null;
}

export function guessAccountName(text: string): string | null {
  for (const [re, name] of ACCOUNT_KEYWORDS) {
    if (re.test(String(text || ''))) return name;
  }
  return null;
}

export function parseDateWords(text: string, today = todayStr()): string {
  const s = String(text || '');
  if (/前天/.test(s)) return addDays(today, -2);
  if (/昨天|昨晚|昨日/.test(s)) return addDays(today, -1);
  if (/今天|刚刚|今早|今晚|刚才/.test(s)) return today;
  let m = s.match(/(20\d{2})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[-\/月](\d{1,2})/);
  if (m) return `${today.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (m) return `${today.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return today;
}

export function extractAmount(text: string): number {
  const s = String(text || '');
  const m =
    s.match(/(?:¥|￥|RMB|CNY)\s*([\d,]+(?:\.\d{1,2})?)/i) ||
    s.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:元|块钱|块|圆)/) ||
    s.match(/(?:金额|总计|合计|实付|支付|付款|收入|支出)[:：\s]*([\d,]+(?:\.\d{1,2})?)/);
  if (m) return parseAmountToCents(m[1]);
  const noDate = s
    .replace(/20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2}[日号]?/g, ' ')
    .replace(/\d{1,2}[-/月]\d{1,2}[日号]?/g, ' ');
  const nums = (noDate.match(/\d+(?:\.\d{1,2})?/g) || []).filter((n) => !/^(19|20)\d{2}$/.test(n));
  if (!nums.length) return 0;
  return parseAmountToCents(nums.sort((a, b) => Number(b) - Number(a))[0]);
}

export function cleanMerchant(line: string): string | null {
  const s = String(line)
    .replace(/(?:¥|￥|RMB|CNY)\s*[\d,]+(?:\.\d{1,2})?/gi, ' ')
    .replace(/[\d,]+(?:\.\d{1,2})?\s*(?:元|块钱|块|圆)/g, ' ')
    .replace(/(今天|昨天|前天|昨晚|今早|刚刚|刚才|上午|下午|晚上|中午)/g, ' ')
    .replace(/(支付宝|微信支付|微信|花呗|余额宝|云闪付|信用卡|现金|银行卡|零钱通|白条)/g, ' ')
    .replace(/[，,。.、:：!！?？\-—_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 40) || null;
}

export function parseTextByRules(text: string, { today = todayStr() }: { today?: string } = {}) {
  const lines = String(text || '')
    .split(/\n|;|；|，|,|。/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const amount = extractAmount(line);
    if (!amount) continue;
    const cls = classifyByKeywords(line);
    const kind = /收入|工资|报销|退款|收|入账/.test(line) && !cls ? 'income' : cls?.kind || 'expense';
    out.push({
      type: /转账|转出|转到/.test(line) ? 'transfer' : kind === 'income' ? 'income' : 'expense',
      amount_cents: amount,
      currency: 'CNY',
      txn_date: parseDateWords(line, today),
      merchant: cleanMerchant(line),
      note: line.slice(0, 120),
      category_name: cls?.category || null,
      account_name: guessAccountName(line),
      confidence: 0.45,
      engine: 'rule' as const,
    });
  }
  return out;
}

export function extractJson(text: unknown): unknown {
  if (!text) return null;
  const s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  try {
    return JSON.parse(body.trim());
  } catch {
    /* try slices */
  }
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(body.slice(first, last + 1));
    } catch {
      /* ignore */
    }
  }
  const arrFirst = body.indexOf('[');
  const arrLast = body.lastIndexOf(']');
  if (arrFirst >= 0 && arrLast > arrFirst) {
    try {
      return JSON.parse(body.slice(arrFirst, arrLast + 1));
    } catch {
      /* ignore */
    }
  }
  return null;
}

const NON_CHAT_HINTS = /(embedding|bge-|rerank|whisper|tts|dall-e|stable-diffusion|moderation|speech)/i;
const VISION_HINTS =
  /(vl|vision|[0-9]v-|[0-9]v\b|omni|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|internvl|llava|minicpm-v|moondream|pixtral)/i;

export function guessVision(modelId: string): boolean | null {
  const id = String(modelId || '');
  if (NON_CHAT_HINTS.test(id)) return false;
  if (VISION_HINTS.test(id)) return true;
  return null;
}

export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  apiKeyInvalid: boolean;
  model: string;
  vision: boolean;
  autoSave: boolean;
  timeoutMs: number;
}

export async function getAiConfig(db: Db): Promise<AiConfig> {
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'ai.%'");
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  const rawKey = String(map['ai.api_key'] || '').trim();
  const apiKey = sanitizeSecret(rawKey);
  return {
    enabled: String(map['ai.enabled'] || 'false') === 'true',
    baseUrl: String(map['ai.base_url'] || '').replace(/\/+$/, ''),
    apiKey,
    apiKeyInvalid: Boolean(rawKey && !apiKey),
    model: String(map['ai.model'] || '').trim(),
    vision: String(map['ai.vision'] ?? 'true') === 'true',
    autoSave: String(map['ai.auto_save'] || 'false') === 'true',
    timeoutMs: Number(map['ai.timeout_ms'] || '90000') || 90000,
  };
}

export async function isAiReady(db: Db): Promise<boolean> {
  const c = await getAiConfig(db);
  return !!c.baseUrl && !!c.model && (!!c.apiKey || isLocalUrl(c.baseUrl));
}

export async function isAiUsable(db: Db): Promise<boolean> {
  const c = await getAiConfig(db);
  return c.enabled && !!c.baseUrl && !!c.model && (!!c.apiKey || isLocalUrl(c.baseUrl));
}

export async function callModel(messages: unknown[], cfg: AiConfig): Promise<string> {
  if (!cfg.baseUrl || !cfg.model) throw new Error('未配置 AI 模型');
  if (!isHeaderSafe(cfg.baseUrl) || !isHeaderSafe(cfg.model)) {
    throw new Error('接口地址或模型名含有非法字符（可能是复制粘贴带入了中文或全角符号），请在「设置 → AI 识别」中重新填写');
  }
  if (cfg.apiKey && !isHeaderSafe(cfg.apiKey)) {
    throw new Error('API Key 含有非法字符（可能复制时带入了全角符号或占位圆点），请在「设置 → AI 识别」中重新粘贴');
  }
  const url = `${cfg.baseUrl}/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 90000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.1, stream: false }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw.slice(0, 400);
      try {
        msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message || msg;
      } catch {
        /* ignore */
      }
      if (!cfg.apiKey && (res.status === 401 || res.status === 403)) {
        msg += '（该接口需要 API Key，请到「设置 → AI 识别」填写后再试）';
      }
      throw new Error(`模型返回 ${res.status}：${msg}`);
    }
    let data: { choices?: Array<{ message?: { content?: unknown } }> };
    try {
      data = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    } catch {
      throw new Error('模型返回内容无法解析为 JSON');
    }
    const content = data.choices?.[0]?.message?.content;
    if (content === undefined) throw new Error(`模型未返回内容：${raw.slice(0, 200)}`);
    return typeof content === 'string' ? content : JSON.stringify(content);
  } finally {
    clearTimeout(timer);
  }
}

export async function buildContext(db: Db, ledgerId: number) {
  const [cats, accounts, members] = await Promise.all([
    db.all<{ id: number; name: string; kind: string; parent: string | null }>(
      `SELECT c.id, c.name, c.kind, p.name AS parent FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id
       WHERE (c.ledger_id IS NULL OR c.ledger_id = ?) AND c.is_archived = 0`,
      ledgerId,
    ),
    db.all<{ id: number; name: string; type: string }>(
      'SELECT id, name, type FROM accounts WHERE ledger_id = ? AND is_archived = 0',
      ledgerId,
    ),
    db.all<{ name: string }>(
      'SELECT u.display_name AS name FROM ledger_members m JOIN users u ON u.id = m.user_id WHERE m.ledger_id = ?',
      ledgerId,
    ),
  ]);
  const expensePaths = cats.filter((c) => c.kind === 'expense').map((c) => (c.parent ? `${c.parent}/${c.name}` : c.name));
  const incomePaths = cats.filter((c) => c.kind === 'income').map((c) => (c.parent ? `${c.parent}/${c.name}` : c.name));
  return { cats, expensePaths, incomePaths, accounts, members };
}

export function buildUserPrompt({
  text,
  ctx,
  today,
}: {
  text?: string;
  ctx: Awaited<ReturnType<typeof buildContext>>;
  today: string;
}): string {
  return [
    `今天是 ${today}。`,
    `可选支出分类（完整路径）：${ctx.expensePaths.join('、')}`,
    `可选收入分类（完整路径）：${ctx.incomePaths.join('、')}`,
    `可用账户：${ctx.accounts.map((a) => a.name).join('、') || '（无）'}`,
    `账本成员：${ctx.members.map((m) => m.name).join('、') || '（无）'}`,
    text ? `需要识别的账单文字：\n${text}` : '请识别随附的账单截图。若有多张图片，请合并提取所有交易。',
  ].join('\n');
}

export async function resolveCategoryId(
  db: Db,
  ledgerId: number,
  nameHint: string | null | undefined,
  kind: 'expense' | 'income',
): Promise<number | null> {
  if (!nameHint) return null;
  const hint = String(nameHint).trim();
  const rows = await db.all<{ id: number; name: string; kind: string; parent: string | null }>(
    `SELECT c.id, c.name, c.kind, p.name AS parent FROM categories c
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE (c.ledger_id IS NULL OR c.ledger_id = ?) AND c.kind = ? AND c.is_archived = 0`,
    ledgerId,
    kind,
  );
  const norm = (s: string) => String(s || '').replace(/\s/g, '');
  const target = norm(hint);
  for (const r of rows) {
    const full = r.parent ? `${r.parent}/${r.name}` : r.name;
    if (norm(full) === target) return Number(r.id);
  }
  for (const r of rows) if (norm(r.name) === target) return Number(r.id);
  const tail = target.includes('/') ? target.split('/').pop() || target : target;
  for (const r of rows) if (norm(r.name) === norm(tail)) return Number(r.id);
  for (const r of rows) {
    if (norm(r.name).includes(tail) || tail.includes(norm(r.name))) return Number(r.id);
    if (r.parent && (norm(r.parent).includes(tail) || tail.includes(norm(r.parent)))) return Number(r.id);
  }
  const kw = classifyByKeywords(hint);
  if (kw) {
    for (const r of rows) if (norm(r.name) === norm(kw.category)) return Number(r.id);
    for (const r of rows) if (r.parent && norm(r.parent) === norm(kw.category)) return Number(r.id);
  }
  return null;
}

export async function resolveAccountId(
  db: Db,
  ledgerId: number,
  nameHint: string | null | undefined,
): Promise<number | null> {
  if (!nameHint) return null;
  const accounts = await db.all<{ id: number; name: string }>(
    'SELECT id, name FROM accounts WHERE ledger_id = ? AND is_archived = 0',
    ledgerId,
  );
  const hint = String(nameHint).replace(/\s/g, '');
  for (const a of accounts) {
    const n = a.name.replace(/\s/g, '');
    if (hint.includes(n) || n.includes(hint)) return Number(a.id);
  }
  for (const a of accounts) {
    if ((hint.includes('支付宝') || hint.includes('花呗')) && /支付宝|花呗/.test(a.name)) return Number(a.id);
    if (hint.includes('微信') && /微信/.test(a.name)) return Number(a.id);
    if (hint.includes('现金') && /现金/.test(a.name)) return Number(a.id);
    if (hint.includes('信用') && /信用/.test(a.name)) return Number(a.id);
  }
  return null;
}

export interface NormalizedBillItem {
  draft_id: string;
  type: 'expense' | 'income' | 'transfer';
  amount_cents: number;
  currency: string;
  txn_date: string;
  merchant: string | null;
  note: string | null;
  category_id: number | null;
  category_name: string | null;
  account_id: number | null;
  account_name: string | null;
  confidence: number;
  raw: Record<string, unknown>;
}

export async function normalizeItem(
  db: Db,
  raw: Record<string, unknown>,
  ledgerId: number,
): Promise<NormalizedBillItem> {
  const type = (['expense', 'income', 'transfer'].includes(String(raw.type)) ? raw.type : 'expense') as
    | 'expense'
    | 'income'
    | 'transfer';
  const kind: 'income' | 'expense' = type === 'income' ? 'income' : 'expense';
  const amountCents = Number.isFinite(Number(raw.amount_cents))
    ? Number(raw.amount_cents)
    : parseAmountToCents(raw.amount);
  const catName = (raw.category_name || raw.category || null) as string | null;
  let categoryId = await resolveCategoryId(db, ledgerId, catName, kind);
  if (!categoryId && type !== 'transfer') {
    const kw = classifyByKeywords(`${raw.merchant || ''} ${raw.note || ''} ${catName || ''}`);
    if (kw) categoryId = await resolveCategoryId(db, ledgerId, kw.category, kw.kind === 'income' ? 'income' : kind);
    if (!categoryId) {
      categoryId = await resolveCategoryId(db, ledgerId, kind === 'income' ? '其他收入' : '其他支出', kind);
    }
  }
  const acctName = (raw.acct || raw.account || raw.account_name || null) as string | null;
  return {
    draft_id: uid(10),
    type,
    amount_cents: Math.abs(amountCents || 0),
    currency: String(raw.currency || 'CNY'),
    txn_date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.txn_date || '')) ? String(raw.txn_date) : todayStr(),
    merchant: raw.merchant ? String(raw.merchant).slice(0, 60) : null,
    note: raw.note ? String(raw.note).slice(0, 200) : null,
    category_id: categoryId,
    category_name: catName,
    account_id: await resolveAccountId(db, ledgerId, acctName),
    account_name: acctName,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.8,
    raw,
  };
}

export async function analyzeBill(
  db: Db,
  {
    images = [],
    text = '',
    ledgerId,
  }: {
    images?: Array<string | { dataUrl?: string; url?: string }>;
    text?: string;
    ledgerId: number;
  },
) {
  const cfg = await getAiConfig(db);
  const ctx = await buildContext(db, ledgerId);
  const today = todayStr();
  const warnings: string[] = [];
  const usable = cfg.enabled && !!cfg.baseUrl && !!cfg.model && (!!cfg.apiKey || isLocalUrl(cfg.baseUrl));
  const ready = !!cfg.baseUrl && !!cfg.model && (!!cfg.apiKey || isLocalUrl(cfg.baseUrl));
  const canUseModel = usable && ((images.length > 0 && cfg.vision) || Boolean(text));
  if (canUseModel) {
    try {
      const content: Array<Record<string, unknown>> = [
        { type: 'text', text: buildUserPrompt({ text, ctx, today }) },
      ];
      for (const img of images.slice(0, 6)) {
        const url = typeof img === 'string' ? img : String(img?.dataUrl || img?.url || '');
        if (!url) continue;
        content.push({ type: 'image_url', image_url: { url } });
      }
      if (content.length === 1 && images.length) {
        warnings.push('图片数据为空，已跳过视觉识别（请检查上传/传参格式）。');
        throw new Error('图片数据为空');
      }
      const out = await callModel(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        cfg,
      );
      const parsed = extractJson(out) as { items?: unknown[] } | unknown[] | null;
      const items = Array.isArray(parsed) ? parsed : parsed?.items;
      if (Array.isArray(items) && items.length) {
        return {
          engine: 'llm' as const,
          model: cfg.model,
          items: await Promise.all(
            items.map((it) => normalizeItem(db, (it || {}) as Record<string, unknown>, ledgerId)),
          ),
          warnings,
        };
      }
      warnings.push('模型未返回可识别的交易，已尝试规则解析兜底。');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== '图片数据为空') warnings.push(`AI 调用失败（${msg}），已降级为规则解析。`);
    }
  } else if (images.length && !cfg.vision) {
    warnings.push('当前模型未开启视觉能力，无法读取截图内容。');
  } else if (!ready) {
    warnings.push('尚未配置 AI 模型，当前使用内置规则解析（在「设置 → AI 记账」中配置后可获得更强识别能力）。');
  }
  if (text) {
    const items = parseTextByRules(text, { today }).map((it) => normalizeItem(db, it, ledgerId));
    const done = await Promise.all(items);
    if (done.length) return { engine: 'rule' as const, model: null, items: done, warnings };
  }
  return { engine: 'rule' as const, model: null, items: [], warnings };
}

export async function testConnection(db: Db, override: Record<string, unknown> = {}) {
  const cfg = await getAiConfig(db);
  const baseUrl = String(override.baseUrl || override.base_url || cfg.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(override.model || cfg.model || '').trim();
  const givenKey = sanitizeSecret(override.apiKey || override.api_key || '');
  const apiKey = givenKey || cfg.apiKey;
  if (!baseUrl || !model) return { ok: false, error: '请先填写接口地址与模型名称' };
  try {
    const out = await callModel(
      [
        { role: 'system', content: '你是一个测试助手，只输出 JSON。' },
        { role: 'user', content: '请输出 {"ok":true,"msg":"连接正常"}' },
      ],
      { ...cfg, baseUrl, model, apiKey, timeoutMs: 30000 },
    );
    return { ok: true, raw: out.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listModels(db: Db, override: Record<string, unknown> = {}) {
  const cfg = await getAiConfig(db);
  const baseUrl = String(override.baseUrl || override.base_url || cfg.baseUrl || '').trim().replace(/\/+$/, '');
  const given = sanitizeSecret(override.apiKey || override.api_key || '');
  const apiKey = given || cfg.apiKey;
  if (!baseUrl) throw new Error('请先填写接口地址（Base URL）');
  if (!isHeaderSafe(baseUrl)) throw new Error('接口地址含有非法字符（可能带入了中文或全角符号），请重新填写');
  if (apiKey && !isHeaderSafe(apiKey)) throw new Error('API Key 含有非法字符（复制时可能带入了全角符号），请重新粘贴');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw.slice(0, 300);
      try {
        msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message || msg;
      } catch {
        /* ignore */
      }
      if (!apiKey && (res.status === 401 || res.status === 403)) msg += '（该接口需要 API Key，请填写后再试）';
      if (res.status === 404) msg += '（该网关可能未实现 /models 接口，请手动填写模型名）';
      throw new Error(`获取模型列表失败：HTTP ${res.status} ${msg}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('模型列表返回内容不是 JSON');
    }
    const obj = data as { data?: unknown[]; models?: unknown[] };
    const arr = Array.isArray(data) ? data : obj.data || obj.models || [];
    const models: Array<{ id: string; owned_by: string | null; vision: boolean | null }> = [];
    for (const m of arr) {
      const mObj = m as { id?: string; name?: string; model?: string; owned_by?: string };
      const id = typeof m === 'string' ? m : mObj?.id || mObj?.name || mObj?.model;
      if (!id) continue;
      models.push({
        id: String(id),
        owned_by: typeof m === 'object' && m && mObj.owned_by ? String(mObj.owned_by) : null,
        vision: guessVision(String(id)),
      });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { baseUrl, count: models.length, models };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('获取模型列表超时，请检查接口地址是否可达');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
