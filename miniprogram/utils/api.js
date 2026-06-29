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
 * AI 持仓分析
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
    let query = db.collection('holdings');
    if (accountId) {
      query = query.where({ account_id: accountId });
    }
    const res = await query.get();
    return res.data || [];
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
        today_pnl: accTodayPnL,
        total_value: accMarketValue + (acc.cash_balance || 0),
      };
    });

    return {
      totalAssets,
      totalMarketValue,
      totalCashBalance,
      totalCostValue,
      totalPnL,
      totalPnLPercent,
      todayPnL,
      holdingCount: holdings.length,
      accountCount: accounts.length,
      accounts: accountSummary,
      holdings,
    };
  } catch (err) {
    console.error('[getPortfolioSummary] error:', err);
    throw err;
  }
}

module.exports = {
  callCloudFunction,
  refreshPrices,
  analyzePortfolio,
  askAI,
  getHoldingsAnalysis,
  getAnalysisReports,
  saveLLMConfig,
  getLLMConfig,
  getNews,
  getAccounts,
  getHoldings,
  getPortfolioSummary,
};
