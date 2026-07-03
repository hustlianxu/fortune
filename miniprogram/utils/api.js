/**
 * 云函数调用封装
 */
const { CLOUD_FUNCTIONS } = require('./constants');

/**
 * 通用云函数调用
 * @param {string} name - 云函数名
 * @param {object} data - 请求参数
 * @param {object} [opts] - 可选参数
 *   @param {number} [opts.timeout] - 单次调用超时（毫秒），用于 AI 分析等长任务
 * @returns {Promise<object>}
 */
async function callCloudFunction(name, data = {}, opts = {}) {
  // 防御：name 缺失时直接抛错，避免触发微信「FunctionName parameter could not be found」
  // （errCode -501000），与框架内置 IndustryTask 报错区分开。
  if (!name || typeof name !== 'string') {
    const err = new Error('callCloudFunction: 缺少云函数名 name');
    console.error('[callCloudFunction] missing name:', name);
    throw err;
  }
  try {
    const callParams = { name, data };
    // 允许调用方传入自定义超时（毫秒）。微信小程序 wx.cloud.callFunction
    // 支持 timeout 选项，但实际生效值还受云函数侧配置限制（最大 60s）。
    if (opts.timeout) callParams.timeout = opts.timeout;
    const res = await wx.cloud.callFunction(callParams);
    return res.result;
  } catch (err) {
    console.error(`[callCloudFunction] ${name} error:`, err);
    throw err;
  }
}

/**
 * 刷新行情
 */
async function refreshPrices() {
  return callCloudFunction(CLOUD_FUNCTIONS.REFRESH_PRICES);
}

/**
 * AI 持仓分析（单模型）
 * @param {string} type - 分析类型
 * @param {string} provider - 模型提供商
 */
async function analyzePortfolio(type, provider) {
  // 多步 LLM 调用通常耗时较长，给到最大允许 60s
  return callCloudFunction(CLOUD_FUNCTIONS.LLM_GATEWAY, {
    type,
    provider,
  }, { timeout: 60000 });
}

/**
 * AI 持仓分析（多模型协作）
 * 多个分析师各自独立分析，再由指定汇总模型综合各报告给出最终结论
 * @param {string} type - 分析类型
 * @param {string[]} analysts - 分析师 provider 数组
 * @param {string} synthesizer - 汇总 provider（可选，默认取 analysts[0]）
 */
async function analyzePortfolioMulti(type, analysts, synthesizer) {
  return callCloudFunction(CLOUD_FUNCTIONS.LLM_GATEWAY, {
    type,
    analysts,
    synthesizer: synthesizer || (analysts[0] || ''),
  }, { timeout: 60000 });
}

/**
 * AI 智能问答
 * @param {string} question - 用户问题
 * @param {string} provider - 模型提供商
 */
async function askAI(question, provider) {
  return callCloudFunction(CLOUD_FUNCTIONS.LLM_GATEWAY, {
    type: 'qa',
    provider,
    question,
  }, { timeout: 60000 });
}

/**
 * 获取持仓分析数据
 */
async function getHoldingsAnalysis() {
  return callCloudFunction(CLOUD_FUNCTIONS.GET_HOLDINGS_ANALYSIS);
}

/**
 * 获取 AI 分析报告所需的 prompt + API Key（前端直调 LLM，绕过云函数 60s 限制）
 * @param {string} type - 分析类型
 * @param {string} provider - 模型提供商
 * @returns {Promise<{success, prompt, apiKey, baseURL, model, provider}>}
 */
async function prepareAnalysis(type, provider) {
  return callCloudFunction(CLOUD_FUNCTIONS.LLM_GATEWAY, {
    type,
    provider,
    return_prompt_only: true,
  }, { timeout: 30000 });
}

/**
 * 保存 AI 分析报告（前端直调 LLM 后，通过此函数持久化）
 */
async function saveAIReport(report) {
  return callCloudFunction(CLOUD_FUNCTIONS.SAVE_AI_REPORT, report);
}

/**
 * 获取历史分析报告列表（按 created_at 倒序，分页，可选按类型筛选）
 * @param {number} [skip=0] - 跳过条数
 * @param {number} [limit=10] - 单页条数
 * @param {string} [type] - 分析类型筛选（可选）
 * @returns {Promise<Array>} 报告数组
 */
async function getAnalysisReports(skip, limit, type) {
  try {
    const db = wx.cloud.database();
    const sk = skip || 0;
    const lm = limit || 10;
    let query = db.collection('analysis_reports').orderBy('created_at', 'desc');
    if (type) {
      query = query.where({ type });
    }
    const res = await query.skip(sk).limit(lm).get();
    return res.data || [];
  } catch (err) {
    console.error('[getAnalysisReports] error:', err);
    return [];
  }
}

