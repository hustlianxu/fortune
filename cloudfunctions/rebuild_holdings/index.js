/**
 * rebuild_holdings
 * 从交易流水全量重建持仓（幂等）。
 *
 * 入参：
 *   { account_id?, product_code? }  可选过滤范围；不传则全量
 *
 * 流程：
 *   1. 拉取范围内全部 transactions，按 trade_date asc, created_at asc 排序
 *   2. 内存回放：每个 (account_id, product_code) 维护一个 holding
 *      - buy：累加份额 + 加权成本（含手续费，同花顺口径）；total_fee += fee
 *      - sell：扣减份额；realized_pnl += (sell_price - cost_price) * sell_shares - fee；total_fee += fee
 *      - dividend/interest：total_dividend += amount
 *      - 其他：跳过
 *   3. upsert 到 holdings 集合（按 account_id+product_code 定位）
 *   4. 标记所有已回放的 transactions.applied_holding = true
 *   5. 返回统计 { rebuilt, cleared, skipped }
 *
 * 幂等：每次都从空状态回放，重建结果一致。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 云数据库单次 get 上限 100 条，需分页拉取
const PAGE_SIZE = 100;

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
    if (skip > 10000) break;
  }
  return all;
}

exports.main = async (event) => {
  const { account_id, product_code } = event || {};

  try {
    // 当前调用者 openid（用于数据隔离 + 新建持仓归属）
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID || '';

    // 1. 构建查询条件（按 openid 隔离，仅回放当前用户的交易）
    const where = {};
    if (openid) where._openid = openid;
    if (account_id) where.account_id = account_id;
    if (product_code) where.product_code = product_code;

    // 2. 拉取全部交易（按日期升序回放）
    let txns = await fetchAll('transactions', Object.keys(where).length ? where : null);

    // 排序：trade_date asc, created_at asc
    txns.sort((a, b) => {
      const da = a.trade_date || '';
      const dbDate = b.trade_date || '';
      if (da !== dbDate) return da < dbDate ? -1 : 1;
      const ca = a.created_at || '';
      const cb = b.created_at || '';
      return ca < cb ? -1 : (ca > cb ? 1 : 0);
    });

    // 3. 内存回放
    // key = account_id + '|' + product_code
    const holdingsMap = {};
    for (let i = 0; i < txns.length; i++) {
      const t = txns[i];
      if (!t.account_id || !t.product_code) continue;
      const type = t.type;

      const key = t.account_id + '|' + t.product_code;
      if (!holdingsMap[key]) {
        holdingsMap[key] = {
          account_id: t.account_id,
          product_code: t.product_code,
          product_name: t.product_name || t.product_code,
          product_type: t.product_type || '',
          exchange: t.exchange || '',
          shares: 0,
          cost_price: 0,
          cost_value: 0,
          buy_date: t.trade_date || '',
          is_cleared: false,
          realized_pnl: 0,
          total_dividend: 0,
          total_fee: 0,
        };
      }
      const h = holdingsMap[key];

      if (type === 'buy' || type === 'sell') {
        const shares = Number(t.shares) || 0;
        const price = Number(t.price) || 0;
        const fee = Number(t.fee) || 0;
        if (shares <= 0) continue;

        if (type === 'buy') {
          // 买入成本 = 份额 × 单价 + 手续费（同花顺口径）
          const buyCost = shares * price + fee;
          const oldShares = h.shares;
          const oldCostValue = h.cost_value;
          const newShares = oldShares + shares;
          const newCostValue = oldCostValue + buyCost;
          const newCost = newShares > 0 ? newCostValue / newShares : price;
          h.shares = newShares;
          h.cost_price = Number(newCost.toFixed(4));
          h.cost_value = Number(newCostValue.toFixed(2));
          h.total_fee = Number((h.total_fee + fee).toFixed(2));
          h.is_cleared = false;
          if (!h.buy_date) h.buy_date = t.trade_date || '';
          if (!h.product_name && t.product_name) h.product_name = t.product_name;
        } else {
          // 卖出
          const newShares = h.shares - shares;
          const isCleared = newShares <= 0;
          const finalShares = isCleared ? 0 : newShares;
          // 已实现盈亏 = (卖出价 - 持仓成本价) × 卖出份额 - 卖出手续费
          const sellRealized = (price - h.cost_price) * shares - fee;
          h.realized_pnl = Number((h.realized_pnl + sellRealized).toFixed(2));
          h.total_fee = Number((h.total_fee + fee).toFixed(2));
          if (isCleared) {
            h.shares = 0;
            h.is_cleared = true;
            h.cost_value = 0;
          } else {
            h.shares = finalShares;
            h.cost_value = Number((finalShares * h.cost_price).toFixed(2));
          }
        }
      } else if (type === 'dividend' || type === 'interest') {
        // 分红/利息：累加 total_dividend
        const amount = Number(t.amount) || 0;
        h.total_dividend = Number((h.total_dividend + amount).toFixed(2));
      }
      // 其他类型（转账/手续费交易）跳过
    }

    // 4. upsert 到 holdings
    let rebuilt = 0;
    let cleared = 0;
    const keys = Object.keys(holdingsMap);

    for (let i = 0; i < keys.length; i++) {
      const h = holdingsMap[keys[i]];
      // 查询现有持仓（按 openid 隔离）
      const existWhere = {
        account_id: h.account_id,
        product_code: h.product_code,
      };
      if (openid) existWhere._openid = openid;
      const existRes = await db.collection('holdings').where(existWhere).limit(1).get();

      const updateData = {
        shares: h.shares,
        cost_price: h.cost_price,
        cost_value: h.cost_value,
        is_cleared: h.is_cleared,
        buy_date: h.buy_date,
        product_name: h.product_name,
        realized_pnl: h.realized_pnl,
        total_dividend: h.total_dividend,
        total_fee: h.total_fee,
        updated_at: db.serverDate(),
      };

      if (existRes.data.length > 0) {
        // 保留现有的 current_price/market_value 等行情字段，仅更新份额/成本/累计字段
        // total_pnl 等行情刷新时由 sync_prices 重算
        await db.collection('holdings').doc(existRes.data[0]._id).update({ data: updateData });
      } else {
        // 新建
        const newHolding = Object.assign({}, updateData, {
          _openid: openid,
          account_id: h.account_id,
          product_code: h.product_code,
          product_type: h.product_type,
          exchange: h.exchange,
          current_price: h.cost_price,
          market_value: Number((h.shares * h.cost_price).toFixed(2)),
          pnl: 0,
          pnl_percent: 0,
          total_pnl: 0,
          daily_change: 0,
          note: '',
          created_at: db.serverDate(),
        });
        await db.collection('holdings').add({ data: newHolding });
      }
      rebuilt++;
      if (h.is_cleared) cleared++;
    }

    // 5. 标记交易已应用（批量）
    let marked = 0;
    for (let i = 0; i < txns.length; i++) {
      const t = txns[i];
      if (t.applied_holding) continue;
      try {
        await db.collection('transactions').doc(t._id).update({
          data: { applied_holding: true, applied_at: db.serverDate() },
        });
        marked++;
      } catch (e) {
        // 单条失败不中断
      }
    }

    return {
      success: true,
      message: `重建完成：${rebuilt} 个持仓，${cleared} 个已清仓，标记 ${marked} 笔交易`,
      rebuilt,
      cleared,
      marked,
      totalTxns: txns.length,
    };
  } catch (err) {
    console.error('[rebuild_holdings] error:', err);
    return { success: false, message: err.message || '重建失败' };
  }
};
