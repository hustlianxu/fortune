/**
 * 云函数调用封装
 */
const { CLOUD_FUNCTIONS } = require('./constants');

/**
 * 通用云函数调用
 * @param {string} name - 云函数名
 * @param {object} data - 请求参数
 * @returns {Promise<object>}
 */
async function callCloudFunction(name, data = {}) {
  try {
    const res = await wx.cloud.callFunction({
      name,
      data,
    });
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
  return callCloudFunction(CLOUD_FUNCTIONS.LLM_GATEWAY, {
    type,
    provider,
  });
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
  });
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
  });
}

/**
 * 获取持仓分析数据
 */
async function getHoldingsAnalysis() {
  return callCloudFunction(CLOUD_FUNCTIONS.GET_HOLDINGS_ANALYSIS);
}

/**
 * 获取历史分析报告列表
 */
async function getAnalysisReports() {
  try {
    const db = wx.cloud.database();
    const res = await db.collection('analysis_reports')
      .orderBy('created_at', 'desc')
      .limit(20)
      .get();
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

    // 累计已实现/分红，用于计算总收益（同花顺口径）
    // 手续费已计入成本(买入)与已实现盈亏(卖出)，不重复扣减
    const totalRealized = holdings.reduce((s, h) => s + (Number(h.realized_pnl) || 0), 0);
    const totalDividend = holdings.reduce((s, h) => s + (Number(h.total_dividend) || 0), 0);
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
      const accFee = accHoldings.reduce((s, h) => s + (Number(h.total_fee) || 0), 0);
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
      const sFee = hList.reduce((s, h) => s + (Number(h.total_fee) || 0), 0);
      const sTotalPnL = Number((pnl + sRealized + sDividend - sFee).toFixed(2));
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
  return callCloudFunction(CLOUD_FUNCTIONS.PARSE_TRADES_BY_TEXT, params);
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
};
