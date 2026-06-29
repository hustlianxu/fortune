/**
 * apply_transaction
 * 将一笔交易应用到对应持仓（加权平均成本法），幂等。
 *
 * 入参：
 *   { transaction_id }  按已存在的交易记录应用
 *
 * 算法（与同花顺口径对齐：买入手续费计入持仓成本）：
 *   买入：buyCost = N*P + fee；newCostValue = oldCostValue + buyCost；newCost = newCostValue / newShares
 *   卖出：newShares = S - N；cost_price 不变；归零则 is_cleared=true
 *   分红/利息/转账/手续费：不影响份额，仅记录（持仓不更新）
 *
 * 幂等：transaction 带 applied_holding 标记，已应用则跳过。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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

    // 2. 非买卖类交易不影响持仓份额，直接标记完成
    const type = txn.type;
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
    const fee = Number(txn.fee) || 0;   // 买入手续费（与同花顺口径一致，计入持仓成本）
    if (shares <= 0) {
      return { success: false, message: '交易份额无效' };
    }

    // 3. 查询对应持仓（account_id + product_code）
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
        // 累加份额 + 加权平均成本（以 cost_value 为权威值，避免 cost_price 与 cost_value 不一致漂移）
        const oldShares = Number(existing.shares) || 0;
        const oldCostValue = Number(existing.cost_value) || (oldShares * Number(existing.cost_price || 0));
        const newShares = oldShares + shares;
        const newCostValue = oldCostValue + buyCost;
        const newCost = newShares > 0 ? newCostValue / newShares : price;

        const updateData = {
          shares: newShares,
          cost_price: Number(newCost.toFixed(4)),
          cost_value: Number(newCostValue.toFixed(2)),
          is_cleared: false,
          updated_at: db.serverDate(),
        };

        await db.collection('holdings').doc(existing._id).update({ data: updateData });
        resultHolding = { ...existing, ...updateData };
      } else {
        // 新建持仓
        const newCostPrice = shares > 0 ? buyCost / shares : price;
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
          market_value: Number((shares * price).toFixed(2)),
          pnl: 0,
          pnl_percent: 0,
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
        // 无持仓却卖出，标记应用但提示
        await db.collection('transactions').doc(transaction_id).update({
          data: { applied_holding: true, applied_at: db.serverDate() },
        });
        return { success: true, message: '无对应持仓，卖出仅记录', warning: true };
      }

      const oldShares = Number(existing.shares) || 0;
      const newShares = oldShares - shares;
      const isCleared = newShares <= 0;
      const finalShares = isCleared ? 0 : newShares;

      const updateData = {
        shares: finalShares,
        is_cleared: isCleared,
        updated_at: db.serverDate(),
      };
      // cost_price 不变；重算成本金额
      const costPrice = Number(existing.cost_price) || 0;
      updateData.cost_value = Number((finalShares * costPrice).toFixed(2));
      if (isCleared) {
        updateData.market_value = 0;
        updateData.pnl = Number(existing.cost_value || 0);  // 清仓时盈亏=已实现
      }

      await db.collection('holdings').doc(existing._id).update({ data: updateData });
      resultHolding = { ...existing, ...updateData };
    }

    // 4. 标记交易已应用
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
