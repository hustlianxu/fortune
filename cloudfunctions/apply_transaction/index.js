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
 *   total_pnl = 浮动盈亏(market_value - cost_value) + realized_pnl + total_dividend - total_fee
 *
 * 幂等：transaction 带 applied_holding 标记，已应用则跳过。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 重算 total_pnl（在份额/成本/已实现/分红/手续费变化后调用）
 */
function recomputeTotalPnl(holding, marketValue, costValue) {
  const mv = Number(marketValue) || 0;
  const cv = Number(costValue) || 0;
  const realized = Number(holding.realized_pnl) || 0;
  const dividend = Number(holding.total_dividend) || 0;
  const fee = Number(holding.total_fee) || 0;
  return Number((mv - cv + realized + dividend - fee).toFixed(2));
}

exports.main = async (event) => {
  const { transaction_id } = event;
  if (!transaction_id) {
    return { success: false, message: '缺少 transaction_id' };
  }

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

    // 2. 分红/利息：找对应持仓累加 total_dividend（不影响份额）
    if (type === 'dividend' || type === 'interest') {
      if (!txn.account_id || !txn.product_code) {
        await db.collection('transactions').doc(transaction_id).update({
          data: { applied_holding: true, applied_at: db.serverDate() },
        });
        return { success: true, message: '分红/利息缺账户或代码，仅记录', skipped: true };
      }
      const existRes = await db.collection('holdings').where({
        account_id: txn.account_id,
        product_code: txn.product_code,
      }).limit(1).get();
      const existing = existRes.data[0];
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

    // 3. 非买卖且非分红利息：仅记录
    if (type !== 'buy' && type !== 'sell') {
      await db.collection('transactions').doc(transaction_id).update({
        data: { applied_holding: true, applied_at: db.serverDate() },
      });
      return { success: true, message: '非买卖交易，仅记录', skipped: true };
    }

    if (!txn.account_id || !txn.product_code) {
      return { success: false, message: '交易缺少 account_id 或 product_code' };
    }

    const shares = Number(txn.shares) || 0;
    const price = Number(txn.price) || 0;
    if (shares <= 0) {
      return { success: false, message: '交易份额无效' };
    }

    // 4. 查询对应持仓（account_id + product_code）
    const existRes = await db.collection('holdings').where({
      account_id: txn.account_id,
      product_code: txn.product_code,
    }).limit(1).get();

    const existing = existRes.data[0];
    let resultHolding;

    if (type === 'buy') {
      // 买入成本 = 份额 × 单价 + 手续费（同花顺口径）
      const buyCost = shares * price + fee;
      if (existing) {
        const oldShares = Number(existing.shares) || 0;
        const oldCostValue = Number(existing.cost_value) || (oldShares * Number(existing.cost_price || 0));
        const newShares = oldShares + shares;
        const newCostValue = oldCostValue + buyCost;
        const newCost = newShares > 0 ? newCostValue / newShares : price;

        // 累计手续费
        const oldFee = Number(existing.total_fee) || 0;
        const newTotalFee = oldFee + fee;
        // 重算浮动盈亏 & 总收益
        const mv = Number(existing.market_value) || 0;
        const newTotalPnl = recomputeTotalPnl(
          { ...existing, total_fee: newTotalFee },
          mv, newCostValue
        );

        const updateData = {
          shares: newShares,
          cost_price: Number(newCost.toFixed(4)),
          cost_value: Number(newCostValue.toFixed(2)),
          total_fee: Number(newTotalFee.toFixed(2)),
          total_pnl: newTotalPnl,
          is_cleared: false,
          updated_at: db.serverDate(),
        };

        await db.collection('holdings').doc(existing._id).update({ data: updateData });
        resultHolding = { ...existing, ...updateData };
      } else {
        // 新建持仓
        const newCostPrice = shares > 0 ? buyCost / shares : price;
        const marketValue = Number((shares * price).toFixed(2));
        const newHolding = {
          account_id: txn.account_id,
          product_code: txn.product_code,
          product_name: txn.product_name || txn.product_code,
          product_type: txn.product_type || '',
          exchange: txn.exchange || '',
          shares: shares,
          cost_price: Number(newCostPrice.toFixed(4)),
          cost_value: Number(buyCost.toFixed(2)),
          current_price: price,
          market_value: marketValue,
          pnl: 0,
          pnl_percent: 0,
          realized_pnl: 0,
          total_dividend: 0,
          total_fee: Number(fee.toFixed(2)),
          total_pnl: 0,
          daily_change: 0,
          is_cleared: false,
          buy_date: txn.trade_date || '',
          note: '',
          created_at: db.serverDate(),
          updated_at: db.serverDate(),
        };
        const addRes = await db.collection('holdings').add({ data: newHolding });
        resultHolding = { ...newHolding, _id: addRes._id };
      }
    } else {
      // 卖出
      if (!existing) {
        await db.collection('transactions').doc(transaction_id).update({
          data: { applied_holding: true, applied_at: db.serverDate() },
        });
        return { success: true, message: '无对应持仓，卖出仅记录', warning: true };
      }

      const oldShares = Number(existing.shares) || 0;
      const newShares = oldShares - shares;
      const isCleared = newShares <= 0;
      const finalShares = isCleared ? 0 : newShares;

      const costPrice = Number(existing.cost_price) || 0;
      const newCostValue = Number((finalShares * costPrice).toFixed(2));
      // 已实现盈亏 = (卖出价 - 持仓成本价) × 卖出份额 - 卖出手续费
      // 同花顺口径：卖出手续费从已实现盈亏中扣除
      const sellRealized = (price - costPrice) * shares - fee;
      const oldRealized = Number(existing.realized_pnl) || 0;
      const newRealized = oldRealized + sellRealized;
      // 累计手续费
      const oldFee = Number(existing.total_fee) || 0;
      const newTotalFee = oldFee + fee;

      const updateData = {
        shares: finalShares,
        is_cleared: isCleared,
        cost_value: newCostValue,
        realized_pnl: Number(newRealized.toFixed(2)),
        total_fee: Number(newTotalFee.toFixed(2)),
        updated_at: db.serverDate(),
      };

      const mv = isCleared ? 0 : (Number(existing.market_value) || 0);
      const newTotalPnl = recomputeTotalPnl(
        { ...existing, realized_pnl: newRealized, total_fee: newTotalFee },
        mv, newCostValue
      );
      updateData.total_pnl = newTotalPnl;
      if (isCleared) {
        updateData.market_value = 0;
      }

      await db.collection('holdings').doc(existing._id).update({ data: updateData });
      resultHolding = { ...existing, ...updateData };
    }

    // 5. 标记交易已应用
    await db.collection('transactions').doc(transaction_id).update({
      data: { applied_holding: true, applied_at: db.serverDate() },
    });

    return {
      success: true,
      message: isCleared(resultHolding) ? '已应用，持仓清仓' : '已应用',
      holding: resultHolding,
    };
  } catch (err) {
    console.error('[apply_transaction] error:', err);
    return { success: false, message: err.message || '应用失败' };
  }
};

function isCleared(h) {
  return h && h.is_cleared === true;
}
