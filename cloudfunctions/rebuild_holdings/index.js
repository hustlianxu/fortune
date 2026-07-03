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

// 根据产品代码推断 product_type（用于交易缺类型时兜底，提交 487d457）
function inferProductType(code, accountType) {
  if (!code) return '';
  const c = String(code).trim().toUpperCase();
  if (/^\d{5}$/.test(c)) return 'hk_stock';
  if (/^[A-Z]/.test(c)) return 'us_stock';
  if (/^\d{6}$/.test(c)) {
    if (/^5[012]/.test(c)) return 'etf';
    if (/^56/.test(c)) return 'etf';
    if (/^58/.test(c)) return 'reit';
    if (/^15/.test(c)) return 'etf';
    if (/^16/.test(c)) return 'lof';
    if (/^18/.test(c)) return 'reit';
    if (/^6[08]/.test(c)) return 'stock';
    if (/^0[03]/.test(c)) return 'stock';
    if (accountType === 'fund_platform' || accountType === 'fund') return 'fund_mix';
    return 'stock';
  }
  return '';
}

function inferExchange(code) {
  if (!code) return '';
  const c = String(code).trim().toUpperCase();
  if (/^\d{5}$/.test(c)) return 'HK';
  if (/^[A-Z]/.test(c)) return 'US';
  if (/^\d{6}$/.test(c)) {
    if (/^6[08]/.test(c)) return 'SH';
    if (/^5[0128]/.test(c)) return 'SH';
    if (/^0[03]/.test(c)) return 'SZ';
    if (/^1[568]/.test(c)) return 'SZ';
  }
  return '';
}

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

  // 获取 openid，用于持仓隔离与创建
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';

  try {
    // 1. 构建查询条件
    const where = {};
    if (account_id) where.account_id = account_id;
    if (product_code) where.product_code = product_code;
    // 按用户隔离查询交易记录，避免跨用户回放
    if (openid) where._openid = openid;

    // 2. 拉取全部交易（按日期升序回放）
    let txns = await fetchAll('transactions', Object.keys(where).length ? where : null);

    // 过滤掉「持仓已删除」标记的交易（用户在持仓详情页删除持仓时，
    // 对应交易会被标记 holding_deleted:true 作为软删除；这些交易不应参与回放，
    // 否则用户删除持仓后再导入同一股票，旧交易会污染新持仓。
    // 这些交易仍保留在 DB 中，可通过「已清理数据」入口恢复）
    txns = txns.filter(t => !t.holding_deleted);

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
          product_type: t.product_type || inferProductType(t.product_code) || '',
          exchange: t.exchange || inferExchange(t.product_code) || '',
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
    let deduped = 0;
    const keys = Object.keys(holdingsMap);
    const survivors = [];  // [{ account_id, product_code, _id }] 重建后存活持仓的 _id，供客户端跳转

    for (let i = 0; i < keys.length; i++) {
      const h = holdingsMap[keys[i]];
      // 查询现有持仓（拉取全部，处理重复持仓），按 _openid 隔离
      const existWhere = { account_id: h.account_id, product_code: h.product_code };
      if (openid) existWhere._openid = openid;
      const existRes = await db.collection('holdings').where(existWhere).get();
      const existList = (existRes && existRes.data) || [];

      // 用现有持仓的 current_price 重算 market_value / pnl / total_pnl，避免重建后还要刷行情才同步
      // 优先取 updated_at 最新的那条（避免取到脏数据）
      const sortedExisting = existList.slice().sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return tb - ta;
      });
      const curPrice = sortedExisting.length > 0 ? (Number(sortedExisting[0].current_price) || 0) : h.cost_price;
      const marketValue = Number((h.shares * curPrice).toFixed(2));
      const pnl = Number((marketValue - h.cost_value).toFixed(2));
      const pnlPercent = h.cost_value > 0 ? Number(((pnl / h.cost_value) * 100).toFixed(2)) : 0;
      // 总收益 = 浮动 + 已实现 + 分红（同花顺口径，手续费已计入 cost_value/realized）
      const totalPnl = Number((pnl + h.realized_pnl + h.total_dividend).toFixed(2));

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
        market_value: marketValue,
        pnl: pnl,
        pnl_percent: pnlPercent,
        total_pnl: totalPnl,
        updated_at: db.serverDate(),
      };

      let survivingId = '';
      if (sortedExisting.length > 0) {
        // 保留最新的一条更新，合并其余持仓的累计字段（防御性，避免丢已实现/分红）
        const base = sortedExisting[0];
        let accRealized = Number(updateData.realized_pnl) || 0;
        let accDividend = Number(updateData.total_dividend) || 0;
        let accFee = Number(updateData.total_fee) || 0;
        for (let k = 1; k < sortedExisting.length; k++) {
          accRealized += Number(sortedExisting[k].realized_pnl) || 0;
          accDividend += Number(sortedExisting[k].total_dividend) || 0;
          accFee += Number(sortedExisting[k].total_fee) || 0;
        }
        updateData.realized_pnl = Number(accRealized.toFixed(2));
        updateData.total_dividend = Number(accDividend.toFixed(2));
        updateData.total_fee = Number(accFee.toFixed(2));
        // 重算 total_pnl（合并后累计字段变化）
        updateData.total_pnl = Number((pnl + updateData.realized_pnl + updateData.total_dividend).toFixed(2));

        survivingId = base._id;
        await db.collection('holdings').doc(base._id).update({ data: updateData });
        // 删除多余的重复持仓（合并后已安全删除）
        for (let k = 1; k < sortedExisting.length; k++) {
          try {
            await db.collection('holdings').doc(sortedExisting[k]._id).remove();
            deduped++;
          } catch (e) {
            console.warn('[rebuild_holdings] dedup remove failed:', e);
          }
        }
      } else {
        // 新建（product_type/exchange 在交易缺类型时按代码推断兜底）
        const newHolding = Object.assign({}, updateData, {
          _openid: openid,
          account_id: h.account_id,
          product_code: h.product_code,
          product_type: h.product_type || inferProductType(h.product_code) || '',
          exchange: h.exchange || inferExchange(h.product_code) || '',
          current_price: curPrice,
          daily_change: 0,
          note: '',
          created_at: db.serverDate(),
        });
        const addRes = await db.collection('holdings').add({ data: newHolding });
        survivingId = addRes._id;
      }
      survivors.push({ account_id: h.account_id, product_code: h.product_code, _id: survivingId });
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
      message: `重建完成：${rebuilt} 个持仓，${cleared} 个已清仓，清理重复持仓 ${deduped} 个，标记 ${marked} 笔交易`,
      rebuilt,
      cleared,
      deduped,
      marked,
      totalTxns: txns.length,
      // 重建后存活的持仓列表（含 _id），客户端据此跳转，避免把已被去重删除的记录重新加载到详情页
      survivors,
    };
  } catch (err) {
    console.error('[rebuild_holdings] error:', err);
    return { success: false, message: err.message || '重建失败' };
  }
};
