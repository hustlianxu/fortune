/**
 * parse_trades_by_text
 * 用 LLM 把自然语言交易描述解析为结构化 ParsedTrade[]，可选批量写入 transactions。
 *
 * 入参：
 *   {
 *     mode: 'text' | 'json',     // 默认 'text'；'json' 模式直接校验/导入外部 LLM 输出
 *     text: string,              // mode='text' 时必填：自然语言交易描述
 *     json: string | ParsedTrade[],  // mode='json' 时必填：已解析的 JSON
 *     account_id: string,        // 目标账户 ID（必填）
 *     provider?: string,         // LLM 提供商，默认取用户已配置且启用的第一个
 *     dry_run?: boolean,         // true=仅解析不写入（默认 true）
 *   }
 *
 * 返回：
 *   {
 *     success: boolean,
 *     trades: ParsedTrade[],
 *     warnings: string[],
 *     imported: number,          // dry_run=false 时实际写入条数
 *     message?: string,
 *   }
 *
 * 详见 docs/06-大模型语音导入指南.md
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const http = require('./http');
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const AES_KEY = process.env.AES_KEY || 'your-default-32-char-aes-key-string!';
const IV_LENGTH = 16;

function decrypt(encrypted) {
  if (!encrypted) return '';
  try {
    const parts = encrypted.split(':');
    if (parts.length < 2) return '';
    const iv = Buffer.from(parts[0], 'base64');
    const encryptedText = Buffer.from(parts[1], 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(AES_KEY), iv);
    let decrypted = decipher.update(encryptedText, null, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Decrypt] error:', err);
    return '';
  }
}

const PROVIDERS = {
  deepseek: { baseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
  qwen:     { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  glm:      { baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4' },
  kimi:     { baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k' },
  chatgpt:  { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  claude:   { baseURL: '', defaultModel: 'claude-sonnet-4-20250514' },
  bailian:  { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-max' },
  mimo:     { baseURL: 'https://api.mi-ai.com/v1', defaultModel: 'MiMo' },
  minimax:  { baseURL: 'https://api.minimax.chat/v1', defaultModel: 'MiniMax-Text-01' },
  custom:   { baseURL: '', defaultModel: '' },
};

/**
 * 解析提示词（与 docs/06 一致）
 */
function buildParsePrompt(text) {
  const year = new Date().getFullYear();
  return `你是一个金融交易记录解析助手。请把用户输入的自然语言交易描述解析成结构化 JSON。

规则：
1. 日期格式统一为 YYYY-MM-DD，年份缺失时用当前年份 ${year}
2. 金额"36块5""36.5""36元5"都解析为 36.50
3. type 只能是：buy(买入) / sell(卖出) / dividend(分红) / transfer_in(转入) / transfer_out(转出) / fee(手续费) / interest(利息)
4. 产品代码缺失时填空字符串，产品名称尽量保留原文
5. 手续费：用户明确提到时填入 fee 字段（单位：元）；未提到则填 0（系统会按账户费率自动计算，无需估算）
6. 分红/利息类交易 shares 和 price 填 0，amount 填实际金额
7. buy/sell 的 amount = shares × price（不含手续费）
8. 只输出 JSON 数组，不要任何解释文字、不要 markdown 代码块标记

输出格式（严格遵循）：
[
  {
    "type": "buy",
    "product_name": "招商银行",
    "product_code": "",
    "shares": 1000,
    "price": 36.50,
    "fee": 5,
    "amount": 36500,
    "trade_date": "${year}-03-15",
    "note": ""
  }
]

用户输入：
${text}`;
}

/**
 * 调用 OpenAI 兼容接口
 */
async function callOpenAICompatible(provider, apiKey, messages, model) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);
  if (!config.baseURL) throw new Error(`${provider} 未配置 baseURL`);

  const url = `${config.baseURL}/chat/completions`;
  const effectiveModel = model || config.defaultModel;
  if (!effectiveModel) throw new Error(`${provider} 未指定模型名称`);

  const res = await http.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: effectiveModel,
      messages,
      temperature: 0,   // 解析任务用 0 保证稳定输出
      max_tokens: 4096,
    }),
    timeout: 30000,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

