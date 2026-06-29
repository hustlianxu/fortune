/**
 * 格式化工具函数
 */

/**
 * 格式化金额（带千分位）
 * @param {number} value
 * @param {number} decimals - 小数位数
 * @returns {string}
 */
function formatMoney(value, decimals = 2) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  const prefix = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const [intPart, decPart] = abs.toFixed(decimals).split('.');
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${prefix}${formattedInt}.${decPart}`;
}

/**
 * 格式化百分比
 * @param {number} value - 如 3.51 表示 3.51%
 * @param {boolean} showSign - 是否显示 +/-
 */
function formatPercent(value, showSign = true) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  const prefix = value > 0 && showSign ? '+' : (value < 0 ? '' : '');
  return `${prefix}${value.toFixed(2)}%`;
}

/**
 * 格式化数量（份额/股数）
 */
function formatQuantity(value) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  if (value >= 100000000) return `${(value / 100000000).toFixed(2)}亿`;
  if (value >= 10000) return `${(value / 10000).toFixed(2)}万`;
  return value.toFixed(0);
}

/**
 * 格式化日期
 * @param {string|Date} date
 * @param {string} format - YYYY-MM-DD / MM-DD / YYYY年MM月DD日
 */
function formatDate(date, format = 'YYYY-MM-DD') {
  if (!date) return '--';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '--';

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');

  const map = {
    'YYYY-MM-DD': `${year}-${month}-${day}`,
    'MM-DD': `${month}-${day}`,
    'YYYY/MM/DD': `${year}/${month}/${day}`,
    'YYYY年MM月DD日': `${year}年${month}月${day}日`,
    'MM月DD日': `${month}月${day}日`,
    'MM-DD HH:mm': `${month}-${day} ${hours}:${minutes}`,
    'YYYY-MM-DD HH:mm': `${year}-${month}-${day} ${hours}:${minutes}`,
  };
  return map[format] || `${year}-${month}-${day}`;
}

/**
 * 格式化日期时间
 */
function formatDateTime(date) {
  if (!date) return '--';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '--';
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${formatDate(date)} ${time}`;
}

/**
 * 获取价格颜色类名
 * @param {number} value - 涨跌幅或涨跌额
 * @returns {string} price-up | price-down | price-flat
 */
function getPriceColor(value) {
  if (!value || value === 0 || isNaN(value)) return 'price-flat';
  return value > 0 ? 'price-up' : 'price-down';
}

/**
 * 获取涨跌箭头符号
 */
function getPriceArrow(value) {
  if (!value || value === 0 || isNaN(value)) return '→';
  return value > 0 ? '↑' : '↓';
}

/**
 * 截断字符串
 */
function truncate(str, maxLen = 20) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * 深拷贝
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = {
  formatMoney,
  formatPercent,
  formatQuantity,
  formatDate,
  formatDateTime,
  getPriceColor,
  getPriceArrow,
  truncate,
  deepClone,
};
