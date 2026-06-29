/**
 * 产品信息查询云函数
 * 通过产品代码或名称查询股票/基金信息
 *
 * 请求参数:
 *   code: string - 产品代码（如 600036）
 *   name: string - 产品名称模糊搜索（如 招商银行）
 *
 * 返回:
 *   success: boolean
 *   products: [{ code, name, type, exchange }]
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const http = require('./http');
const iconv = require('iconv-lite');

/**
 * 通过腾讯行情接口查询股票/ETF/LOF
 */
async function queryByCode(code) {
  const codeStr = code.trim().toUpperCase();
  const prefixes = ['sh', 'sz', 'hk'];

  // 并行查询所有交易所前缀，并用 iconv-lite 解码 GBK 数据避免乱码
  const results = await Promise.all(
    prefixes.map(async (prefix) => {
      try {
        const url = `https://qt.gtimg.cn/q=${prefix}${codeStr}`;
        const res = await http.request(url);
        const buf = await res.buffer();
        const text = iconv.decode(buf, 'gbk');
        const parsed = parseTencentLine(text);
        return (parsed && parsed.name && parsed.code) ? parsed : null;
      } catch (e) {
        return null;
      }
    })
  );

  return results.filter(r => r !== null);
}

function parseTencentLine(text) {
  if (!text.includes('="')) return null;
  try {
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;
    const fields = match[1].split('~');
    const codePart = text.split('_')[1] ? text.split('_')[1].split('=')[0] : '';
    const code = codePart || '';
    const name = fields[1] || '';
    const price = parseFloat(fields[3]) || 0;
    const prevClose = parseFloat(fields[4]) || 0;

    if (!code || !name || code === '') return null;

    // 判断产品类型
    let type = 'stock';
    let exchange = 'SH';
    if (code.indexOf('hk') === 0) exchange = 'HK';
    else if (code.indexOf('sz') === 0) exchange = 'SZ';

    const rawCode = code.replace(/^(sh|sz|hk)/, '');
    if (rawCode.indexOf('51') === 0 || rawCode.indexOf('16') === 0) type = 'etf';
    if (rawCode.indexOf('50') === 0) type = 'etf';

    return { code: rawCode, name, type, exchange, price };
  } catch (e) {
    return null;
  }
}

/**
 * 通过天天基金查询场外基金
 */
async function queryFundByCode(code) {
  try {
    const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
    const text = await http.getText(url);
    const match = text.match(/jsonpgz\(({.*?})\)/);
    if (match) {
      const data = JSON.parse(match[1]);
      return [{
        code: data.fundcode || '',
        name: data.name || '',
        type: 'fund_mix',
        exchange: '',
        price: parseFloat(data.gsz) || 0,
      }];
    }
  } catch (e) {}
  return [];
}

/**
 * 通过名称模糊搜索（利用腾讯行情批量查询常用股票池）
 * 简化方案：返回常见股票/ETF/LOF的映射
 */
function searchByName(name) {
  if (!name || name.length < 1) return [];

  // 常用产品映射表（高频交易产品）
  const commonProducts = [
    // 银行
    { code: '600036', name: '招商银行', type: 'stock', exchange: 'SH' },
    { code: '601398', name: '工商银行', type: 'stock', exchange: 'SH' },
    { code: '601939', name: '建设银行', type: 'stock', exchange: 'SH' },
    { code: '601288', name: '农业银行', type: 'stock', exchange: 'SH' },
    { code: '600000', name: '浦发银行', type: 'stock', exchange: 'SH' },
    { code: '600016', name: '民生银行', type: 'stock', exchange: 'SH' },
    // 保险
    { code: '601318', name: '中国平安', type: 'stock', exchange: 'SH' },
    { code: '601628', name: '中国人寿', type: 'stock', exchange: 'SH' },
    // 消费
    { code: '600519', name: '贵州茅台', type: 'stock', exchange: 'SH' },
    { code: '000858', name: '五粮液', type: 'stock', exchange: 'SZ' },
    { code: '600887', name: '伊利股份', type: 'stock', exchange: 'SH' },
    // 科技
    { code: '000063', name: '中兴通讯', type: 'stock', exchange: 'SZ' },
    { code: '002415', name: '海康威视', type: 'stock', exchange: 'SZ' },
    { code: '600941', name: '中国移动', type: 'stock', exchange: 'SH' },
    // 医药
    { code: '600276', name: '恒瑞医药', type: 'stock', exchange: 'SH' },
    { code: '300760', name: '迈瑞医疗', type: 'stock', exchange: 'SZ' },
    { code: '000538', name: '云南白药', type: 'stock', exchange: 'SZ' },
    // 新能源
    { code: '300750', name: '宁德时代', type: 'stock', exchange: 'SZ' },
    { code: '601012', name: '隆基绿能', type: 'stock', exchange: 'SH' },
    { code: '002594', name: '比亚迪', type: 'stock', exchange: 'SZ' },
    // ETF
    { code: '510050', name: '上证50ETF', type: 'etf', exchange: 'SH' },
    { code: '510300', name: '沪深300ETF', type: 'etf', exchange: 'SH' },
    { code: '510500', name: '中证500ETF', type: 'etf', exchange: 'SH' },
    { code: '588000', name: '科创50ETF', type: 'etf', exchange: 'SH' },
    { code: '159915', name: '创业板ETF', type: 'etf', exchange: 'SZ' },
    { code: '159949', name: '创业板50ETF', type: 'etf', exchange: 'SZ' },
    { code: '513100', name: '纳指ETF', type: 'etf', exchange: 'SH' },
    { code: '513050', name: '中概互联网ETF', type: 'etf', exchange: 'SH' },
    // LOF
    { code: '161720', name: '证券LOF', type: 'lof', exchange: 'SZ' },
    { code: '163415', name: '兴全商业模式LOF', type: 'lof', exchange: 'SZ' },
    // 热门基金
    { code: '110011', name: '易方达中小盘混合', type: 'fund_mix', exchange: '' },
    { code: '000001', name: '华夏成长混合', type: 'fund_mix', exchange: '' },
    { code: '110020', name: '易方达沪深300ETF联接', type: 'fund_index', exchange: '' },
    { code: '161005', name: '富国天惠成长混合', type: 'fund_mix', exchange: '' },
    { code: '110017', name: '易方达增强回报债券', type: 'fund_bond', exchange: '' },
  ];

  const keyword = name.toLowerCase();
  const matched = commonProducts.filter(p =>
    p.name.indexOf(keyword) >= 0 || p.code.indexOf(keyword) >= 0
  );

  // 如果有精确代码匹配，优先返回
  const exactCode = matched.filter(p => p.code === keyword);
  const other = matched.filter(p => p.code !== keyword);
  return exactCode.concat(other).slice(0, 10);
}

exports.main = async (event) => {
  const { code, name } = event;

  try {
    let products = [];

    if (code) {
      // 按代码查询（精确匹配）
      const stockResults = await queryByCode(code);
      const fundResults = await queryFundByCode(code);
      products = stockResults.concat(fundResults);
    }

    if (name && !code) {
      // 按名称模糊搜索
      products = searchByName(name);
    }

    return {
      success: true,
      products,
      source: code ? 'api' : 'local',
    };
  } catch (err) {
    console.error('[lookup_product] error:', err);
    return { success: false, products: [], message: err.message };
  }
};
