/**
 * 常量定义 - 产品类型、平台枚举、分析类型等
 */

// 产品类型
const PRODUCT_TYPES = {
  STOCK: { key: 'stock', name: '股票', tag: 'tag-stock' },
  ETF: { key: 'etf', name: 'ETF', tag: 'tag-etf' },
  LOF: { key: 'lof', name: 'LOF', tag: 'tag-lof' },
  FUND_STOCK: { key: 'fund_stock', name: '股票型基金', tag: 'tag-fund' },
  FUND_MIX: { key: 'fund_mix', name: '混合型基金', tag: 'tag-fund' },
  FUND_BOND: { key: 'fund_bond', name: '债券型基金', tag: 'tag-fund' },
  FUND_INDEX: { key: 'fund_index', name: '指数型基金', tag: 'tag-fund' },
  FUND_MONEY: { key: 'fund_money', name: '货币型基金', tag: 'tag-money' },
  REIT: { key: 'reit', name: 'REITs', tag: 'tag-lof' },
};

// 产品类型层级树（用于选择器）
const PRODUCT_TYPE_TREE = [
  {
    label: '股票',
    children: [
      { key: 'stock', label: 'A股' },
      { key: 'hk_stock', label: '港股' },
      { key: 'us_stock', label: '美股' },
    ]
  },
  {
    label: '场内基金',
    children: [
      { key: 'etf', label: 'ETF' },
      { key: 'lof', label: 'LOF' },
      { key: 'reit', label: 'REITs' },
    ]
  },
  {
    label: '场外基金',
    children: [
      { key: 'fund_stock', label: '股票型' },
      { key: 'fund_mix', label: '混合型' },
      { key: 'fund_bond', label: '债券型' },
      { key: 'fund_index', label: '指数型' },
      { key: 'fund_money', label: '货币型' },
    ]
  },
  { key: 'cash', label: '现金 / 余额' },
];

// 交易所
const EXCHANGES = [
  { key: 'SH', name: '上海' },
  { key: 'SZ', name: '深圳' },
  { key: 'HK', name: '港股' },
  { key: 'US', name: '美股' },
];

// 账户平台类型
const ACCOUNT_PLATFORMS = [
  { key: 'stock', name: '证券账户', platforms: [
    { key: 'huatai', name: '华泰证券' },
    { key: 'citic', name: '中信证券' },
    { key: 'csc', name: '招商证券' },
    { key: 'guotai', name: '国泰君安' },
    { key: 'eastern', name: '东方财富' },
    { key: 'other_broker', name: '其他券商' },
  ]},
  { key: 'fund_platform', name: '基金平台', platforms: [
    { key: 'qieman', name: '且慢' },
    { key: 'antsfund', name: '蚂蚁基金' },
    { key: 'tenfund', name: '天天基金' },
    { key: 'htfund', name: '同花顺爱基金' },
    { key: 'other_fund', name: '其他平台' },
  ]},
  { key: 'custom', name: '自定义' },
];

// AI 分析类型
const ANALYSIS_TYPES = [
  { key: 'portfolio_health', name: '持仓健康度', icon: '🟢', description: '集中度、行业分布、费率分析' },
  { key: 'pnl_analysis', name: '盈亏归因分析', icon: '🟡', description: '逐产品盈亏拆解、跑赢/跑输基准' },
  { key: 'rebalance_advice', name: '调仓建议', icon: '🟠', description: '基于当前持仓给出调仓建议' },
  { key: 'risk_analysis', name: '风险暴露评估', icon: '🔴', description: '单一暴露度、回撤估算、市场风险' },
];

