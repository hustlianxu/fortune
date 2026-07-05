/**
 * recalc_cash_balance
 * 重新计算账户现金余额：cash_balance = cash_balance_base + 交易净现金流
 *
 * 交易对余额的影响规则：
 *   money_in  : transfer_in, sell, dividend, interest
 *   money_out : transfer_out, buy, ipo_win, fee, tax, stock_dividend
 *
 * 入参：{ account_id }
 * 返回：{ success, account_id, cash_balance, cash_balance_base, net_cash_flow }
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PAGE_SIZE = 100;

/**
 * 计算交易对账户余额的影响（按"发生金额"，含手续费）
 *
 * 核心概念：
 *   成交金额（amount）= price × shares           —— 纯股票/基金交易价值
 *   发生金额（settlement）= 成交金额 + 税费         —— 实际从账户扣/到账的钱
 *   税费（fee）= 佣金 + 过户费 + 印花税等
 *
 *   买入：发生金额 = -(成交金额 + 税费)  ← 实际扣款
 *   卖出：发生金额 =  成交金额 - 税费    ← 实际到账
 */
function cashFlow(type, amount, fee) {
  const amt = Number(amount) || 0;
  const f = Number(fee) || 0;
  if (type === 'sell') return amt - f;                     // 收入 = 成交金额 - 税费
  if (type === 'buy' || type === 'ipo_win') return -(amt + f);  // 支出 = -(成交金额 + 税费)
  if (['transfer_in', 'dividend', 'interest'].indexOf(type) >= 0) return amt;
  if (['transfer_out', 'fee', 'tax'].indexOf(type) >= 0) return -amt;
  return 0; // stock_dividend, split 等不影响余额
}

exports.main = async (event) => {
  const { account_id } = event || {};
  if (!account_id) return { success: false, message: '缺少 account_id' };

  try {
    // 1. 获取账户
    const accountRes = await db.collection('accounts').doc(account_id).get();
    const account = accountRes.data;
    if (!account) return { success: false, message: '账户不存在' };

    // 2. 获取该账户下全部交易记录（分页）
    let allTxns = [];
    let skip = 0;
    while (true) {
      const res = await db.collection('transactions')
        .where({ account_id })
        .skip(skip).limit(PAGE_SIZE)
        .get();
      const batch = res.data || [];
      allTxns = allTxns.concat(batch);
      if (batch.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
      if (skip > 10000) break;
    }

    // 3. 计算净现金流（使用"发生金额"，buy/sell 含手续费）
    let netCashFlow = 0;
    for (const t of allTxns) {
      netCashFlow += cashFlow(t.type, t.amount, t.fee);
    }

    // 4. 取 cash_balance_base + cash_balance_adjustment（用户校正）
    const base = typeof account.cash_balance_base === 'number' ? account.cash_balance_base : (Number(account.cash_balance) || 0);
    const adjustment = typeof account.cash_balance_adjustment === 'number' ? account.cash_balance_adjustment : 0;
    const newBalance = base + netCashFlow + adjustment;

    // 5. 更新账户
    await db.collection('accounts').doc(account_id).update({
      data: {
        cash_balance_base: base,
        cash_balance: Number(newBalance.toFixed(2)),
        cash_flow: Number(netCashFlow.toFixed(2)),
        updated_at: db.serverDate(),
      },
    });

    console.log('[recalc_cash_balance]', account_id,
      'base=' + base, 'flow=' + netCashFlow.toFixed(2), 'balance=' + newBalance.toFixed(2));

    return {
      success: true,
      account_id,
      cash_balance: Number(newBalance.toFixed(2)),
      cash_balance_base: base,
      net_cash_flow: Number(netCashFlow.toFixed(2)),
    };
  } catch (err) {
    console.error('[recalc_cash_balance] error:', err);
    return { success: false, message: err.message || '计算失败' };
  }
};
