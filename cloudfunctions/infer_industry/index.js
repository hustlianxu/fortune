/**
 * 行业分类推断云函数
 * 根据持仓的 product_code + product_name + product_type，调用 LLM 批量推断所属行业，
 * 写回 holdings.industry 字段（供多维度分析「行业」维度使用）。
 *
 * 请求参数:
 *   holding_ids?: string[]   指定持仓 ID 列表（优先）；为空则处理当前用户全部持仓
 *   only_missing?: boolean   仅推断 industry 为空的持仓（默认 true）
 *   force?: boolean          强制重新推断（忽略 only_missing 与 industry_auto_refresh 开关）
 *   provider?: string        指定 LLM 提供商（默认取用户已配置且启用的第一个）
 *
 * 返回:
 *   success, processed, updated, skipped, failed, results: [{id, code, name, industry}]
 *
 * 说明：
 * - 每笔持仓可通过 industry_auto_refresh=false 退出批量刷新（force=true 时忽略）
 * - LLM 单次最多处理 BATCH_SIZE 个产品，避免 prompt 过长
 * - 用户可在持仓编辑页手动修改 industry，本函数 only_missing=true 时不覆盖手填值
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

// LLM 提供商配置（与 llm_gateway 保持一致）
const PROVIDERS = {
  deepseek: { baseURL: 'https://api.deepseek.com', sdkType: 'openai', defaultModel: 'deepseek-chat' },
  qwen:     { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sdkType: 'openai', defaultModel: 'qwen-plus' },
  glm:      { baseURL: 'https://open.bigmodel.cn/api/paas/v4', sdkType: 'openai', defaultModel: 'glm-4' },
  kimi:     { baseURL: 'https://api.moonshot.cn/v1', sdkType: 'openai', defaultModel: 'moonshot-v1-8k' },
  chatgpt:  { baseURL: 'https://api.openai.com/v1', sdkType: 'openai', defaultModel: 'gpt-4o-mini' },
  claude:   { sdkType: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' },
  bailian:  { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sdkType: 'openai', defaultModel: 'qwen-max' },
  mimo:     { baseURL: 'https://api.xiaomimimo.com/v1', sdkType: 'openai', defaultModel: 'mimo-v2.5-pro' },
  minimax:  { baseURL: 'https://api.minimax.chat/v1', sdkType: 'openai', defaultModel: 'MiniMax-Text-01' },
  custom:   { baseURL: '', sdkType: 'openai', defaultModel: '' },
};

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
      temperature: 0.1,
      max_tokens: 2048,
    }),
    timeout: 50000,
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API error ${res.status}: ${errorText}`);
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

async function callClaude(apiKey, messages, model) {
  const systemMsg = messages.find(m => m.role === 'system');
  const userMsgs = messages.filter(m => m.role !== 'system');
  const effectiveModel = model || PROVIDERS.claude.defaultModel;
  const body = {
    model: effectiveModel,
    max_tokens: 2048,
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
    timeout: 50000,
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errorText}`);
  }
  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

async function callLLM(provider, apiKey, messages, model) {
  if (provider === 'claude') return callClaude(apiKey, messages, model);
  return callOpenAICompatible(provider, apiKey, messages, model);
}

// 标准行业分类（申万一级简化 + 常见主题），LLM 必须从中选最接近的一个
const STANDARD_INDUSTRIES = [
  '银行', '证券', '保险', '房地产', '基建',
  '食品饮料', '家用电器', '商贸零售', '纺织服装', '社会服务', '轻工制造',
  '医药生物', '半导体', '电子', '计算机', '传媒', '通信', '互联网',
  '汽车', '新能源', '电力设备', '机械设备', '国防军工',
  '化工', '钢铁', '有色金属', '建筑材料', '建筑装饰', '交通运输',
  '公用事业', '农林牧渔', '煤炭', '石油石化', '环保', '综合',
];

// 单批最多推断的产品数（控制 prompt 长度，保证 LLM 输出稳定）
const BATCH_SIZE = 8;

/**
 * 构造批量推断行业的 prompt
 */
function buildPrompt(items) {
  const list = items.map((it, i) =>
    `${i + 1}. 代码:${it.product_code} 名称:${it.product_name} 类型:${it.product_type || '未知'}`
  ).join('\n');

  return `你是一位资深的 A 股/基金行业分析专家。请根据以下产品的代码、名称和类型，判断每个产品所属的行业分类。

=== 待分类产品 ===
${list}

=== 标准行业列表（必须从中选择最接近的一个）===
${STANDARD_INDUSTRIES.join('、')}

=== 规则 ===
1. 股票按公司主营业务归类（如 600036 招商银行→银行，300750 宁德时代→新能源）。
2. ETF/LOF/基金按其跟踪指数或投资主题归类（如 512480 半导体ETF→半导体，510050 50ETF→综合）。
3. 宽基指数 ETF（如沪深300、中证500、上证50）归类为「综合」。
4. 跨行业或多主题的归入占比最大的行业；实在无法判断归「综合」。
5. 只能从标准行业列表中选词，不要自创。

=== 输出格式（严格 JSON，不要 markdown 代码块，不要解释）===
{"results":[{"code":"600036","industry":"银行"},{"code":"510050","industry":"综合"}]}`;
}

