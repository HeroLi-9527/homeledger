export type AccountGroupKey = 'funds' | 'prepaid' | 'credit';

export interface AccountGroupMeta {
  key: AccountGroupKey;
  label: string;
  icon: string;
  desc: string;
}

export interface AccountTypeMeta {
  key: string;
  label: string;
  icon: string;
  nature: 'asset' | 'liability';
  group: AccountGroupKey;
}

export interface TxnTypeMeta {
  key: string;
  label: string;
  icon: string;
  color: string;
  flow: 'out' | 'in' | 'move' | 'adjust';
  group: string;
}

export type CategorySeedGroup = [topName: string, topIcon: string, color: string, children: string[]];

export const ACCOUNT_GROUPS: AccountGroupMeta[] = [
  { key: 'funds', label: '资金账户', icon: '💰', desc: '现金、储蓄卡、微信/支付宝、投资与往来' },
  { key: 'prepaid', label: '充值账户', icon: '🎟️', desc: '储值预付卡与按次核销次卡' },
  { key: 'credit', label: '信用账户', icon: '💳', desc: '信用卡、花呗、白条、应付与贷款' },
];

export const ACCOUNT_TYPES: AccountTypeMeta[] = [
  { key: 'cash', label: '现金', icon: '💵', nature: 'asset', group: 'funds' },
  { key: 'debit', label: '储蓄卡', icon: '🏦', nature: 'asset', group: 'funds' },
  { key: 'credit', label: '信用卡 / 花呗 / 白条', icon: '💳', nature: 'liability', group: 'credit' },
  { key: 'virtual', label: '虚拟账户（支付宝/微信）', icon: '📱', nature: 'asset', group: 'funds' },
  { key: 'prepaid', label: '储值卡/预付', icon: '🎫', nature: 'asset', group: 'prepaid' },
  { key: 'investment', label: '投资账户', icon: '📈', nature: 'asset', group: 'funds' },
  { key: 'receivable', label: '应收款（别人欠我）', icon: '📥', nature: 'asset', group: 'funds' },
  { key: 'payable', label: '应付款（我欠别人）', icon: '📤', nature: 'liability', group: 'credit' },
  { key: 'loan', label: '贷款/负债', icon: '🏚️', nature: 'liability', group: 'credit' },
  { key: 'other', label: '其他', icon: '📦', nature: 'asset', group: 'funds' },
];

export const TXN_TYPES: TxnTypeMeta[] = [
  { key: 'expense', label: '支出', icon: '💸', color: '#f5222d', flow: 'out', group: '日常' },
  { key: 'income', label: '收入', icon: '💰', color: '#52c41a', flow: 'in', group: '日常' },
  { key: 'transfer', label: '转账', icon: '🔄', color: '#1677ff', flow: 'move', group: '日常' },
  { key: 'lend', label: '借出', icon: '📤', color: '#fa8c16', flow: 'out', group: '借贷' },
  { key: 'borrow', label: '借入', icon: '📥', color: '#fa8c16', flow: 'in', group: '借贷' },
  { key: 'repay_receive', label: '收回借款', icon: '↩️', color: '#13c2c2', flow: 'in', group: '借贷' },
  { key: 'repay_pay', label: '偿还借款', icon: '↪️', color: '#13c2c2', flow: 'out', group: '借贷' },
  { key: 'reimburse', label: '报销入账', icon: '🧾', color: '#722ed1', flow: 'in', group: '报销' },
  { key: 'refund', label: '退款', icon: '↩️', color: '#52c41a', flow: 'in', group: '日常' },
  { key: 'fee', label: '手续费', icon: '🏷️', color: '#8c8c8c', flow: 'out', group: '金融' },
  { key: 'interest', label: '利息收入', icon: '🏦', color: '#52c41a', flow: 'in', group: '金融' },
  { key: 'invest_buy', label: '投资买入', icon: '📉', color: '#1677ff', flow: 'move', group: '投资' },
  { key: 'invest_sell', label: '投资卖出', icon: '📈', color: '#fa541c', flow: 'move', group: '投资' },
  { key: 'adjust', label: '余额调整', icon: '⚖️', color: '#8c8c8c', flow: 'adjust', group: '其他' },
];

