/**
 * 批量导入解析云函数
 * 解析 CSV 数据，校验后写入 accounts 和 holdings 集合
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 解析 CSV 行
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

/**
 * 标准化产品类型
 */
function normalizeProductType(type) {
  const map = {
    '股票': 'stock', 'stock': 'stock',
    'ETF': 'etf', 'etf': 'etf',
    'LOF': 'lof', 'lof': 'lof',
    '股票型基金': 'fund_stock', '基金_股票': 'fund_stock',
    '混合型基金': 'fund_mix', '基金_混合': 'fund_mix',
    '债券型基金': 'fund_bond', '基金_债券': 'fund_bond',
    '指数型基金': 'fund_index', '基金_指数': 'fund_index',
    '货币型基金': 'fund_money', '基金_货币': 'fund_money',
    '基金_场外': 'fund_mix',
    '现金': 'cash', '余额': 'cash',
  };
  return map[type] || type || 'stock';
}

exports.main = async (event) => {
  const { csvData } = event;
  if (!csvData) {
    return { success: false, message: '请提供 CSV 数据', errors: [] };
  }

  // 当前调用者 openid（用于多租户隔离，避免跨用户复用同名账户/持仓串改）
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';

  const lines = csvData.trim().split('\n');
  if (lines.length < 2) {
    return { success: false, message: 'CSV 数据至少需要一行表头+一行数据', errors: [] };
  }

  const header = parseCSVLine(lines[0]);
  const expectedHeaders = ['account', 'product_code', 'product_name', 'product_type', 'exchange', 'shares', 'cost_price', 'buy_date', 'note'];

  // 校验表头
  const headerMap = {};
  header.forEach((h, i) => {
    const idx = expectedHeaders.indexOf(h.trim().toLowerCase());
    if (idx >= 0) headerMap[idx] = i;
  });

  const errors = [];
  const successLines = [];
  const accountMap = {}; // 缓存账户ID

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    const lineNum = i + 1;

    try {
      const accountName = fields[headerMap[0]]?.trim();
      const productCode = fields[headerMap[1]]?.trim();
      const productName = fields[headerMap[2]]?.trim() || productCode;
      const productType = normalizeProductType(fields[headerMap[3]]?.trim());
      const exchange = fields[headerMap[4]]?.trim()?.toUpperCase() || 'SH';
      const shares = parseFloat(fields[headerMap[5]]?.trim()) || 0;
      const costPrice = parseFloat(fields[headerMap[6]]?.trim()) || 0;
      const buyDate = fields[headerMap[7]]?.trim() || '';
      const note = fields[headerMap[8]]?.trim() || '';

      // 校验必填字段
      if (!accountName) { errors.push(`第 ${lineNum} 行: 缺少账户名称`); continue; }
      if (!productCode) { errors.push(`第 ${lineNum} 行: 缺少产品代码`); continue; }
      if (shares <= 0) { errors.push(`第 ${lineNum} 行: 份额必须大于 0`); continue; }
      if (costPrice <= 0) { errors.push(`第 ${lineNum} 行: 成本价必须大于 0`); continue; }

      // 获取或创建账户（按 name + openid 隔离，避免跨用户复用同名账户）
      let accountId = accountMap[accountName];
      if (!accountId) {
        const accWhere = openid ? { name: accountName, _openid: openid } : { name: accountName };
        const { data: existingAcc } = await db.collection('accounts')
          .where(accWhere)
          .get();

        if (existingAcc.length > 0) {
          accountId = existingAcc[0]._id;
        } else {
          const res = await db.collection('accounts').add({
            data: {
              name: accountName,
              type: 'custom',
              platform: 'other_broker',
              cash_balance: 0,
              sort_order: 0,
              _openid: openid,
              created_at: db.serverDate(),
              updated_at: db.serverDate(),
            },
          });
          accountId = res._id;
        }
        accountMap[accountName] = accountId;
      }

      // 计算初始值
      const costValue = shares * costPrice;
      const importBatch = new Date().toISOString().split('T')[0];

      // 写入持仓
      await db.collection('holdings').add({
        data: {
          account_id: accountId,
          _openid: openid,
          product_code: productCode,
          product_name: productName,
          product_type: productType,
          exchange,
          shares,
          cost_price: costPrice,
          current_price: costPrice, // 初始值与成本价一致
          cost_value: costValue,
          market_value: costValue,
          pnl: 0,
          pnl_percent: 0,
          buy_date: buyDate,
          note,
          import_batch: importBatch,
          created_at: db.serverDate(),
          updated_at: db.serverDate(),
        },
      });

      successLines.push({
        line: lineNum,
        product: productCode,
        message: '导入成功',
      });
    } catch (err) {
      errors.push(`第 ${lineNum} 行: ${err.message}`);
    }
  }

  return {
    success: true,
    total: lines.length - 1,
    imported: successLines.length,
    errors: errors.slice(0, 20), // 最多返回 20 条错误
    errorCount: errors.length,
  };
};