/**
 * 调用 Claude
 */
async function callClaude(apiKey, messages, model) {
  const systemMsg = messages.find(m => m.role === 'system');
  const userMsgs = messages.filter(m => m.role !== 'system');
  const effectiveModel = model || PROVIDERS.claude.defaultModel;

  const body = {
    model: effectiveModel,
    max_tokens: 4096,
    messages: userMsgs.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
  };
  if (systemMsg) body.system = systemMsg.content;

  const res = await http.request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    timeout: 30000,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

/**
 * 从 LLM 文本响应中提取 JSON 数组（兼容 ```json 代码块包裹）
 */
function extractJsonArray(content) {
  if (!content) return null;
  // 去掉 markdown 代码块标记
  let txt = content.trim();
  const fenceMatch = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) txt = fenceMatch[1].trim();

  // 找到第一个 [ 到最后一个 ]
  const first = txt.indexOf('[');
  const last = txt.lastIndexOf(']');
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = txt.substring(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    return null;
  }
}

/**
 * 校验并规整单笔 ParsedTrade
 */
function normalizeTrade(t, warnings) {
  if (!t || typeof t !== 'object') return null;
  const type = String(t.type || '').toLowerCase();
  const allowed = ['buy', 'sell', 'dividend', 'transfer_in', 'transfer_out', 'fee', 'interest'];
  if (!allowed.includes(type)) {
    warnings.push(`跳过未知交易类型：${t.type}`);
    return null;
  }
  const shares = Number(t.shares) || 0;
  const price = Number(t.price) || 0;
  const fee = Number(t.fee) || 0;
  let amount = Number(t.amount);
  if (isNaN(amount)) amount = 0;
  // buy/sell 缺失 amount 时按 shares×price 自动补
  if ((type === 'buy' || type === 'sell') && amount === 0 && shares > 0 && price > 0) {
    amount = shares * price;
  }
  // 日期缺失或格式不对
  let tradeDate = String(t.trade_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    warnings.push(`交易"${t.product_name || type}"日期格式异常：${tradeDate}，已用今天兜底`);
    tradeDate = new Date().toISOString().split('T')[0];
  }
  // 买卖/分红/利息类交易需要产品代码才能匹配持仓，缺失时预警
  const needsCode = ['buy', 'sell', 'dividend', 'interest'].indexOf(type) >= 0;
  if (needsCode && !String(t.product_code || '').trim()) {
    warnings.push(`「${t.product_name || type}」缺少产品代码，将无法匹配持仓（请在导入前补全代码）`);
  }
  return {
    type,
    product_name: String(t.product_name || ''),
    product_code: String(t.product_code || '').trim(),
    product_type: String(t.product_type || ''),
    exchange: String(t.exchange || ''),
    shares,
    price,
    fee,
    amount: Number(amount.toFixed(2)),
    trade_date: tradeDate,
    note: String(t.note || ''),
  };
}

/**
 * 根据账户费率自动计算手续费（与 miniprogram/utils/fee.js 口径一致）
 * 证券：佣金 = max(金额×佣金率, 最低佣金) + 过户费(沪市) + 印花税(仅卖出)
 * 基金：申购费 = max(金额×申购费率, 最低申购费)；赎回费 = 金额×赎回费率
 */
