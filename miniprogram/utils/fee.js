/**
 * 交易手续费计算器
 * 根据账户费率配置自动计算一笔交易的手续费。
 *
 * 账户费率字段（参见 pages/account/edit.js）：
 *   证券账户：
 *     sh_stock_rate / sh_stock_min  沪市股票佣金率 / 最低佣金
 *     sh_etf_rate  / sh_etf_min     沪市 ETF 佣金率 / 最低佣金
 *     sh_lof_rate  / sh_lof_min     沪市 LOF 佣金率 / 最低佣金
 *     sz_stock_rate / sz_stock_min  深市股票佣金率 / 最低佣金
 *     sz_etf_rate  / sz_etf_min     深市 ETF 佣金率 / 最低佣金
 *     sz_lof_rate  / sz_lof_min     深市 LOF 佣金率 / 最低佣金
 *     transfer_fee_rate             过户费率（仅沪市，双向）
 *     stamp_duty_rate               印花税率（仅卖出）
 *   基金平台：
 *     subscription_fee_rate / subscription_fee_min   申购费率 / 最低
 *     redemption_fee_rate                           赎回费率
 *
 * 计算口径与同花顺一致：
 *   - 佣金 = max(成交金额 × 佣金率, 最低佣金)
 *   - 过户费 = 成交金额 × 过户费率（仅沪市，买卖双向）
 *   - 印花税 = 成交金额 × 印花税率（仅卖出）
 *   - 申购费 = max(成交金额 × 申购费率, 最低申购费)
 *   - 赎回费 = 成交金额 × 赎回费率
 *
 * @param {object} account - 账户对象（含费率字段）
 * @param {object} trade - { type, product_type, exchange, amount, shares, price }
 * @returns {number} 手续费（元），保留 2 位小数
 */
function calcTradeFee(account, trade) {
  if (!account || !trade) return 0;
  const type = trade.type;
  if (type !== 'buy' && type !== 'sell') return 0;

  const productType = trade.product_type || '';
  const exchange = (trade.exchange || 'SH').toUpperCase();
  // 成交金额：优先用 amount，缺失时按 shares × price 兜底
  const amount = Number(trade.amount) > 0
    ? Number(trade.amount)
    : (Number(trade.shares) || 0) * (Number(trade.price) || 0);
  if (amount <= 0) return 0;

  // ========== 证券类 ==========
  const stockTypes = ['stock', 'etf', 'lof', 'reit', 'hk_stock', 'us_stock'];
  if (stockTypes.indexOf(productType) >= 0) {
    const isSh = exchange === 'SH';
    const isSz = exchange === 'SZ';

    // 选佣金率/最低佣金
    let rate = 0;
    let minFee = 0;
    if (productType === 'etf' || productType === 'reit') {
      rate = isSh ? account.sh_etf_rate : (isSz ? account.sz_etf_rate : 0);
      minFee = isSh ? account.sh_etf_min : (isSz ? account.sz_etf_min : 0);
    } else if (productType === 'lof') {
      rate = isSh ? account.sh_lof_rate : (isSz ? account.sz_lof_rate : 0);
      minFee = isSh ? account.sh_lof_min : (isSz ? account.sz_lof_min : 0);
    } else {
      // stock / hk_stock / us_stock
      rate = isSh ? account.sh_stock_rate : (isSz ? account.sz_stock_rate : 0);
      minFee = isSh ? account.sh_stock_min : (isSz ? account.sz_stock_min : 0);
    }

    let fee = Math.max(amount * (Number(rate) || 0), Number(minFee) || 0);

    // 过户费：仅沪市（双向）
    if (isSh) {
      fee += amount * (Number(account.transfer_fee_rate) || 0);
    }

    // 印花税：仅卖出
    if (type === 'sell') {
      fee += amount * (Number(account.stamp_duty_rate) || 0);
    }

    return Number(fee.toFixed(2));
  }

  // ========== 场外基金 ==========
  if (productType.indexOf('fund') === 0) {
    if (type === 'buy') {
      const rate = Number(account.subscription_fee_rate) || 0;
      const minFee = Number(account.subscription_fee_min) || 0;
      return Number(Math.max(amount * rate, minFee).toFixed(2));
    }
    if (type === 'sell') {
      const rate = Number(account.redemption_fee_rate) || 0;
      return Number((amount * rate).toFixed(2));
    }
  }

  return 0;
}

/**
 * 判断账户是否配置了可用于自动计算的手续费率
 * 用于决定是否在用户未输入手续费时自动填充
 */
function hasFeeRates(account) {
  if (!account) return false;
  const productType = account.product_type;
  // 任意一个费率字段非零即视为已配置
  return [
    account.sh_stock_rate, account.sh_etf_rate, account.sh_lof_rate,
    account.sz_stock_rate, account.sz_etf_rate, account.sz_lof_rate,
    account.transfer_fee_rate, account.stamp_duty_rate,
    account.subscription_fee_rate, account.redemption_fee_rate,
  ].some(v => Number(v) > 0);
}

module.exports = { calcTradeFee, hasFeeRates };
