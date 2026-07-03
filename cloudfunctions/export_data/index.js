/**
 * 数据导出云函数
 * 导出用户的全量数据（accounts + holdings + transactions）
 *
 * v1.1.0 修复：
 * - 分页拉取（wx-server-sdk 单次 get 上限 100 条，超量会被静默截断）
 * - 纳入 transactions 集合（之前缺失导致导出后无法还原交易流水）
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PAGE_SIZE = 100;

// 分页拉取全部记录，避免单次 get 100 条截断
async function fetchAll(collection, where) {
  let all = [];
  let skip = 0;
  while (true) {
    let q = db.collection(collection);
    if (where) q = q.where(where);
    const res = await q.skip(skip).limit(PAGE_SIZE).get();
    all = all.concat(res.data);
    if (res.data.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    if (skip > 10000) break; // 安全上限
  }
  return all;
}

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID || '';
    // 按 openid 隔离，仅导出当前用户的数据（云函数为 admin 权限，需手动过滤）
    const query = openid ? { _openid: openid } : null;

    const [accounts, holdings, transactions] = await Promise.all([
      fetchAll('accounts', query),
      fetchAll('holdings', query),
      fetchAll('transactions', query),
    ]);

    const exportData = {
      export_time: new Date().toISOString(),
      version: '1.1.0',
      accounts,
      holdings,
      transactions,
      summary: {
        accountCount: accounts.length,
        holdingCount: holdings.length,
        transactionCount: transactions.length,
        totalMarketValue: holdings.reduce((s, h) => s + (h.market_value || 0), 0),
        totalCostValue: holdings.reduce((s, h) => s + (h.cost_value || 0), 0),
      },
    };

    return {
      success: true,
      data: exportData,
    };
  } catch (err) {
    console.error('[export_data] error:', err);
    return { success: false, message: err.message };
  }
};
