/**
 * LLM 网关云函数
 * 统一接入多种大模型（DeepSeek、千问、GLM、Kimi、ChatGPT、Claude、阿里百炼）
 *
 * 请求参数:
 *   type: 'portfolio_health' | 'pnl_analysis' | 'rebalance_advice' | 'risk_analysis' | 'qa'
 *   provider: 'deepseek' | 'qwen' | 'glm' | 'kimi' | 'chatgpt' | 'claude' | 'bailian' | 'mimo' | 'minimax' | 'custom'
 *   question: string (仅在 type=qa 时使用)
 *
 * 返回:
 *   success: boolean
 *   report: { summary, key_findings, risk_level, report_content } (非qa类型)
 *   answer: string (qa类型)
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const http = require('./http');

// AES 解密 - 使用云函数环境变量中的密钥
const crypto = require('crypto');
const ALGORITHM = 'aes-256-cbc';
const AES_KEY = process.env.AES_KEY || 'your-default-32-char-aes-key-string!';
const IV_LENGTH = 16;

function decrypt(encrypted) {
  if (!encrypted) return '';
  try {
    // 格式: iv:encrypted (base64)
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

/**
 * LLM 提供商配置（含默认模型，避免落入 'default' 这种无效模型名）
 */
const PROVIDERS = {
  deepseek: { baseURL: 'https://api.deepseek.com', sdkType: 'openai', defaultModel: 'deepseek-chat' },
  qwen:     { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sdkType: 'openai', defaultModel: 'qwen-plus' },
  glm:      { baseURL: 'https://open.bigmodel.cn/api/paas/v4', sdkType: 'openai', defaultModel: 'glm-4' },
  kimi:     { baseURL: 'https://api.moonshot.cn/v1', sdkType: 'openai', defaultModel: 'moonshot-v1-8k' },
  chatgpt:  { baseURL: 'https://api.openai.com/v1', sdkType: 'openai', defaultModel: 'gpt-4o-mini' },
  claude:   { sdkType: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' },
  bailian:  { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sdkType: 'openai', defaultModel: 'qwen-max' },
  mimo:     { baseURL: 'https://api.mi-ai.com/v1', sdkType: 'openai', defaultModel: 'MiMo' },
  minimax:  { baseURL: 'https://api.minimax.chat/v1', sdkType: 'openai', defaultModel: 'MiniMax-Text-01' },
  custom:   { baseURL: '', sdkType: 'openai', defaultModel: '' },
};

/**
 * 构建分析 Prompt
 */
function buildAnalysisPrompt(type, holdingsSummary) {
  const prompts = {
    portfolio_health: `你是一位拥有 CFA 资质的资深投资顾问。请基于以下投资组合数据，提供专业的持仓健康度分析。

=== 用户持仓数据 ===
总市值: ¥${holdingsSummary.totalMarketValue}
总成本: ¥${holdingsSummary.totalCostValue}
总盈亏: ¥${holdingsSummary.totalPnL} (${holdingsSummary.totalPnLPercent}%)

持仓明细:
${holdingsSummary.detail}

行业分布:
${holdingsSummary.sectorDistribution}

=== 分析要求 ===
请从以下维度进行全面分析，每项给出评级 A/B/C/D：
1. 集中度风险：前3大持仓占比、最大单一产品风险
2. 行业分散度：是否过度集中在某几个行业
3. 持仓相关性：是否持有多个同类型产品
4. 费率合理性：管理费水平
5. 风险等级评估（保守/稳健/进取/激进）

请输出:
【摘要】200字以内概要
【关键发现】列表，每项带风险等级 🟢🟡🔴
【改善建议】具体调仓建议
【综合评级】A/B/C/D + 简短理由`,

    pnl_analysis: `你是一位专业的投资分析师。请分析以下投资组合的盈亏情况，找出盈利和亏损的根本原因。

=== 用户持仓数据 ===
总市值: ¥${holdingsSummary.totalMarketValue}
总成本: ¥${holdingsSummary.totalCostValue}
总盈亏: ¥${holdingsSummary.totalPnL} (${holdingsSummary.totalPnLPercent}%)

持仓明细(含盈亏):
${holdingsSummary.detailWithPnL}

=== 分析要求 ===
1. 哪个/哪些产品贡献了最多的收益？原因是什么？
2. 哪个/哪些产品拖累了收益？原因是什么？
3. 整体表现与市场基准对比
4. 改善建议

请输出:
【摘要】200字以内
【收益贡献榜】前3
【亏损拖累榜】前3
【归因分析】整体盈亏原因
【建议】如何改善收益`,

    rebalance_advice: `你是一位专业的投资组合经理。请基于以下持仓给出调仓建议。

=== 用户持仓数据 ===
总市值: ¥${holdingsSummary.totalMarketValue}
总成本: ¥${holdingsSummary.totalCostValue}
总盈亏: ¥${holdingsSummary.totalPnL} (${holdingsSummary.totalPnLPercent}%)

持仓明细:
${holdingsSummary.detail}

行业分布:
${holdingsSummary.sectorDistribution}

=== 分析要求 ===
1. 当前仓位是否合理？
2. 哪些产品应该增持/减持/清仓？
3. 建议的新配置比例
4. 调仓优先级和步骤

请输出:
【当前评估】仓位合理性评价
【调仓建议】具体到每个产品的建议(增持/持有/减持/清仓)
【目标配置】建议的配置比例
【执行步骤】具体的操作优先级`,

    risk_analysis: `你是一位风险管理专家。请评估以下投资组合的风险暴露情况。

=== 用户持仓数据 ===
总市值: ¥${holdingsSummary.totalMarketValue}

持仓明细:
${holdingsSummary.detail}

行业分布:
${holdingsSummary.sectorDistribution}

=== 分析要求 ===
1. 最大风险敞口（持仓最集中的产品/行业）
2. 市场风险（与大盘相关性）
3. 流动性风险
4. 极端行情下的最大回撤预估值
5. 风险缓解建议

请输出:
【风险评级】低/中低/中等/中高/高
【最大风险】敞口分析
【风险矩阵】各类风险评分
【缓解建议】具体措施`,
  };

  return prompts[type] || prompts.portfolio_health;
}

/**
 * 构建 QA Prompt
 */
function buildQAPrompt(holdingsSummary, question) {
  return `你是一位专业的投资顾问助手。用户向您咨询以下问题，请基于提供的持仓数据给出专业回答。

=== 用户持仓数据 ===
总市值: ¥${holdingsSummary.totalMarketValue}
总成本: ¥${holdingsSummary.totalCostValue}
总盈亏: ¥${holdingsSummary.totalPnL} (${holdingsSummary.totalPnLPercent}%)

持仓明细:
${holdingsSummary.detail}

行业分布:
${holdingsSummary.sectorDistribution}

=== 用户问题 ===
${question}

请基于以上持仓数据，给出专业、具体的回答。回答要数据支撑，不要空泛。`;
}

/**
 * 获取持仓摘要数据
 */
async function getHoldingsSummary() {
  const { data: holdings } = await db.collection('holdings').get();

  if (!holdings || holdings.length === 0) {
    return null;
  }

  let totalMarketValue = 0;
  let totalCostValue = 0;
  const sectorMap = {};
  const detailLines = [];
  const detailWithPnLLines = [];

  // 第一遍：累加总额
  holdings.forEach(h => {
    const mv = h.market_value || 0;
    const cv = h.cost_value || h.shares * h.cost_price || 0;
    totalMarketValue += mv;
    totalCostValue += cv;
    const sector = h.sector || '其他';
    sectorMap[sector] = (sectorMap[sector] || 0) + mv;
  });

  // 第二遍：基于完整总额计算占比
  holdings.forEach(h => {
    const mv = h.market_value || 0;
    const cv = h.cost_value || (h.shares * h.cost_price) || 0;
    const pnl = mv - cv;
    const pnlPercent = cv > 0 ? (pnl / cv * 100) : 0;
    const weight = totalMarketValue > 0 ? (mv / totalMarketValue * 100).toFixed(1) : '0.0';

    detailLines.push(`  - ${h.product_name}(${h.product_code}) | 市值: ¥${mv.toFixed(2)} | 占比: ${weight}%`);
    detailWithPnLLines.push(
      `  - ${h.product_name}(${h.product_code}) | 市值: ¥${mv.toFixed(2)} | 成本: ¥${cv.toFixed(2)} | 盈亏: ${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`
    );
  });

  const totalPnL = totalMarketValue - totalCostValue;
  const totalPnLPercent = totalCostValue > 0 ? (totalPnL / totalCostValue * 100) : 0;

  // 行业分布字符串
  const sectorDistribution = Object.entries(sectorMap)
    .sort((a, b) => b[1] - a[1])
    .map(([sector, value]) => `  ${sector}: ${(value / (totalMarketValue || 1) * 100).toFixed(1)}%`)
    .join('\n');

  return {
    totalMarketValue: totalMarketValue.toFixed(2),
    totalCostValue: totalCostValue.toFixed(2),
    totalPnL: totalPnL.toFixed(2),
    totalPnLPercent: totalPnLPercent.toFixed(2),
    detail: detailLines.join('\n'),
    detailWithPnL: detailWithPnLLines.join('\n'),
    sectorDistribution,
  };
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
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

/**
 * 调用 Claude API
 */
async function callClaude(apiKey, messages, model) {
  // 将 messages 从 OpenAI 格式转换为 Claude 格式
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

  if (systemMsg) {
    body.system = systemMsg.content;
  }

  const res = await http.request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

/**
 * 解析分析结果
 */
function parseAnalysisResult(content) {
  const result = {
    summary: '',
    key_findings: [],
    risk_level: '',
    report_content: content,
  };

  // 提取摘要
  const summaryMatch = content.match(/【摘要】([\s\S]*?)(?=【|$)/);
  if (summaryMatch) {
    result.summary = summaryMatch[1].trim();
  }

  // 提取风险等级
  const riskMatch = content.match(/(?:风险等级|风险评级|综合评级)[：:]?\s*(A|B|C|D|保守|稳健|进取|激进|低|中低|中等|中高|高)/);
  if (riskMatch) {
    result.risk_level = riskMatch[1];
  }

  // 提取关键发现 - 支持 🟢🟡🔴
  const findingLines = content.split('\n')
    .filter(line => line.match(/[🟢🟡🔴•·-]\s/) || line.match(/^\d+[.、]/))
    .slice(0, 10);
  result.key_findings = findingLines.map(l => l.replace(/^[🟢🟡🔴]\s*/, '').trim()).filter(Boolean);

  return result;
}

/**
 * 入口函数
 */
exports.main = async (event) => {
  const { type = 'portfolio_health', provider = 'deepseek', question = '' } = event;
  const wxContext = cloud.getWXContext();

  try {
    // 1. 获取用户的 LLM 配置
    const { data: configs } = await db.collection('llm_configs').get();
    const userConfig = configs[0];

    if (!userConfig || !userConfig.providers || !userConfig.providers[provider]) {
      return {
        success: false,
        message: `请先在设置中配置 ${provider} 的 API Key`,
      };
    }

    const providerConfig = userConfig.providers[provider];
    if (!providerConfig.enabled || !providerConfig.api_key) {
      return {
        success: false,
        message: `${provider} 未启用或未配置 API Key`,
      };
    }

    // 2. 解密 API Key
    const apiKey = decrypt(providerConfig.api_key);
    if (!apiKey) {
      return {
        success: false,
        message: 'API Key 解密失败，请重新配置',
      };
    }

    // 3. 获取持仓数据
    const holdingsSummary = await getHoldingsSummary();
    if (!holdingsSummary) {
      return {
        success: false,
        message: '暂无持仓数据，请先添加持仓',
      };
    }

    // 4. 构建 Prompt
    let messages;
    if (type === 'qa') {
      const prompt = buildQAPrompt(holdingsSummary, question);
      messages = [{ role: 'user', content: prompt }];
    } else {
      const prompt = buildAnalysisPrompt(type, holdingsSummary);
      messages = [
        { role: 'system', content: '你是一位专业的投资顾问，回答要专业、具体、以数据为基础。使用中文回复。' },
        { role: 'user', content: prompt },
      ];
    }

    // 5. 调用 LLM
    const model = providerConfig.model || PROVIDERS[provider].defaultModel || '';
    let content;
    if (provider === 'claude') {
      content = await callClaude(apiKey, messages, model);
    } else {
      content = await callOpenAICompatible(provider, apiKey, messages, model);
    }

    // 6. 保存分析报告
    if (type !== 'qa') {
      const parsed = parseAnalysisResult(content);
      await db.collection('analysis_reports').add({
        data: {
          _openid: wxContext.OPENID || '',
          type,
          provider,
          model,
          snapshot_date: new Date().toISOString().split('T')[0],
          summary: parsed.summary,
          report_content: content,
          key_findings: parsed.key_findings,
          risk_level: parsed.risk_level,
          created_at: db.serverDate(),
        },
      });

      return {
        success: true,
        report: parsed,
      };
    }

    // QA 类型直接返回答案
    return {
      success: true,
      answer: content,
    };

  } catch (err) {
    console.error('[llm_gateway] error:', err);
    return {
      success: false,
      message: err.message || 'AI 分析请求失败',
    };
  }
};