export const EXPENSE_SEED: CategorySeedGroup[] = [
  ['餐饮', '🍽️', '#ff7a45', ['早餐:🥣', '午餐:🍚', '晚餐:🍜', '外卖:🛵', '零食:🍪', '饮料:🧋', '咖啡:☕', '水果:🍎', '下馆子:🍢', '烟酒:🚬']],
  ['交通', '🚗', '#1677ff', ['公交:🚌', '地铁:🚇', '打车:🚕', '加油:⛽', '停车:🅿️', '过路费:🛣️', '洗车:🚿', '车辆保养:🔧', '车辆维修:🛠️', '车险:🛡️', '年检:📋', '火车:🚄', '飞机:✈️', '共享单车:🚲']],
  ['购物', '🛍️', '#eb2f96', ['日用百货:🧺', '个护清洁:🧴', '家居用品:🛋️', '数码电器:📺', '家纺布艺:🧵', '五金工具:🔨', '礼品:🎁', '其他购物:🛒']],
  ['服饰', '👕', '#f759ab', ['上衣:👕', '裤装:👖', '鞋靴:👟', '内衣袜:🧦', '外套:🧥', '配饰:💍', '箱包:👜', '理发美发:💇']],
  ['居住', '🏠', '#722ed1', ['房租:🏠', '房贷:🏦', '物业费:🏢', '水费:🚰', '电费:💡', '燃气费:🔥', '取暖费:♨️', '宽带费:📶', '家政保洁:🧹', '家电维修:🛠️', '装修:🧱']],
  ['通讯', '📱', '#13c2c2', ['手机话费:📱', '流量充值:🌐', '宽带:📡', '快递邮费:📮', '云服务:☁️']],
  ['娱乐', '🎮', '#fa541c', ['电影:🎬', '游戏:🎮', '演出展览:🎤', '会员订阅:📺', '酒吧:🍺', 'KTV:🎙️', '玩具:🧸', '书籍影音:📚', '旅游门票:🎫']],
  ['医疗健康', '🏥', '#ff4d4f', ['门诊:🩺', '药品:💊', '住院:🛏️', '体检:📋', '牙科:🦷', '眼科:👁️', '保健品:🧴', '医疗器械:🩹', '心理咨询:🧠']],
  ['保险', '🛡️', '#40a9ff', ['重疾险:🛡️', '医疗险:🏥', '寿险:📜', '意外险:⚠️', '车险:🚗', '财产险:🏠', '社保:🏛️', '公积金:🏦']],
  ['教育', '🎓', '#2f54eb', ['学费:🎓', '培训费:📖', '教材文具:📕', '课外班:✏️', '在线课程:💻', '考试报名:📝', '考证:🎯']],
  ['人情往来', '🧧', '#f5222d', ['红包:🧧', '礼金:🎁', '请客:🍻', '孝敬长辈:👴', '随份子:💐', '慈善捐赠:❤️', '送礼:🎀']],
  ['育儿', '🍼', '#fa8c16', ['奶粉:🍼', '尿不湿:🧷', '童装:👶', '玩具:🧸', '早教:🎨', '托育:🏫', '儿童医疗:🏥', '儿童保险:🛡️']],
  ['宠物', '🐾', '#faad14', ['宠物主粮:🥫', '宠物零食:🦴', '宠物医疗:💉', '宠物用品:🧶', '宠物美容:✂️', '宠物寄养:🏠']],
  ['运动健身', '🏀', '#52c41a', ['健身卡:🏋️', '运动装备:👟', '球类:🏀', '场地费:⚽', '户外露营:⛺', '游泳:🏊', '赛事报名:🏅']],
  ['旅行', '✈️', '#08979c', ['机票:✈️', '酒店:🏨', '当地交通:🚗', '景点门票:🎫', '跟团游:🧳', '签证:📄', '旅行购物:🛍️', '旅行保险:🛡️']],
  ['美容护理', '💄', '#eb2f96', ['化妆品:💄', '护肤品:🧴', '美甲:💅', '美容SPA:💆', '医美:✨', '美睫:👁️']],
  ['数码科技', '💻', '#597ef7', ['手机:📱', '电脑:💻', '外设配件:🖱️', '软件购买:💿', '智能家居:🏠', '游戏设备:🕹️', '充电设备:🔌']],
  ['办公经营', '💼', '#1d39c4', ['办公用品:🖇️', '打印耗材:🖨️', '差旅:🧳', '团建:🎉', '软件服务:💻', '广告推广:📣', '设备采购:🖥️', '商务招待:🤝']],
  ['金融支出', '🧾', '#8c8c8c', ['手续费:🧾', '利息支出:💸', '税费:🧮', '罚款违约金:🚨', '信用卡年费:💳', '投资亏损:📉', '兑换损失:💱']],
  ['其他支出', '❓', '#8c8c8c', ['待分类:📦', '丢失:🔍', '其他:❓']],
];

export const INCOME_SEED: CategorySeedGroup[] = [
  ['职业收入', '💼', '#52c41a', ['工资:💰', '奖金:🏆', '加班费:⏰', '补贴:🎫', '年终奖:🎊', '提成:📈', '公积金提取:🏛️']],
  ['经营收入', '🏪', '#13c2c2', ['营业收入:🏪', '项目款:📄', '分销分成:🤝', '带货佣金:🛒']],
  ['投资理财', '📈', '#fa541c', ['基金收益:📊', '股票收益:📈', '利息收入:🏦', '理财收益:💹', '债券收益:📜', '黄金收益:🥇', '房租收入:🏘️', '分红:🍰']],
  ['其他收入', '✨', '#722ed1', ['兼职外快:💼', '报销回款:🧾', '退款:↩️', '红包:🧧', '礼金:🎁', '中奖:🎰', '二手闲置:♻️', '保险理赔:🛡️', '赔偿:⚖️', '其他收入:❓']],
];

export const ACCOUNT_TYPE_MAP: Record<string, AccountTypeMeta> = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.key, t]));
export const TXN_TYPE_MAP: Record<string, TxnTypeMeta> = Object.fromEntries(TXN_TYPES.map((t) => [t.key, t]));
export const PRIMARY_TXN_TYPES = ['expense', 'income', 'transfer', 'lend'] as const;

export function accountGroupOf(type?: string | null): AccountGroupKey {
  return ACCOUNT_TYPE_MAP[type || '']?.group || 'funds';
}

export function isCreditGroupType(type?: string | null): boolean {
  return accountGroupOf(type) === 'credit';
}