// 支持的 LLM 模型
const LLM_PROVIDERS = [
  { key: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat', baseURL: 'https://api.deepseek.com', icon: '🧠',
    models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'qwen', name: '通义千问', defaultModel: 'qwen-plus', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', icon: '🌐',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long', 'qwen2.5-72b-instruct'] },
  { key: 'glm', name: 'GLM (智谱)', defaultModel: 'glm-4', baseURL: 'https://open.bigmodel.cn/api/paas/v4', icon: '📊',
    models: ['glm-4', 'glm-4-plus', 'glm-4-flash', 'glm-4-air', 'glm-4-long'] },
  { key: 'kimi', name: 'Kimi (月之暗面)', defaultModel: 'moonshot-v1-8k', baseURL: 'https://api.moonshot.cn/v1', icon: '🌙',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { key: 'chatgpt', name: 'ChatGPT', defaultModel: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', icon: '💬',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  { key: 'claude', name: 'Claude', defaultModel: 'claude-sonnet-4-20250514', baseURL: 'https://api.anthropic.com/v1', icon: '🤖',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307', 'claude-3-opus-20240229'] },
  { key: 'bailian', name: '阿里百炼', defaultModel: 'qwen-max', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', icon: '🔥',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-72b-instruct', 'qwen2.5-32b-instruct'] },
  { key: 'mimo', name: '小米 MiMo', defaultModel: 'mimo-v2.5-pro', baseURL: 'https://api.xiaomimimo.com/v1', icon: '📱',
    models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro', 'mimo-v2-flash'] },
  { key: 'minimax', name: 'MiniMax', defaultModel: 'MiniMax-Text-01', baseURL: 'https://api.minimax.chat/v1', icon: '🅼',
    models: ['MiniMax-Text-01', 'abab6.5s-chat', 'abab5.5s-chat', 'MiniMax-VL-01'] },
  { key: 'custom', name: '自定义模型', defaultModel: '', baseURL: '', icon: '🔌',
    models: [] },
];

// 新闻分类
const NEWS_CATEGORIES = [
  { key: 'all', name: '全部' },
  { key: 'market', name: '大盘' },
  { key: 'industry', name: '行业' },
  { key: 'company', name: '公司' },
  { key: 'policy', name: '政策' },
  { key: 'global', name: '国际' },
];

// 交易流水类型
const TRANSACTION_TYPES = [
  { key: 'buy', name: '买入', sign: '-' },
  { key: 'sell', name: '卖出', sign: '+' },
  { key: 'ipo_win', name: '打新中签', sign: '-' },
  { key: 'dividend', name: '分红', sign: '+' },
  { key: 'stock_dividend', name: '红股入账', sign: '' },
  { key: 'split', name: '拆分/合并', sign: '' },
  { key: 'tax', name: '纳税', sign: '-' },
  { key: 'transfer_in', name: '银证转入', sign: '+' },
  { key: 'transfer_out', name: '银证转出', sign: '-' },
  { key: 'fee', name: '手续费', sign: '-' },
  { key: 'interest', name: '利息', sign: '+' },
];

// 云函数名
const CLOUD_FUNCTIONS = {
  SYNC_PRICES: 'sync_prices',
  REFRESH_PRICES: 'refresh_prices',
  LLM_GATEWAY: 'llm_gateway',
  ENCRYPT_API_KEY: 'encrypt_api_key',
  FETCH_NEWS: 'fetch_news',
  PUSH_NEWS: 'push_news',
  GET_HOLDINGS_ANALYSIS: 'get_holdings_analysis',
  PARSE_IMPORT: 'parse_import',
  EXPORT_DATA: 'export_data',
  PARSE_TRADES_BY_TEXT: 'parse_trades_by_text',
  SAVE_NOTIFY_SETTINGS: 'save_notify_settings',
  GET_NOTIFY_SETTINGS: 'get_notify_settings',
  CHECK_PRICE_ALERT: 'check_price_alert',
  INFER_INDUSTRY: 'infer_industry',
};

module.exports = {
  PRODUCT_TYPES,
  PRODUCT_TYPE_TREE,
  EXCHANGES,
  ACCOUNT_PLATFORMS,
  ANALYSIS_TYPES,
  LLM_PROVIDERS,
  NEWS_CATEGORIES,
  TRANSACTION_TYPES,
  CLOUD_FUNCTIONS,
};
