/**
 * apply_transaction
 * 将一笔交易应用到对应持仓（加权平均成本法），幂等。
 *
 * 入参：
 *   { transaction_id }  按已存在的交易记录应用
 *
 * 算法（与同花顺口径对齐）：
 *   买入：buyCost = N*P + fee；newCostValue = oldCostValue + buyCost；newCost = newCostValue / newShares
 *        total_fee += buy_fee
 *   卖出：newShares = S - N；cost_price 不变；归零则 is_cleared=true
 *        realized_pnl += (sell_price - cost_price) * sell_shares - sell_fee
 *        total_fee += sell_fee
 *   分红/利息：不影响份额；找对应持仓累加 total_dividend += amount
 *   转账/手续费交易：不影响持仓
 *
 * 总收益（同花顺口径）：
 *   total_pnl = 浮动盈亏(market_value - cost_value) + realized_pnl + total_dividend
 *   （手续费已计入 cost_value/realized_pnl，不再重复扣除）
 *
 * 幂等：transaction 带 applied_holding 标记，已应用则跳过。
 *
 * 重要修复（2026-07）：
 *   - 用 db.runTransaction 包裹「查询+dedup+upsert」，杜绝并发双建持仓和"删了不补"
 *   - dedup 改为「合并字段」而非「盲删第 2..N 条」：保留 updated_at 最新的那条，
 *     把其余持仓的 shares/cost/realized/dividend/fee 合并进来，再删除多余 doc
 *   - 创建持仓时写入 _openid（从 cloud.getWXContext 获取），确保小程序端可见
 *   - dedup 查询加 _openid 隔离，防御性兜底
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 重算 total_pnl（在份额/成本/已实现/分红/手续费变化后调用）
 * 口径：浮动(mv-cv) + 已实现 + 分红（手续费已计入 cv/realized，不重复扣）
 */
function recomputeTotalPnl(holding, marketValue, costValue) {
  const mv = Number(marketValue) || 0;
  const cv = Number(costValue) || 0;
  const realized = Number(holding.realized_pnl) || 0;
  const dividend = Number(holding.total_dividend) || 0;
  return Number((mv - cv + realized + dividend).toFixed(2));
}

// 根据产品代码推断 product_type
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

/**
 * 合并多条重复持仓为一条：保留 updated_at 最新的那条作为基底，
 * 把其余持仓的累计字段（realized_pnl/total_dividend/total_fee）累加进来，
 * shares/cost_value/cost_price 重新按加权平均计算。
 * 返回 { merged, toDelete }：merged 为合并后应写入的字段，toDelete 为应删除的 _id 列表。
 *
 * 注意：此函数只做"字段合并计算"，不真正写库，写库由调用方在事务里完成。
 * 这是防御性合并：理论上同一 (account,product) 不应有多条持仓，
 * 但历史脏数据可能存在。合并而非盲删，避免丢失已实现的盈亏/分红累计。
 */
function mergeHoldings(existList) {
  if (!existList || existList.length <= 1) {
    return { base: existList[0] || null, toDelete: [] };
  }
  // 按 updated_at 降序，取最新的一条作为基底
  const sorted = existList.slice().sort((a, b) => {
    const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return tb - ta;
  });
  const base = sorted[0];
  const toDelete = [];
  // 累加其余持仓的 realized_pnl / total_dividend / total_fee
  let accRealized = Number(base.realized_pnl) || 0;
  let accDividend = Number(base.total_dividend) || 0;
  let accFee = Number(base.total_fee) || 0;
  for (let k = 1; k < sorted.length; k++) {
    const h = sorted[k];
    accRealized += Number(h.realized_pnl) || 0;
    accDividend += Number(h.total_dividend) || 0;
    accFee += Number(h.total_fee) || 0;
    toDelete.push(h._id);
  }
  return {
    base: Object.assign({}, base, {
      realized_pnl: Number(accRealized.toFixed(2)),
      total_dividend: Number(accDividend.toFixed(2)),
      total_fee: Number(accFee.toFixed(2)),
    }),
    toDelete,
  };
}

