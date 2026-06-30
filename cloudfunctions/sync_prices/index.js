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

exports.main = async (event) => {
  try {
    // 1. 获取所有持仓
    const { data: holdings } = await db.collection('holdings').get();
    if (!holdings || holdings.length === 0) {
      return { success: true, message: '无持仓数据，跳过更新', updated: 0 };
    }

    // 2. 按产品类型分组
    const stockEtfCodes = [];
    const fundCodes = [];

    for (const h of holdings) {
      const code = h.product_code;
      const type = h.product_type;
      const exchange = (h.exchange || 'SH').toLowerCase();

      if (['stock', 'etf', 'lof', 'hk_stock', 'us_stock'].includes(type)) {
        // 腾讯行情需要前缀: sh / sz / hk
        let prefix = 'sh';
        if (exchange === 'sz') prefix = 'sz';
        else if (exchange === 'hk') prefix = 'hk';
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
      const marketValue = h.shares * currentPrice;
      // cost_value 为 0 是合法值（清仓持仓），仅在 null/undefined/NaN 时回退到 shares × cost_price
      const costValue = (h.cost_value !== null && h.cost_value !== undefined && !isNaN(h.cost_value))
        ? Number(h.cost_value)
        : (Number(h.shares) || 0) * (Number(h.cost_price) || 0);
      const pnl = marketValue - costValue;
      const pnlPercent = costValue > 0 ? (pnl / costValue) * 100 : 0;
      // 当日变动额（用于今日收益展示）
      const dailyChange = priceData.change || 0;
      // 总收益（同花顺口径）：浮动 + 已实现 + 分红 - 累计手续费
      const realized = Number(h.realized_pnl) || 0;
      const dividend = Number(h.total_dividend) || 0;
      const totalFee = Number(h.total_fee) || 0;
      const totalPnl = Number((pnl + realized + dividend - totalFee).toFixed(2));

      await db.collection('holdings').doc(h._id).update({
        data: {
          current_price: currentPrice,
          market_value: marketValue,
          pnl,
          pnl_percent: pnlPercent,
          total_pnl: totalPnl,
          daily_change: dailyChange,
          price_updated_at: db.serverDate(),
        },
      });

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