/**
 * 保存/更新 LLM 配置（加密 API Key）
 */
async function saveLLMConfig(config) {
  return callCloudFunction(CLOUD_FUNCTIONS.ENCRYPT_API_KEY, {
    config,
  });
}

/**
 * 获取 LLM 配置
 */
async function getLLMConfig() {
  try {
    const db = wx.cloud.database();
    const res = await db.collection('llm_configs').get();
    return res.data[0] || null;
  } catch (err) {
    console.error('[getLLMConfig] error:', err);
    return null;
  }
}

/**
 * 获取资讯列表
 */
async function getNews(category = 'all') {
  try {
    const db = wx.cloud.database();
    let query = db.collection('news_cache').orderBy('publish_time', 'desc').limit(50);
    if (category !== 'all') {
      query = query.where({ category });
    }
    const res = await query.get();
    return res.data || [];
  } catch (err) {
    console.error('[getNews] error:', err);
    return [];
  }
}

/**
 * 获取账户列表
 */
async function getAccounts() {
  try {
    const db = wx.cloud.database();
    const res = await db.collection('accounts').orderBy('sort_order', 'asc').get();
    return res.data || [];
  } catch (err) {
    console.error('[getAccounts] error:', err);
    return [];
  }
}

/**
 * 获取持仓列表（按账户）
 */