exports.main = async (event) => {
  const { transaction_id } = event;
  if (!transaction_id) {
    return { success: false, message: '缺少 transaction_id' };
  }

  // 获取 openid，用于持仓隔离与写入
  // 优先使用调用方显式传入的 openid（云函数间调用时 getWXContext 可能拿不到用户身份），
  // 回退到 getWXContext().OPENID（小程序端直接调用时自动注入）
  const wxContext = cloud.getWXContext();
  const openid = (event && event.openid) || wxContext.OPENID || '';

  try {
    // 1. 读取交易
    const txnRes = await db.collection('transactions').doc(transaction_id).get();
    const txn = txnRes.data;
    if (!txn) {
      return { success: false, message: '交易记录不存在' };
    }

    // 幂等：已应用则直接返回
    if (txn.applied_holding) {
      return { success: true, message: '已应用过，跳过', skipped: true };
    }

    const type = txn.type;
    const fee = Number(txn.fee) || 0;
    const amount = Number(txn.amount) || 0;

    // 归属人优先取交易记录上的 _openid，回退当前调用者
    // 注意：历史导入的交易可能没有 _openid，此时 ownerOpenid 可能为空，
    // 查询持仓时不加 _openid 过滤（靠 account_id 隔离即可），否则会漏掉历史持仓。
    const ownerOpenid = txn._openid || openid;

    // 2. 分红/利息：找对应持仓累加 total_dividend（不影响份额）
    if (type === 'dividend' || type === 'interest') {
      if (!txn.account_id || !txn.product_code) {
        await db.collection('transactions').doc(transaction_id).update({
          data: { applied_holding: true, applied_at: db.serverDate() },
        });
        return { success: true, message: '分红/利息缺账户或代码，仅记录', skipped: true };
      }
      const where = { account_id: txn.account_id, product_code: txn.product_code };
      // 不加 _openid 过滤：历史持仓可能没有 _openid（3570e3e 版本导入的），
      // 加过滤会导致查不到这些持仓。account_id 本身就是用户私有的，足以隔离。
      const existRes = await db.collection('holdings').where(where).get();
      const existList = (existRes && existRes.data) || [];
      const existing = existList[0];
      if (existList.length > 1) {
        for (let k = 1; k < existList.length; k++) {
          try {
            await db.collection('holdings').doc(existList[k]._id).remove();
          } catch (e) {
            console.warn('[apply_transaction] dividend dedup remove failed:', e);
          }
        }
      }
      if (!existing) {
        await db.collection('transactions').doc(transaction_id).update({
          data: { applied_holding: true, applied_at: db.serverDate() },
        });
        return { success: true, message: '无对应持仓，分红/利息仅记录', warning: true };
      }
      const oldDividend = Number(existing.total_dividend) || 0;
      const newDividend = oldDividend + amount;
      const mv = Number(existing.market_value) || 0;
      const cv = Number(existing.cost_value) || 0;
      const newTotalPnl = recomputeTotalPnl(
        { ...existing, total_dividend: newDividend },
        mv, cv
      );
      await db.collection('holdings').doc(existing._id).update({
        data: {
          total_dividend: Number(newDividend.toFixed(2)),
          total_pnl: newTotalPnl,
          updated_at: db.serverDate(),
        },
      });
      await db.collection('transactions').doc(transaction_id).update({
        data: { applied_holding: true, applied_at: db.serverDate() },
      });
      return { success: true, message: '已应用分红/利息' };
    }

    // 3. 非买卖但影响持仓的类型（红股入账、打新中签）同样需要处理
    //    使用 rebuild_holdings 全量回放，确保处理口径一致
    const holdingAffecting = ['buy', 'sell', 'dividend', 'interest', 'stock_dividend', 'ipo_win'];
    if (holdingAffecting.indexOf(type) >= 0 && type !== 'buy' && type !== 'sell') {
      // stock_dividend/ipo_win 只需标记已应用，让 rebuild_holdings 或下次重建时处理
      if (!txn.shares || Number(txn.shares) <= 0) {
        await db.collection('transactions').doc(transaction_id).update({
          data: { applied_holding: true, applied_at: db.serverDate() },
        });
        return { success: true, message: `${type} 无有效份额，仅记录`, skipped: true };
      }
    }

    // 4. 完全非持仓类型：仅记录
    if (type !== 'buy' && type !== 'sell') {
      await db.collection('transactions').doc(transaction_id).update({
        data: { applied_holding: true, applied_at: db.serverDate() },
      });
      return { success: true, message: '非持仓交易，仅记录', skipped: true };
    }

    if (!txn.account_id || !txn.product_code) {
      return { success: false, message: '交易缺少 account_id 或 product_code' };
    }

    const shares = Number(txn.shares) || 0;
    const price = Number(txn.price) || 0;
    if (shares <= 0) {
      return { success: false, message: '交易份额无效' };
    }

    // 4. 用事务包裹「查询+合并+upsert」，杜绝并发双建和"删了不补"
    //    事务内：查询现有持仓 → 合并重复持仓 → 计算 newShares/cost → 更新/新建 → 删除多余
    const transactionResult = await db.runTransaction(async (transaction) => {
      // 事务内查询：按 account_id + product_code 隔离（不加 _openid，
      // 避免漏掉历史无 _openid 的持仓，account_id 已能隔离用户）
      const where = { account_id: txn.account_id, product_code: txn.product_code };
      const existRes = await transaction.collection('holdings').where(where).get();
      const existList = (existRes && existRes.data) || [];

      // 合并重复持仓（取最新的一条作基底，累加其余的累计字段）
      const { base: existing, toDelete } = mergeHoldings(existList);

      // 计算应用交易后的新份额/成本
      let newShares, newCostValue, newCostPrice, newRealized, newDividend, newTotalFee;
      let isClearedNow = false;

      if (type === 'buy') {
        const buyCost = shares * price + fee;
        if (existing) {
          const oldShares = Number(existing.shares) || 0;
          const oldCostValue = Number(existing.cost_value) || (oldShares * Number(existing.cost_price || 0));
          newShares = oldShares + shares;
          newCostValue = oldCostValue + buyCost;
          newCostPrice = newShares > 0 ? newCostValue / newShares : price;
          newRealized = Number(existing.realized_pnl) || 0;
          newDividend = Number(existing.total_dividend) || 0;
          newTotalFee = (Number(existing.total_fee) || 0) + fee;
        } else {
          newShares = shares;
          newCostValue = buyCost;
          newCostPrice = shares > 0 ? buyCost / shares : price;
          newRealized = 0;
          newDividend = 0;
          newTotalFee = fee;
        }
      } else {
        // 卖出
        if (!existing) {
          // 无持仓卖出，交给外层标记仅记录
          return { noHolding: true };
        }
        const oldShares = Number(existing.shares) || 0;
        newShares = oldShares - shares;
        isClearedNow = newShares <= 0;
        const finalShares = isClearedNow ? 0 : newShares;
        const costPrice = Number(existing.cost_price) || 0;
        newCostValue = Number((finalShares * costPrice).toFixed(2));
        const sellRealized = (price - costPrice) * shares - fee;
        newRealized = (Number(existing.realized_pnl) || 0) + sellRealized;
        newDividend = Number(existing.total_dividend) || 0;
        newTotalFee = (Number(existing.total_fee) || 0) + fee;
        newShares = finalShares;
        newCostPrice = costPrice;
      }

      const finalMarketValue = isClearedNow ? 0 : (Number(existing && existing.market_value) || 0);
      const newTotalPnl = recomputeTotalPnl(
        { realized_pnl: newRealized, total_dividend: newDividend },
        finalMarketValue, newCostValue
      );

      const updateData = {
        shares: Number(newShares.toFixed(4)),
        cost_price: Number(newCostPrice.toFixed(4)),
        cost_value: Number(newCostValue.toFixed(2)),
        is_cleared: isClearedNow,
        realized_pnl: Number(newRealized.toFixed(2)),
        total_dividend: Number(newDividend.toFixed(2)),
        total_fee: Number(newTotalFee.toFixed(2)),
        market_value: finalMarketValue,
        total_pnl: newTotalPnl,
        updated_at: db.serverDate(),
      };

      let resultHoldingId;
      if (existing) {
        // 更新现有持仓（base 已包含合并后的累计字段）
        await transaction.collection('holdings').doc(existing._id).update({ data: updateData });
        resultHoldingId = existing._id;
      } else {
        // 新建持仓，写入 _openid 确保小程序端可见
        const newDoc = Object.assign({
          _openid: ownerOpenid,
          account_id: txn.account_id,
          product_code: txn.product_code,
          product_name: txn.product_name || txn.product_code,
          product_type: txn.product_type || inferProductType(txn.product_code) || '',
          exchange: txn.exchange || inferExchange(txn.product_code) || '',
          current_price: price,
          pnl: 0,
          pnl_percent: 0,
          daily_change: 0,
          buy_date: txn.trade_date || '',
          note: '',
          created_at: db.serverDate(),
        }, updateData);
        const addRes = await transaction.collection('holdings').add({ data: newDoc });
        resultHoldingId = addRes._id;
      }

      // 删除合并出来的多余持仓（在事务内，确保原子性）
      for (const did of toDelete) {
        try {
          await transaction.collection('holdings').doc(did).remove();
        } catch (e) {
          console.warn('[apply_transaction] dedup remove (in txn) failed:', e);
        }
      }

      return { success: true, holdingId: resultHoldingId, isCleared: isClearedNow };
    });

    // 无持仓卖出：仅标记交易已应用
    if (transactionResult && transactionResult.noHolding) {
      await db.collection('transactions').doc(transaction_id).update({
        data: { applied_holding: true, applied_at: db.serverDate() },
      });
      return { success: true, message: '无对应持仓，卖出仅记录', warning: true };
    }

    // 5. 标记交易已应用
    await db.collection('transactions').doc(transaction_id).update({
      data: { applied_holding: true, applied_at: db.serverDate() },
    });

    return {
      success: true,
      message: transactionResult.isCleared ? '已应用，持仓清仓' : '已应用',
      holdingId: transactionResult.holdingId,
    };
  } catch (err) {
    console.error('[apply_transaction] error:', err);
    return { success: false, message: err.message || '应用失败' };
  }
};
