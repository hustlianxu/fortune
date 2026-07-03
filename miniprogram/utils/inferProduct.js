/**
 * 根据产品代码智能推断产品类型
 * 用于持仓/交易记录缺 product_type 时的兜底补全
 *
 * A股代码规则：
 *   60xxxx  沪市主板股票     → stock
 *   68xxxx  科创板股票       → stock
 *   00xxxx  深市主板股票     → stock
 *   30xxxx  创业板股票       → stock
 *   50xxxx  沪市 ETF/封闭式  → etf
 *   51xxxx  沪市 ETF/跨境ETF → etf
 *   52xxxx  沪市 ETF         → etf
 *   56xxxx  沪市跨境ETF      → etf
 *   58xxxx  沪市 REITs       → reit
 *   15xxxx  深市 ETF         → etf
 *   16xxxx  深市 LOF/分级    → lof
 *   18xxxx  深市 REITs       → reit
 *   11/12开头(6位) 国债逆回购 → fund_bond（次要场景）
 *
 * 港股：5位纯数字 → hk_stock
 * 美股：字母开头 → us_stock
 * 场外基金：6位但不在上述前缀，且账户类型为基金平台 → fund_mix
 *
 * @param {string} code 产品代码
 * @param {string} [accountType] 账户类型（可选，用于区分场外基金）
 * @returns {string} product_type key，无法推断时返回 ''
 */
function inferProductType(code, accountType) {
  if (!code) return '';
  const c = String(code).trim().toUpperCase();

  // 港股：5位纯数字（如 00700）
  if (/^\d{5}$/.test(c)) return 'hk_stock';

  // 美股：字母开头（如 AAPL、BABA）
  if (/^[A-Z]/.test(c)) return 'us_stock';

  // A股/基金：6位数字
  if (/^\d{6}$/.test(c)) {
    // 沪市 REITs（508xxx，必须在 50/51/52 之前判断）
    if (/^508/.test(c)) return 'reit';
    // 沪市科创50 ETF（588xxx，必须在 58 之前判断）
    if (/^588/.test(c)) return 'etf';
    // 沪市 ETF（50/51/52 开头，排除 508 后剩余）
    if (/^5[012]/.test(c)) return 'etf';
    // 沪市跨境ETF
    if (/^56/.test(c)) return 'etf';
    // 沪市 REITs（58 开头，排除 588 后剩余）
    if (/^58/.test(c)) return 'reit';
    // 深市 ETF
    if (/^15/.test(c)) return 'etf';
    // 深市 LOF
    if (/^16/.test(c)) return 'lof';
    // 深市 REITs
    if (/^18/.test(c)) return 'reit';
    // 沪市股票 60/68
    if (/^6[08]/.test(c)) return 'stock';
    // 深市股票 00/30
    if (/^0[03]/.test(c)) return 'stock';
    // 其余6位数字代码：若账户是基金平台，推断为场外基金
    if (accountType === 'fund_platform' || accountType === 'fund') return 'fund_mix';
    // 默认按股票处理（多数6位代码为股票）
    return 'stock';
  }

  return '';
}

/**
 * 推断交易所（与 product_type 配套）
 * @param {string} code 产品代码
 * @returns {string} 'SH' | 'SZ' | 'HK' | 'US' | ''
 */
function inferExchange(code) {
  if (!code) return '';
  const c = String(code).trim().toUpperCase();
  if (/^\d{5}$/.test(c)) return 'HK';
  if (/^[A-Z]/.test(c)) return 'US';
  if (/^\d{6}$/.test(c)) {
    if (/^6[08]/.test(c)) return 'SH';
    if (/^5[0128]/.test(c)) return 'SH';  // 50/51/52/58 均为沪市
    if (/^0[03]/.test(c)) return 'SZ';
    if (/^1[568]/.test(c)) return 'SZ';
  }
  return '';
}

/**
 * product_type key → 中文显示名（与 constants.wxs 保持一致）
 */
const PRODUCT_TYPE_NAMES = {
  stock: '股票',
  hk_stock: '港股',
  us_stock: '美股',
  etf: 'ETF',
  lof: 'LOF',
  reit: 'REITs',
  fund_stock: '股票型基金',
  fund_mix: '混合型基金',
  fund_bond: '债券型基金',
  fund_index: '指数型基金',
  fund_money: '货币型基金',
  cash: '现金',
};

function productTypeName(type) {
  return PRODUCT_TYPE_NAMES[type] || type || '未分类';
}

module.exports = {
  inferProductType,
  inferExchange,
  productTypeName,
  PRODUCT_TYPE_NAMES,
};
