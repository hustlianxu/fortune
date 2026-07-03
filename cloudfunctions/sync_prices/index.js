/**
 * 每日净值同步云函数
 * 定时触发: 交易日 16:30
 *
 * 从 holdings 获取所有 product_code，按类型分批调用行情接口
 * 更新 price_cache 集合 和 holdings 的 current_price/market_value/pnl/daily_change
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const http = require('./http');

/**
 * 腾讯行情接口 - 批量查询
 * @param {string[]} codes - ['sh600036', 'sz510050', 'hk00700']
 */
async function fetchTencentPrices(codes) {
  if (!codes || codes.length === 0) return {};
  const queryStr = codes.join(',');
  const url = `https://qt.gtimg.cn/q=${queryStr}`;

  try {
    const text = await http.getText(url);
    return parseTencentResponse(text);
  } catch (err) {
    console.error('[fetchTencentPrices] error:', err);
    return {};
  }
}

/**
 * 解析腾讯行情返回（T+0 实时数据）
 * 格式: v_sh600036="1~招商银行~..."; v_sz510050="...";
 */
function parseTencentResponse(text) {
  const result = {};
  const lines = text.split(';');
  for (const line of lines) {
    if (!line.includes('="')) continue;
    try {
      const parts = line.split('=');
      const value = parts[1] ? parts[1].replace(/^"|"$/g, '') : '';
      if (!value) continue;

      const fields = value.split('~');
      // 腾讯行情字段索引
      // 1: 名称, 3: 当前价, 4: 昨收, 5: 开盘, 31: 最高, 32: 最低
      const code = parts[0].split('_')[1] || '';
      const name = fields[1] || '';
      const price = parseFloat(fields[3]) || 0;
      const prevClose = parseFloat(fields[4]) || 0;

      if (price > 0) {
        const change = price - prevClose;
        const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
        result[code] = { price, change, changePercent, name };
      }
    } catch (e) {
      // skip malformed line
    }
  }
  return result;
}

/**
 * 天天基金净值接口
 * @param {string[]} fundCodes - 基金代码列表
 */