async function getHoldings(accountId = null) {
  try {
    const db = wx.cloud.database();
    let baseQuery = db.collection('holdings');
    if (accountId) {
      baseQuery = baseQuery.where({ account_id: accountId });
    }
    // 客户端单次 get 上限 20 条，分页拉取全部持仓
    const PAGE_SIZE = 20;
    let all = [];
    let skip = 0;
    while (true) {
      const res = await baseQuery.skip(skip).limit(PAGE_SIZE).get();
      const batch = res.data || [];
      all = all.concat(batch);
      if (batch.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
      if (skip > 2000) break;
    }
    return all;
  } catch (err) {
    console.error('[getHoldings] error:', err);
    return [];
  }
}

/**
 * 获取总资产汇总
 * 返回字段：totalAssets / totalMarketValue / totalCashBalance / totalCostValue /
 *          totalPnL / totalPnLPercent / todayPnL / holdingCount / accountCount /
 *          accounts(含 holdings/holdingCount/market_value/cost_value/pnl/pnl_percent/total_value/today_pnl) /
 *          holdings
 */
async function getPortfolioSummary() {
  try {
    const [accounts, holdings] = await Promise.all([
      getAccounts(),
      getHoldings(),
    ]);

    const totalMarketValue = holdings.reduce((sum, h) => sum + (h.market_value || 0), 0);
    const totalCostValue = holdings.reduce((sum, h) => sum + (h.cost_value || 0), 0);
    const totalCashBalance = accounts.reduce((sum, a) => sum + (a.cash_balance || 0), 0);
    const totalAssets = totalMarketValue + totalCashBalance;
    const totalPnL = totalMarketValue - totalCostValue;
    const totalPnLPercent = totalCostValue > 0 ? (totalPnL / totalCostValue) * 100 : 0;

    // 累计已实现/分红/手续费，用于计算总收益（同花顺口径）
    // 手续费已计入成本(买入)与已实现盈亏(卖出)，不重复扣减
    const totalRealized = holdings.reduce((s, h) => s + (Number(h.realized_pnl) || 0), 0);
    const totalDividend = holdings.reduce((s, h) => s + (Number(h.total_dividend) || 0), 0);
    const totalFee = holdings.reduce((s, h) => s + (Number(h.total_fee) || 0), 0);
    // 总收益 = 浮动 + 已实现 + 分红
    const totalAllPnL = Number((totalPnL + totalRealized + totalDividend).toFixed(2));
    const totalAllPnLPercent = totalCostValue > 0
      ? Number(((totalAllPnL / totalCostValue) * 100).toFixed(2))
      : 0;

    // 今日收益 = 各持仓当日变动额之和（基于行情接口返回的 change 字段 × 份额）
    // 若未刷新行情，daily_change 字段缺失，今日收益记为 0
    let todayPnL = 0;
    holdings.forEach(h => {
      if (typeof h.daily_change === 'number' && h.shares) {
        todayPnL += h.daily_change * h.shares;
      }
    });

    // 按账户汇总
    const accountSummary = accounts.map(acc => {
      const accHoldings = holdings.filter(h => h.account_id === acc._id);
      const accMarketValue = accHoldings.reduce((s, h) => s + (h.market_value || 0), 0);
      const accCostValue = accHoldings.reduce((s, h) => s + (h.cost_value || 0), 0);
      const accPnL = accMarketValue - accCostValue;
      const accPnLPercent = accCostValue > 0 ? (accPnL / accCostValue) * 100 : 0;
      const accRealized = accHoldings.reduce((s, h) => s + (Number(h.realized_pnl) || 0), 0);
      const accDividend = accHoldings.reduce((s, h) => s + (Number(h.total_dividend) || 0), 0);
      const accTotalPnL = Number((accPnL + accRealized + accDividend).toFixed(2));
      const accTodayPnL = accHoldings.reduce((s, h) =>
        s + (typeof h.daily_change === 'number' && h.shares ? h.daily_change * h.shares : 0), 0);
      return {
        ...acc,
        holdings: accHoldings,
        holdingCount: accHoldings.length,
        market_value: accMarketValue,
        cost_value: accCostValue,
        pnl: accPnL,
        pnl_percent: accPnLPercent,
        total_pnl: accTotalPnL,
        today_pnl: accTodayPnL,
        total_value: accMarketValue + (acc.cash_balance || 0),
      };
    });

    // 按策略/跟投计划汇总
    const strategyMap = {};
    holdings.forEach(h => {
      const s = (h.strategy || '').trim();
      if (!s) return;
      if (!strategyMap[s]) strategyMap[s] = [];
      strategyMap[s].push(h);
    });
    const strategySummaries = Object.entries(strategyMap).map(([name, hList]) => {
      const marketValue = hList.reduce((s, h) => s + (h.market_value || 0), 0);
      const costValue = hList.reduce((s, h) => s + (h.cost_value || 0), 0);
      const pnl = marketValue - costValue;
      const pnlPercent = costValue > 0 ? (pnl / costValue) * 100 : 0;
      // 策略维度的总收益（同花顺口径）
      const sRealized = hList.reduce((s, h) => s + (Number(h.realized_pnl) || 0), 0);
      const sDividend = hList.reduce((s, h) => s + (Number(h.total_dividend) || 0), 0);
      const sTotalPnL = Number((pnl + sRealized + sDividend).toFixed(2));
      return {
        name, holdingCount: hList.length, marketValue, costValue,
        pnl: sTotalPnL,    // 列表展示用总收益
        pnlPercent,
      };
    });

    return {
      totalAssets,
      totalMarketValue,
      totalCashBalance,
      totalCostValue,
      totalPnL,              // 浮动盈亏（保持向后兼容）
      totalPnLPercent,
      totalAllPnL,           // 总收益（同花顺口径）
      totalAllPnLPercent,
      totalRealized,
      totalDividend,
      totalFee,
      todayPnL,
      holdingCount: holdings.length,
      accountCount: accounts.length,
      accounts: accountSummary,
      holdings,
      strategySummaries,
    };
  } catch (err) {
    console.error('[getPortfolioSummary] error:', err);
    throw err;
  }
}

/**
 * 用自然语言/JSON 批量解析交易（语音录入入口）
 * @param {object} params - { mode, text, json, account_id, provider, dry_run }
 *   mode: 'text' | 'json'（默认 text）
 *   text: 自然语言交易描述（mode=text 时必填）
 *   json: 已解析的 ParsedTrade[] 或字符串（mode=json 时必填）
 *   account_id: 目标账户 ID（必填）
 *   provider?: LLM 提供商，默认取用户已配置且启用的第一个
 *   dry_run?: true=仅解析不写入（默认 true）
 * @returns {Promise<{success, trades, warnings, imported, message?}>}
 * 详见 docs/06-大模型语音导入指南.md
 */
async function parseTradesByText(params) {
  // 语音录入涉及 LLM 解析 + 多笔交易写入，需要较长超时
  return callCloudFunction(CLOUD_FUNCTIONS.PARSE_TRADES_BY_TEXT, params, { timeout: 60000 });
}

/**
 * 推断持仓行业分类（LLM 批量推断，写回 holdings.industry）
 * @param {object} params - { holding_ids?, only_missing?, force?, provider? }
 *   holding_ids?: string[]  指定持仓 ID（为空则处理全部）
 *   only_missing?: boolean  仅推断 industry 为空的持仓（默认 true）
 *   force?: boolean         强制重新推断（忽略开关与 only_missing）
 *   provider?: string       指定 LLM 提供商
 * @returns {Promise<{success, processed, updated, skipped, failed, results}>}
 */
async function inferIndustry(params) {
  return callCloudFunction(CLOUD_FUNCTIONS.INFER_INDUSTRY, params);
}

module.exports = {
  callCloudFunction,
  refreshPrices,
  analyzePortfolio,
  analyzePortfolioMulti,
  askAI,
  getHoldingsAnalysis,
  getAnalysisReports,
  saveLLMConfig,
  getLLMConfig,
  getNews,
  getAccounts,
  getHoldings,
  getPortfolioSummary,
  parseTradesByText,
  inferIndustry,
  prepareAnalysis,
  saveAIReport,
};
