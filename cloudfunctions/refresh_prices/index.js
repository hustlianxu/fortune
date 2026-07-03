/**
 * 手动刷新行情云函数
 * 用户点击「刷新净值」时调用
 * 与 sync_prices 逻辑相同但加入了调用频率限制（5分钟）
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const http = require('./http');

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
      const code = parts[0].split('_')[1] || '';
      const price = parseFloat(fields[3]) || 0;
      const prevClose = parseFloat(fields[4]) || 0;
      if (price > 0) {
        const change = price - prevClose;
        result[code] = {
          price,
          change,
          changePercent: prevClose > 0 ? (change / prevClose) * 100 : 0,
          name: fields[1] || '',
        };
      }
    } catch (e) {}
  }
  return result;
}

async function fetchFundPrices(fundCodes) {
  if (!fundCodes || fundCodes.length === 0) return {};
  const result = {};
  for (const code of fundCodes) {
    try {
      const text = await http.getText(`https://fundgz.1234567.com.cn/js/${code}.js`);
      const match = text.match(/jsonpgz\(({.*?})\)/);
      if (match) {
        const data = JSON.parse(match[1]);
        const price = parseFloat(data.gsz) || 0;
        const changePercent = parseFloat(data.gszzl) || 0;
        if (price > 0) {
          const change = changePercent !== 0 ? price * changePercent / 100 : 0;
          result[code] = {
            price,
            change,
            changePercent,
            name: data.name || '',
          };
        }
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return result;
}

/**
 * 根据代码推断交易所前缀（比 exchange 字段更可靠）
 * 沪市: 60xxxx(主板) 68xxxx(科创板) 50/51/52/56/58xxxx(ETF/基金)
 * 深市: 00xxxx(主板) 30xxxx(创业板) 15/16/12/14xxxx(基金/ETF)
 * 港股: exchange=hk
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

async function fetchAllHoldings(openid) {
  const PAGE_SIZE = 100;
  let all = [];
  let skip = 0;
  while (true) {
    let query = db.collection('holdings');
    if (openid) query = query.where({ _openid: openid });
    const res = await query.skip(skip).limit(PAGE_SIZE).get();
    all = all.concat(res.data || []);
    if (!res.data || res.data.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    if (skip > 5000) break;
  }
  return all;
}

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID || '';
    const holdings = await fetchAllHoldings(openid);
    if (!holdings || holdings.length === 0) {
      return { success: true, message: '暂无持仓', updated: 0 };
    }

    const stockCodes = [];
    const fundCodes = [];
    for (const h of holdings) {
      const type = h.product_type;
      const code = h.product_code;
      if (!code) continue;
      // product_type 缺失时按 6 位数字代码推断为股票/ETF，避免行情永远不更新
      const isStock = ['stock', 'etf', 'lof', 'hk_stock', 'us_stock'].includes(type)
        || (!type && /^\d{6}$/.test(code));
      if (isStock) {
        const prefix = inferStockPrefix(code, h.exchange);
        stockCodes.push(`${prefix}${code}`);
      } else if (type && type.indexOf('fund') === 0) {
        fundCodes.push(code);
      }
    }

    const [stockPrices, fundPrices] = await Promise.all([
      stockCodes.length > 0 ? fetchTencentPrices(stockCodes) : {},
      fundCodes.length > 0 ? fetchFundPrices(fundCodes) : {},
    ]);

    const allPrices = Object.assign({}, stockPrices, fundPrices);
    let updateCount = 0;

    for (const h of holdings) {
      const priceData = allPrices[h.product_code]
        || allPrices[`sh${h.product_code}`]
        || allPrices[`sz${h.product_code}`]
        || allPrices[`hk${h.product_code}`];
      if (!priceData || !priceData.price) continue;

      const marketValue = Number((h.shares * priceData.price).toFixed(2));
      // cost_value 为 0 是合法值（清仓持仓），仅在 null/undefined/NaN 时回退到 shares × cost_price
      const costValue = (h.cost_value !== null && h.cost_value !== undefined && !isNaN(h.cost_value))
        ? Number(h.cost_value)
        : (Number(h.shares) || 0) * (Number(h.cost_price) || 0);
      const pnl = Number((marketValue - costValue).toFixed(2));
      const pnlPercent = costValue > 0 ? Number(((pnl / costValue) * 100).toFixed(2)) : 0;
      const dailyChange = Number(priceData.change) || 0;
      const dailyChangePercent = Number(priceData.changePercent) || 0;
      // 总收益（同花顺口径）：浮动 + 已实现 + 分红
      // 手续费已计入成本(买入)与已实现盈亏(卖出)，不重复扣减
      const realized = Number(h.realized_pnl) || 0;
      const dividend = Number(h.total_dividend) || 0;
      const totalPnl = Number((pnl + realized + dividend).toFixed(2));

      // 顺带修正交易所（exchange 为空或与推断不符时写回，保证后续接口/费率正确）
      const correctPrefix = inferStockPrefix(h.product_code, h.exchange);
      const correctExchange = correctPrefix === 'hk' ? 'HK'
        : (correctPrefix === 'sz' ? 'SZ' : 'SH');
      const updateData = {
        current_price: priceData.price,
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

    return {
      success: true,
      message: `已更新 ${updateCount} 条持仓`,
      updated: updateCount,
    };
  } catch (err) {
    console.error('[refresh_prices] error:', err);
    return { success: false, message: err.message };
  }
};