async function fetchFundPrices(fundCodes) {
  if (!fundCodes || fundCodes.length === 0) return {};
  const result = {};

  // 天天基金接口限制，分 10 个一批查询
  const batchSize = 10;
  for (let i = 0; i < fundCodes.length; i += batchSize) {
    const batch = fundCodes.slice(i, i + batchSize);
    const promises = batch.map(code =>
      http.getText(`https://fundgz.1234567.com.cn/js/${code}.js`)
        .then(text => {
          // jsonpgz({"fundcode":"110011","name":"...","jzrq":"...","dwjz":"...","gsz":"...","gszzl":"..."});
          const match = text.match(/jsonpgz\(({.*?})\)/);
          if (match) {
            const data = JSON.parse(match[1]);
            const price = parseFloat(data.gsz) || 0;
            const changePercent = parseFloat(data.gszzl) || 0;
            if (price > 0) {
              // 基金估算的 gszzl 是当日涨跌幅，反推 change 用于今日收益
              const change = changePercent !== 0 ? price * changePercent / 100 : 0;
              result[code] = {
                price,
                change,
                changePercent,
                name: data.name || '',
              };
            }
          }
        })
        .catch(() => {})
    );
    await Promise.all(promises);
    // 避免请求过快被限制
    if (i + batchSize < fundCodes.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return result;
}

/**
 * 根据代码推断交易所前缀（比 exchange 字段更可靠）
 */
function inferStockPrefix(code, exchange) {
  const ex = (exchange || '').toLowerCase();
  if (ex === 'hk') return 'hk';
  if (/^(60|68|50|51|52|56|58)/.test(code)) return 'sh';
  if (/^(00|30|15|16|12|14)/.test(code)) return 'sz';
  if (ex === 'sz') return 'sz';
  return 'sh';
}

// 根据代码推断 product_type（用于持仓缺类型时兜底回写）
function inferProductType(code) {
  if (!code) return '';
  const c = String(code).trim().toUpperCase();
  if (/^\d{5}$/.test(c)) return 'hk_stock';
  if (/^[A-Z]/.test(c)) return 'us_stock';
  if (/^\d{6}$/.test(c)) {
    if (/^508/.test(c)) return 'reit';
    if (/^588/.test(c)) return 'etf';
    if (/^5[012]/.test(c)) return 'etf';
    if (/^56/.test(c)) return 'etf';
    if (/^58/.test(c)) return 'reit';
    if (/^15/.test(c)) return 'etf';
    if (/^16/.test(c)) return 'lof';
    if (/^18/.test(c)) return 'reit';
    if (/^6[08]/.test(c)) return 'stock';
    if (/^0[03]/.test(c)) return 'stock';
    return 'stock';
  }
  return '';
}

async function fetchAllHoldings() {
  const PAGE_SIZE = 100;
  let all = [];
  let skip = 0;
  while (true) {
    const res = await db.collection('holdings').skip(skip).limit(PAGE_SIZE).get();
    all = all.concat(res.data || []);
    if (!res.data || res.data.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    if (skip > 5000) break;
  }
  return all;
}

exports.main = async (event) => {
  try {
    // 1. 获取所有持仓
    const holdings = await fetchAllHoldings();
    if (!holdings || holdings.length === 0) {
      return { success: true, message: '无持仓数据，跳过更新', updated: 0 };
    }

    // 2. 按产品类型分组
    const stockEtfCodes = [];
    const fundCodes = [];

    for (const h of holdings) {
      const code = h.product_code;
      const type = h.product_type;
      if (!code) continue;
      // product_type 缺失时按 6 位数字代码推断为股票/ETF，避免行情永远不更新
      const isStock = ['stock', 'etf', 'lof', 'hk_stock', 'us_stock'].includes(type)
        || (!type && /^\d{6}$/.test(code));
      if (isStock) {
        const prefix = inferStockPrefix(code, h.exchange);
        stockEtfCodes.push(`${prefix}${code}`);
      } else if (type && type.indexOf('fund') === 0) {
        fundCodes.push(code);
      }
    }

    // 3. 并行获取行情
    const [stockPrices, fundPrices] = await Promise.all([
      stockEtfCodes.length > 0 ? fetchTencentPrices(stockEtfCodes) : {},
      fundCodes.length > 0 ? fetchFundPrices(fundCodes) : {},
    ]);

    // 合并价格
    const allPrices = Object.assign({}, stockPrices, fundPrices);

    // 4. 更新 holdings
    let updateCount = 0;

    for (const h of holdings) {
      const priceData = allPrices[h.product_code]
        || allPrices[`sh${h.product_code}`]
        || allPrices[`sz${h.product_code}`]
        || allPrices[`hk${h.product_code}`];
      if (!priceData || !priceData.price) continue;

      const currentPrice = priceData.price;
      const marketValue = Number((h.shares * currentPrice).toFixed(2));
      // cost_value 为 0 是合法值（清仓持仓），仅在 null/undefined/NaN 时回退到 shares × cost_price
      const costValue = (h.cost_value !== null && h.cost_value !== undefined && !isNaN(h.cost_value))
        ? Number(h.cost_value)
        : (Number(h.shares) || 0) * (Number(h.cost_price) || 0);
      const pnl = Number((marketValue - costValue).toFixed(2));
      const pnlPercent = costValue > 0 ? Number(((pnl / costValue) * 100).toFixed(2)) : 0;
      // 当日变动（daily_change 为每股涨跌额，daily_change_percent 为涨跌幅百分比）
      const dailyChange = Number(priceData.change) || 0;
      const dailyChangePercent = Number(priceData.changePercent) || 0;
      // 总收益（同花顺口径）：浮动 + 已实现 + 分红
      // 手续费已计入成本(买入)与已实现盈亏(卖出)，不重复扣减
      const realized = Number(h.realized_pnl) || 0;
      const dividend = Number(h.total_dividend) || 0;
      const totalPnl = Number((pnl + realized + dividend).toFixed(2));

      // 顺带修正交易所
      const correctPrefix = inferStockPrefix(h.product_code, h.exchange);
      const correctExchange = correctPrefix === 'hk' ? 'HK'
        : (correctPrefix === 'sz' ? 'SZ' : 'SH');
      const updateData = {
        current_price: currentPrice,
        market_value: marketValue,
        pnl,
        pnl_percent: pnlPercent,
        total_pnl: totalPnl,
        daily_change: dailyChange,
        daily_change_percent: dailyChangePercent,
        price_updated_at: db.serverDate(),
      };
      if (h.exchange !== correctExchange) {
        updateData.exchange = correctExchange;
      }
      // 顺带补全 product_type（仅当持仓缺类型时，按代码推断回写）
      if (!h.product_type) {
        const inferredType = inferProductType(h.product_code);
        if (inferredType) updateData.product_type = inferredType;
      }

      await db.collection('holdings').doc(h._id).update({ data: updateData });

      updateCount++;
    }

    // 5. 更新 price_cache
    const today = new Date().toISOString().split('T')[0];
    for (const [code, data] of Object.entries(allPrices)) {
      // 移除可能的前缀（sh/sz/hk）
      const cleanCode = code.replace(/^(sh|sz|hk)/, '');
      try {
        await db.collection('price_cache').doc(`${cleanCode}_${today}`).set({
          data: {
            product_code: cleanCode,
            price: data.price,
            change: data.change || 0,
            change_percent: data.changePercent || 0,
            date: today,
            updated_at: db.serverDate(),
          },
        });
      } catch (e) {
        // ignore cache write errors
      }
    }

    return {
      success: true,
      message: `更新成功`,
      updated: updateCount,
      stockCount: stockEtfCodes.length,
      fundCount: fundCodes.length,
    };

  } catch (err) {
    console.error('[sync_prices] error:', err);
    return {
      success: false,
      message: err.message,
    };
  }
};
