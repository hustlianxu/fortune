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
 * 获取持仓摘要数据（按 openid 隔离）
 */
async function getHoldingsSummary(openid) {
  let holdings;
  if (openid) {
    const res = await db.collection('holdings').where({ _openid: openid }).get();
    holdings = res.data;
  } else {
    const res = await db.collection('holdings').get();
    holdings = res.data;
  }

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
    timeout: 45000,
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
    timeout: 45000,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

/**
 * 统一 LLM 调用入口（自动分发 OpenAI 兼容 / Claude）
 */
async function callLLM(provider, apiKey, messages, model) {
  if (provider === 'claude') {
    return callClaude(apiKey, messages, model);
  }
  return callOpenAICompatible(provider, apiKey, messages, model);
}

/**
 * 带重试的 LLM 调用（指数退避，默认重试 2 次）
 */
async function callLLMWithRetry(provider, apiKey, messages, model, retries) {
  const max = typeof retries === 'number' ? retries : 2;
  let lastErr;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await callLLM(provider, apiKey, messages, model);
    } catch (err) {
      lastErr = err;
      if (attempt < max) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * 构建汇总 Prompt：将多位分析师的独立报告交给指定模型汇总
 */
function buildSynthesisPrompt(type, subReports) {
  const sections = subReports.map((r, i) =>
    `=== 分析师 ${i + 1}（${r.provider}）的独立报告 ===\n${r.content || '（无输出）'}`
  ).join('\n\n');

  return `你是一位首席投资顾问。以下是多位 AI 分析师对同一投资组合的独立分析报告。请综合所有报告，去重并融合观点，输出一份最终的综合分析报告。

${sections}

=== 汇总要求 ===
1. 找出多位分析师达成共识的观点，作为【共识观点】
2. 标出分析师之间存在分歧的地方，作为【分歧观点】
3. 综合所有报告给出最终评级和建议

请输出：
【综合摘要】200字以内
【共识观点】多位分析师一致认同的发现（列表）
【分歧观点】分析师之间存在分歧的地方（如有）
【关键发现】融合后的关键发现（列表）
【综合建议】最终调仓/改善建议
【综合评级】A/B/C/D + 简短理由`;
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
  const {
    type = 'portfolio_health',
    provider = 'deepseek',
    question = '',
    analysts,           // 多 AI 协作：分析师 provider 数组（可选）
    synthesizer,        // 多 AI 协作：汇总 provider（可选，默认取 analysts[0]）
  } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';

  try {
    // 1. 获取用户的 LLM 配置（按 openid 隔离）
    const cfgQuery = openid ? { _openid: openid } : {};
    const { data: configs } = await db.collection('llm_configs').where(cfgQuery).get();
    const userConfig = configs[0];
    if (!userConfig || !userConfig.providers) {
      return { success: false, message: '请先在设置中配置 LLM API Key' };
    }

    // 2. 获取持仓数据（按 openid 隔离）
    const holdingsSummary = await getHoldingsSummary(openid);
    if (!holdingsSummary) {
      return { success: false, message: '暂无持仓数据，请先添加持仓' };
    }

    // 3. 判断模式：多 AI 协作 or 单 AI
    const isMultiMode = Array.isArray(analysts) && analysts.filter(Boolean).length > 0;

    if (isMultiMode) {
      // ============ 多 AI 协作模式 ============
      const analystList = analysts.filter(Boolean);
      // 校验所有分析师均已配置
      const invalid = analystList.find(p => !userConfig.providers[p] || !userConfig.providers[p].enabled || !userConfig.providers[p].api_key);
      if (invalid) {
        return { success: false, message: `${invalid} 未配置或未启用，请先在设置中配置` };
      }
      const synthProvider = synthesizer || analystList[0];
      if (!userConfig.providers[synthProvider] || !userConfig.providers[synthProvider].enabled || !userConfig.providers[synthProvider].api_key) {
        return { success: false, message: `汇总模型 ${synthProvider} 未配置或未启用` };
      }

      // 构建分析 Prompt（QA 不支持多模型协作，强制走分析类）
      const analysisType = type === 'qa' ? 'portfolio_health' : type;
      const prompt = buildAnalysisPrompt(analysisType, holdingsSummary);
      const messages = [
        { role: 'system', content: '你是一位专业的投资顾问，回答要专业、具体、以数据为基础。使用中文回复。' },
        { role: 'user', content: prompt },
      ];

      // 并行调用各分析师模型（不同 provider 并发安全；单次失败不影响其他，带重试）
      const subReports = await Promise.all(analystList.map(async (ap) => {
        const cfg = userConfig.providers[ap];
        const apiKey = decrypt(cfg.api_key);
        if (!apiKey) {
          return { provider: ap, content: '', error: 'API Key 解密失败' };
        }
        const model = cfg.model || PROVIDERS[ap].defaultModel || '';
        try {
          const content = await callLLMWithRetry(ap, apiKey, messages, model);
          return { provider: ap, content, model };
        } catch (err) {
          return { provider: ap, content: '', error: err.message };
        }
      }));

      // 仅一个分析师 或 汇总模型与唯一分析师相同 → 直接返回该报告（无需汇总）
      let finalContent;
      let usedSynth = false;
      if (analystList.length === 1) {
        finalContent = subReports[0].content;
      } else {
        // 多分析师 → 调汇总模型
        const synthCfg = userConfig.providers[synthProvider];
        const synthApiKey = decrypt(synthCfg.api_key);
        if (!synthApiKey) {
          return { success: false, message: '汇总模型 API Key 解密失败' };
        }
        const synthModel = synthCfg.model || PROVIDERS[synthProvider].defaultModel || '';
        const synthPrompt = buildSynthesisPrompt(analysisType, subReports);
        const synthMessages = [
          { role: 'system', content: '你是一位首席投资顾问，擅长综合多方观点给出最终结论。使用中文回复。' },
          { role: 'user', content: synthPrompt },
        ];
        finalContent = await callLLMWithRetry(synthProvider, synthApiKey, synthMessages, synthModel);
        usedSynth = true;
      }

      // 解析并保存报告
      const parsed = parseAnalysisResult(finalContent);
      await db.collection('analysis_reports').add({
        data: {
          _openid: openid,
          type: analysisType,
          provider: synthProvider,
          model: usedSynth ? (userConfig.providers[synthProvider].model || PROVIDERS[synthProvider].defaultModel || '') : (subReports[0].model || ''),
          analysts: analystList,
          synthesizer: usedSynth ? synthProvider : '',
          snapshot_date: new Date().toISOString().split('T')[0],
          summary: parsed.summary,
          report_content: finalContent,
          key_findings: parsed.key_findings,
          risk_level: parsed.risk_level,
          created_at: db.serverDate(),
        },
      });

      return {
        success: true,
        report: parsed,
        subReports,          // 各分析师原始报告（供前端折叠展示）
        multiMode: true,
      };
    }

    // ============ 单 AI 模式（保持原逻辑） ============
    if (!userConfig.providers[provider]) {
      return { success: false, message: `请先在设置中配置 ${provider} 的 API Key` };
    }
    const providerConfig = userConfig.providers[provider];
    if (!providerConfig.enabled || !providerConfig.api_key) {
      return { success: false, message: `${provider} 未启用或未配置 API Key` };
    }
    const apiKey = decrypt(providerConfig.api_key);
    if (!apiKey) {
      return { success: false, message: 'API Key 解密失败，请重新配置' };
    }

    // 构建 Prompt
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

    // 调用 LLM
    const model = providerConfig.model || PROVIDERS[provider].defaultModel || '';
    const content = await callLLMWithRetry(provider, apiKey, messages, model);

    // 保存分析报告
    if (type !== 'qa') {
      const parsed = parseAnalysisResult(content);
      await db.collection('analysis_reports').add({
        data: {
          _openid: openid,
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

      return { success: true, report: parsed };
    }

    // QA 类型直接返回答案
    return { success: true, answer: content };

  } catch (err) {
    console.error('[llm_gateway] error:', err);
    return {
      success: false,
      message: err.message || 'AI 分析请求失败',
    };
  }
};