/**
 * 从 LLM 输出中解析行业映射
 */
function parseIndustryResponse(content, items) {
  const map = {};
  // 兼容裸 JSON 与被 ```json 包裹的输出
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // 提取第一个 { ... } 块
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }
  try {
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.results)) {
      obj.results.forEach(r => {
        if (r && r.code && r.industry) {
          map[String(r.code)] = String(r.industry).trim();
        }
      });
    }
  } catch (e) {
    console.error('[parseIndustryResponse] JSON parse failed:', e.message, '| raw:', text.slice(0, 200));
  }
  return map;
}

/**
 * 分页拉取持仓
 */
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
  const {
    holding_ids = null,
    only_missing = true,
    force = false,
    provider = '',
  } = event || {};
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';

  try {
    // 1. 获取用户 LLM 配置
    const cfgQuery = openid ? { _openid: openid } : {};
    const { data: configs } = await db.collection('llm_configs').where(cfgQuery).get();
    const userConfig = configs[0];
    if (!userConfig || !userConfig.providers) {
      return { success: false, message: '请先在设置中配置 LLM API Key' };
    }

    // 选择 provider：显式指定 > 用户已配置且启用的第一个
    let useProvider = provider;
    if (!useProvider) {
      const enabled = Object.keys(userConfig.providers).find(p => {
        const c = userConfig.providers[p];
        return c && c.enabled && c.api_key;
      });
      if (!enabled) {
        return { success: false, message: '没有已启用的 LLM 模型，请先在设置中配置' };
      }
      useProvider = enabled;
    }
    const provCfg = userConfig.providers[useProvider];
    if (!provCfg || !provCfg.enabled || !provCfg.api_key) {
      return { success: false, message: `${useProvider} 未配置或未启用` };
    }
    const apiKey = decrypt(provCfg.api_key);
    if (!apiKey) {
      return { success: false, message: `${useProvider} API Key 解密失败` };
    }
    const model = provCfg.model || (PROVIDERS[useProvider] && PROVIDERS[useProvider].defaultModel) || '';

    // 2. 拉取持仓
    let holdings = await fetchAllHoldings(openid);
    if (holding_ids && Array.isArray(holding_ids) && holding_ids.length > 0) {
      const idSet = new Set(holding_ids);
      holdings = holdings.filter(h => idSet.has(h._id));
    }

    // 3. 过滤
    let targets = holdings.filter(h => h.product_code);
    if (!force) {
      // respect industry_auto_refresh 开关（默认 true）
      targets = targets.filter(h => h.industry_auto_refresh !== false);
      if (only_missing) {
        // 仅推断 industry 为空的（不覆盖用户手填值）
        targets = targets.filter(h => !h.industry || String(h.industry).trim() === '');
      }
    }

    if (targets.length === 0) {
      return {
        success: true,
        message: '没有需要推断行业的持仓',
        processed: 0, updated: 0, skipped: 0, failed: 0, results: [],
      };
    }

    // 4. 分批调用 LLM
    const results = [];
    let updated = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const prompt = buildPrompt(batch);
      const messages = [
        { role: 'system', content: '你是一个严谨的数据标注助手，只输出 JSON，不要任何解释或 markdown 标记。' },
        { role: 'user', content: prompt },
      ];
      let industryMap = {};
      try {
        const content = await callLLM(useProvider, apiKey, messages, model);
        industryMap = parseIndustryResponse(content, batch);
      } catch (err) {
        console.error('[infer_industry] LLM call failed for batch:', err.message);
        failed += batch.length;
        continue;
      }

      // 5. 写回 holdings
      for (const h of batch) {
        const ind = industryMap[h.product_code];
        if (ind && STANDARD_INDUSTRIES.includes(ind)) {
          try {
            await db.collection('holdings').doc(h._id).update({
              data: {
                industry: ind,
                industry_source: 'llm',
                industry_updated_at: db.serverDate(),
              },
            });
            results.push({ id: h._id, code: h.product_code, name: h.product_name, industry: ind });
            updated++;
          } catch (e) {
            console.error('[infer_industry] write back failed:', h._id, e.message);
            failed++;
          }
        } else {
          failed++;
        }
      }
    }

    return {
      success: true,
      message: `推断完成：${updated}/${targets.length} 个持仓已分类`,
      processed: targets.length,
      updated,
      skipped: holdings.length - targets.length,
      failed,
      provider: useProvider,
      results,
    };
  } catch (err) {
    console.error('[infer_industry] error:', err);
    return { success: false, message: err.message };
  }
};