function calcTradeFee(account, trade) {
  if (!account || !trade) return 0;
  const type = trade.type;
  if (type !== 'buy' && type !== 'sell') return 0;

  const productType = trade.product_type || '';
  const exchange = (trade.exchange || 'SH').toUpperCase();
  const amount = Number(trade.amount) > 0
    ? Number(trade.amount)
    : (Number(trade.shares) || 0) * (Number(trade.price) || 0);
  if (amount <= 0) return 0;

  const stockTypes = ['stock', 'etf', 'lof', 'reit', 'hk_stock', 'us_stock'];
  if (stockTypes.indexOf(productType) >= 0) {
    const isSh = exchange === 'SH';
    const isSz = exchange === 'SZ';
    let rate = 0, minFee = 0;
    if (productType === 'etf' || productType === 'reit') {
      rate = isSh ? account.sh_etf_rate : (isSz ? account.sz_etf_rate : 0);
      minFee = isSh ? account.sh_etf_min : (isSz ? account.sz_etf_min : 0);
    } else if (productType === 'lof') {
      rate = isSh ? account.sh_lof_rate : (isSz ? account.sz_lof_rate : 0);
      minFee = isSh ? account.sh_lof_min : (isSz ? account.sz_lof_min : 0);
    } else {
      rate = isSh ? account.sh_stock_rate : (isSz ? account.sz_stock_rate : 0);
      minFee = isSh ? account.sh_stock_min : (isSz ? account.sz_stock_min : 0);
    }
    let fee = Math.max(amount * (Number(rate) || 0), Number(minFee) || 0);
    if (isSh) fee += amount * (Number(account.transfer_fee_rate) || 0);
    if (type === 'sell') fee += amount * (Number(account.stamp_duty_rate) || 0);
    return Number(fee.toFixed(2));
  }

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

function hasFeeRates(account) {
  if (!account) return false;
  return [
    account.sh_stock_rate, account.sh_etf_rate, account.sh_lof_rate,
    account.sz_stock_rate, account.sz_etf_rate, account.sz_lof_rate,
    account.transfer_fee_rate, account.stamp_duty_rate,
    account.subscription_fee_rate, account.redemption_fee_rate,
  ].some(v => Number(v) > 0);
}

/**
 * 对解析后的 trades 做后处理：
 * - 推断 product_type / exchange（用于费率计算和写入）
 * - fee 缺失（0）时按账户费率自动计算
 */
async function postProcessTrades(trades, account_id, warnings) {
  if (!trades || trades.length === 0) return trades;

  // 拉账户
  let account = null;
  try {
    const accRes = await db.collection('accounts').doc(account_id).get();
    account = accRes.data || null;
  } catch (e) {
    console.warn('[postProcess] account not found:', account_id, e);
  }

  // 拉账户下已有持仓，用于补全 product_type / exchange
  let holdingsMap = {};
  if (account) {
    try {
      const { data: holdings } = await db.collection('holdings')
        .where({ account_id }).get();
      holdings.forEach(h => {
        const key = (h.product_code || '').toUpperCase();
        if (key) holdingsMap[key] = h;
      });
    } catch (e) {}
  }

  const accountHasRates = hasFeeRates(account);

  return trades.map(t => {
    // 用持仓补全 product_type / exchange（语音输入通常不带这些字段）
    if ((!t.product_type || !t.exchange) && t.product_code) {
      const h = holdingsMap[t.product_code.toUpperCase()];
      if (h) {
        if (!t.product_type) t.product_type = h.product_type || '';
        if (!t.exchange) t.exchange = h.exchange || '';
      }
    }
    // 没有持仓兜底时，按代码前缀粗略推断交易所
    if (!t.exchange && t.product_code) {
      const code = t.product_code;
      if (/^(60[0-9]|68[0-9]|51[0-9]|50[0-9])/.test(code)) t.exchange = 'SH';
      else if (/^(00[0-9]|30[0-9]|15[0-9]|16[0-9])/.test(code)) t.exchange = 'SZ';
    }

    // fee 缺失 → 按账户费率自动算
    if ((t.type === 'buy' || t.type === 'sell') && Number(t.fee) === 0 && accountHasRates) {
      const autoFee = calcTradeFee(account, t);
      if (autoFee > 0) {
        t.fee = autoFee;
        warnings.push(`「${t.product_name || t.product_code}」手续费由账户费率自动计算：¥${autoFee.toFixed(2)}`);
      }
    }
    return t;
  });
}

/**
 * 写入一笔交易并应用到持仓
 * - buy/sell/dividend/interest 需产品代码，缺失则抛错（不写入，避免脏数据）
 * - buy 计算 is_opening（首次建仓）
 * - buy/sell/dividend/interest 调 apply_transaction 应用到持仓，失败仅预警（交易已记录，可重建修复）
 * - transfer_in/transfer_out/fee 仅记录
 */
const HOLDING_AFFECTING = ['buy', 'sell', 'dividend', 'interest'];

async function importTrade(trade, account_id, warnings) {
  const type = trade.type;
  // 影响持仓的交易必须有产品代码
  if (HOLDING_AFFECTING.indexOf(type) >= 0 && !trade.product_code) {
    throw new Error(`「${trade.product_name || type}」缺少产品代码，无法导入`);
  }

  // 判断是否建仓（首次买入）：该账户+代码下既无持仓又无历史买入
  let isOpening = false;
  if (type === 'buy') {
    try {
      const existHolding = await db.collection('holdings')
        .where({ account_id, product_code: trade.product_code })
        .limit(1).get();
      const hasHolding = existHolding.data && existHolding.data.length > 0;
      if (!hasHolding) {
        const existBuy = await db.collection('transactions')
          .where({ account_id, product_code: trade.product_code, type: 'buy' })
          .limit(1).get();
        const hasBuy = existBuy.data && existBuy.data.length > 0;
        isOpening = !hasBuy;
      }
    } catch (e) {
      console.warn('[importTrade] is_opening check error:', e);
    }
  }

  const data = {
    account_id,
    type,
    product_code: trade.product_code || '',
    product_name: trade.product_name || '',
    product_type: trade.product_type || '',
    exchange: trade.exchange || '',
    shares: trade.shares,
    price: trade.price,
    amount: trade.amount,
    fee: trade.fee,
    trade_date: trade.trade_date,
    note: trade.note || '',
    is_opening: isOpening,
    applied_holding: false,
    created_at: db.serverDate(),
    updated_at: db.serverDate(),
  };
  const addRes = await db.collection('transactions').add({ data });

  if (HOLDING_AFFECTING.indexOf(type) >= 0) {
    // 调 apply_transaction 应用到持仓（幂等）
    try {
      const res = await cloud.callFunction({
        name: 'apply_transaction',
        data: { transaction_id: addRes._id },
      });
      const result = res && res.result;
      if (!result || !result.success) {
        const msg = (result && result.message) || '应用持仓失败';
        warnings.push(`「${trade.product_name || trade.product_code}」已记录但未应用到持仓：${msg}（可在持仓详情页「重建」修复）`);
      }
    } catch (e) {
      warnings.push(`「${trade.product_name || trade.product_code}」已记录但应用到持仓异常：${e.message}（可在持仓详情页「重建」修复）`);
    }
  } else {
    // 转账/手续费类不影响持仓，直接标记已应用
    try {
      await db.collection('transactions').doc(addRes._id).update({
        data: { applied_holding: true, applied_at: db.serverDate() },
      });
    } catch (e) {}
  }
  return addRes._id;
}

exports.main = async (event) => {
  const {
    mode = 'text',
    text = '',
    json,
    account_id,
    provider,
    dry_run = true,
  } = event || {};

  if (!account_id) {
    return { success: false, message: '缺少 account_id（请先选择目标账户）' };
  }

  const warnings = [];
  let trades = [];

  try {
    // ============ 1. 拿到 ParsedTrade[] ============
    if (mode === 'json') {
      // JSON 模式：直接校验外部 LLM 已解析的结果
      let parsed;
      if (typeof json === 'string') {
        try {
          parsed = JSON.parse(json);
        } catch (e) {
          return { success: false, message: 'JSON 解析失败：' + e.message, trades: [], warnings: [] };
        }
      } else {
        parsed = json;
      }
      if (!Array.isArray(parsed)) {
        return { success: false, message: 'JSON 必须是数组', trades: [], warnings: [] };
      }
      trades = parsed.map(t => normalizeTrade(t, warnings)).filter(Boolean);
      // 后处理：补全 product_type/exchange + 自动计算手续费
      trades = await postProcessTrades(trades, account_id, warnings);
    } else {
      // text 模式：调 LLM 解析
      if (!text || !text.trim()) {
        return { success: false, message: '请输入要解析的文字', trades: [], warnings: [] };
      }

      // 读取用户 LLM 配置（按 openid 隔离）
      const wxCtx = cloud.getWXContext();
      const openid = wxCtx.OPENID || '';
      const cfgQuery = openid ? { _openid: openid } : {};
      const { data: configs } = await db.collection('llm_configs').where(cfgQuery).get();
      const userConfig = configs[0];
      if (!userConfig || !userConfig.providers) {
        return { success: false, message: '请先在「我的 → AI 模型设置」中配置 LLM API Key', trades: [], warnings: [] };
      }

      // 选择 provider：优先用户指定，否则取已启用的第一个
      let chosenProvider = provider;
      if (!chosenProvider || !userConfig.providers[chosenProvider] || !userConfig.providers[chosenProvider].enabled) {
        const enabled = Object.keys(userConfig.providers).find(k =>
          userConfig.providers[k] && userConfig.providers[k].enabled && userConfig.providers[k].api_key
        );
        if (!enabled) {
          return { success: false, message: '没有已启用的 LLM 提供商，请先在设置中配置', trades: [], warnings: [] };
        }
        chosenProvider = enabled;
      }

      const providerConfig = userConfig.providers[chosenProvider];
      if (!providerConfig.api_key) {
        return { success: false, message: `${chosenProvider} 未配置 API Key`, trades: [], warnings: [] };
      }

      const apiKey = decrypt(providerConfig.api_key);
      if (!apiKey) {
        return { success: false, message: 'API Key 解密失败，请重新配置', trades: [], warnings: [] };
      }

      const prompt = buildParsePrompt(text);
      const messages = [
        { role: 'system', content: '你是一个金融交易记录解析助手。只输出 JSON 数组，不要任何解释。' },
        { role: 'user', content: prompt },
      ];

      const model = providerConfig.model || PROVIDERS[chosenProvider].defaultModel || '';
      let content;
      if (chosenProvider === 'claude') {
        content = await callClaude(apiKey, messages, model);
      } else {
        content = await callOpenAICompatible(chosenProvider, apiKey, messages, model);
      }

      const parsed = extractJsonArray(content);
      if (!parsed) {
        return {
          success: false,
          message: 'LLM 响应未包含有效 JSON 数组',
          raw: content.substring(0, 500),
          trades: [],
          warnings: [],
        };
      }
      trades = parsed.map(t => normalizeTrade(t, warnings)).filter(Boolean);
      // 后处理：补全 product_type/exchange + 自动计算手续费
      trades = await postProcessTrades(trades, account_id, warnings);
    }

    if (trades.length === 0) {
      return {
        success: true,
        message: '未解析出任何有效交易',
        trades: [],
        warnings,
        imported: 0,
      };
    }

    // ============ 2. dry_run 模式直接返回，不写入 ============
    if (dry_run) {
      return {
        success: true,
        trades,
        warnings,
        imported: 0,
      };
    }

    // ============ 3. 实际写入 ============
    let imported = 0;
    for (let i = 0; i < trades.length; i++) {
      try {
        await importTrade(trades[i], account_id, warnings);
        imported++;
      } catch (err) {
        warnings.push(`第 ${i + 1} 笔写入失败：${err.message}`);
      }
    }

    return {
      success: true,
      trades,
      warnings,
      imported,
      message: `成功导入 ${imported} 笔交易`,
    };
  } catch (err) {
    console.error('[parse_trades_by_text] error:', err);
    return {
      success: false,
      message: err.message || '解析失败',
      trades,
      warnings,
      imported: 0,
    };
  }
};
