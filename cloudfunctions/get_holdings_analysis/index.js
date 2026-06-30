/**
 * 持仓分析汇总云函数
 * 返回按账户分组的持仓数据、行业分布、盈亏统计
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID || '';
    // 按 openid 隔离（云函数为 admin 权限，需手动过滤）
    const query = openid ? { _openid: openid } : {};

    // 获取账户
    const { data: accounts } = await db.collection('accounts').where(query).get();
    // 获取持仓
    const { data: holdings } = await db.collection('holdings').where(query).get();

    // 构建账户维度汇总
    const accountSummary = accounts.map(acc => {
      const accHoldings = holdings.filter(h => h.account_id === acc._id);
      return {
        _id: acc._id,
        name: acc.name,
        type: acc.type,
        platform: acc.platform,
        cash_balance: acc.cash_balance || 0,
        holdings: accHoldings.map(h => ({
          _id: h._id,
          product_code: h.product_code,
          product_name: h.product_name,
          product_type: h.product_type,
          shares: h.shares,
          cost_price: h.cost_price,
          current_price: h.current_price || 0,
          cost_value: h.cost_value || h.shares * h.cost_price,
          market_value: h.market_value || 0,
          pnl: h.pnl || 0,
          pnl_percent: h.pnl_percent || 0,
          buy_date: h.buy_date,
        })),
        holdingCount: accHoldings.length,
        totalMarketValue: accHoldings.reduce((s, h) => s + (h.market_value || 0), 0),
        totalCostValue: accHoldings.reduce((s, h) => s + (h.cost_value || h.shares * h.cost_price), 0),
        totalPnL: accHoldings.reduce((s, h) => s + (h.pnl || (h.market_value - h.cost_value)), 0),
      };
    });

    // 行业分布
    const sectorMap = {};
    holdings.forEach(h => {
      const sector = h.sector || '其他';
      sectorMap[sector] = (sectorMap[sector] || 0) + (h.market_value || 0);
    });
    const totalMarketValue = holdings.reduce((s, h) => s + (h.market_value || 0), 0);

    const sectorDistribution = Object.entries(sectorMap)
      .sort((a, b) => b[1] - a[1])
      .map(([sector, value]) => ({
        sector,
        value,
        percent: totalMarketValue > 0 ? (value / totalMarketValue * 100) : 0,
      }));

    // 产品类型分布
    const typeMap = {};
    holdings.forEach(h => {
      const type = h.product_type || 'other';
      typeMap[type] = (typeMap[type] || 0) + (h.market_value || 0);
    });
    const typeDistribution = Object.entries(typeMap)
      .sort((a, b) => b[1] - a[1])
      .map(([type, value]) => ({ type, value, percent: totalMarketValue > 0 ? (value / totalMarketValue * 100) : 0 }));

    return {
      success: true,
      data: {
        accounts: accountSummary,
        holdings: holdings.map(h => ({
          ...h,
          pnl: h.pnl || (h.market_value - h.cost_value),
        })),
        sectorDistribution,
        typeDistribution,
        totalAssets: totalMarketValue + accounts.reduce((s, a) => s + (a.cash_balance || 0), 0),
        totalMarketValue,
        totalCostValue: holdings.reduce((s, h) => s + (h.cost_value || h.shares * h.cost_price), 0),
      },
    };
  } catch (err) {
    console.error('[get_holdings_analysis] error:', err);
    return { success: false, message: err.message };
  }
};
