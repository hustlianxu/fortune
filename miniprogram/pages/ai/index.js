/**
 * AI 持仓分析页面
 * - 支持多 AI 协作：选中多个分析师独立分析，再由汇总模型综合
 * - 单选时优先前端直调 LLM（绕过云函数 60s 限制）
 * - 4 个 Tab：持仓健康度 / 盈亏归因分析 / 调仓建议 / 风险暴露评估
 * - 每份研报默认折叠，支持下载
 */
const api = require('../../utils/api');
const { formatMoney, formatDate, getPriceColor } = require('../../utils/format');
const { ANALYSIS_TYPES, LLM_PROVIDERS, CLOUD_FUNCTIONS } = require('../../utils/constants');
const { parseMarkdown } = require('../../utils/markdown');

const ANALYZE_TIMEOUT_MS = 55 * 1000;

Page({
  data: {
    loading: true,
    analyzing: false,
    analyzeProgress: '',
    canAnalyze: false,
    providerConfigured: false,
    configuredProviders: [],
    analysts: [],
    analystSelected: {},
    synthIndex: 0,
    synthNames: [],
    selectedType: 'portfolio_health',
    analysisTypes: ANALYSIS_TYPES,
    summary: {
      totalAssets: 0, totalPnL: 0, holdings: [], holdingCount: 0, accountCount: 0,
    },
    // 当前分析结果
    result: {
      show: false, summary: '', keyFindings: [], findingBlocks: [],
      riskLevel: '', content: '', contentBlocks: [], subContentBlocks: [],
      date: '', multiMode: false, subReports: [],
    },
    showSubReports: false,
    // 超时重试
    hasPendingReport: false,
    pendingHint: '',
    // Tab 研报列表（按 selectedType 筛选）
    tabReports: [],
    tabPage: 0,
    tabPageSize: 10,
    tabHasMore: true,
    tabLoadingMore: false,
    historyExpanded: {},
    historyBlocks: {},
    // 问答
    qaQuestion: '',
    qaAnswer: '',
    canAsk: false,
    pnlColor: 'price-flat',
    // 动态计算字段（通过 _updateTypeDisplay 更新）
    currentTypeName: '',
    currentTypeIcon: '',
    currentTypeDesc: '',
  },

  onShow() {
    this._updateTypeDisplay();
    this.loadData();
    this.loadLLMConfig();
    this.loadTabReports(true);
    if (this.data.hasPendingReport) {
      this.tryLoadLatestAfterTimeout();
    }
    this._checkStoredPending();
  },

  onHide() { this._stopPollLatest(); },
  onUnload() { this._stopPollLatest(); },

  _checkStoredPending() {
    try {
      const pending = wx.getStorageSync('ai_pending_report');
      if (!pending || !pending.startedAt) return;
      if (Date.now() - pending.startedAt > 30 * 60 * 1000) {
        wx.removeStorageSync('ai_pending_report');
        return;
      }
      this.setData({ hasPendingReport: true, pendingHint: '上次分析仍在生成中，正在为您拉取最新结果…' });
      this.tryLoadLatestAfterTimeout();
    } catch (e) {}
  },

  async tryLoadLatestAfterTimeout() {
    const startedAt = (function () {
      try {
        const p = wx.getStorageSync('ai_pending_report');
        return (p && p.startedAt) || (Date.now() - 60 * 1000);
      } catch (e) { return Date.now() - 60 * 1000; }
    })();
    const got = await this._fetchLatestAndFill(startedAt);
    if (got) { this._stopPollLatest(); return; }
    this._startPollLatest(startedAt);
  },

  async _fetchLatestAndFill(startedAt) {
    try {
      const reports = await api.getAnalysisReports(0, 10, this.data.selectedType);
      if (!reports || reports.length === 0) return false;
      const candidate = reports.find(r => !r.failed && r.created_at);
      if (!candidate) return false;
      const created = new Date(candidate.created_at);
      if (isNaN(created.getTime())) return false;
      if (created.getTime() >= startedAt) {
        this.fillResultFromReport(candidate, { multiMode: false, subReports: [] });
        this.setData({ hasPendingReport: false, pendingHint: '' });
        try { wx.removeStorageSync('ai_pending_report'); } catch (e) {}
        this.loadTabReports(true);
        return true;
      }
      return false;
    } catch (e) { return false; }
  },

  _startPollLatest(startedAt) {
    this._stopPollLatest();
    let count = 0;
    this._pollTimer = setInterval(async () => {
      count++;
      const got = await this._fetchLatestAndFill(startedAt);
      if (got || count >= 12) {
        this._stopPollLatest();
        if (!got && count >= 12) {
          this.setData({ pendingHint: '仍在生成中，请稍后下拉刷新或切换 Tab 查看。' });
        }
      }
    }, 8000);
  },

  _stopPollLatest() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  /** 更新当前 Tab 名称、图标与描述 */
  _updateTypeDisplay() {
    const t = ANALYSIS_TYPES.find(a => a.key === this.data.selectedType);
    this.setData({
      currentTypeName: t ? t.name : '',
      currentTypeIcon: t ? t.icon : '📊',
      currentTypeDesc: t ? t.description : '',
    });
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const summary = await api.getPortfolioSummary();
      const accountCount = summary.accounts ? summary.accounts.length : 0;
      this.setData({
        summary: { ...summary, accountCount },
        pnlColor: getPriceColor(summary.totalAllPnL != null ? summary.totalAllPnL : summary.totalPnL),
        loading: false,
      });
      this.updateCanAnalyze();
    } catch (err) {
      console.error('[AI] loadData error:', err);
      this.setData({ loading: false });
    }
  },

  async loadLLMConfig() {
    try {
      const config = await api.getLLMConfig();
      let configuredProviders = [];
      if (config && config.providers) {
        configuredProviders = LLM_PROVIDERS
          .filter(p => config.providers[p.key] && config.providers[p.key].enabled && config.providers[p.key].api_key)
          .map(p => ({ key: p.key, name: p.name }));
      }
      const providerConfigured = configuredProviders.length > 0;
      let analysts = this.data.analysts;
      if (analysts.length === 0 && configuredProviders.length > 0) {
        analysts = [configuredProviders[0].key];
      } else if (configuredProviders.length > 0) {
        analysts = analysts.filter(k => configuredProviders.some(p => p.key === k));
        if (analysts.length === 0) analysts = [configuredProviders[0].key];
      } else { analysts = []; }
      this.setData({ configuredProviders, providerConfigured, analysts });
      this._syncAnalystSelected();
      this.updateSynthNames();
      this.updateCanAnalyze();
    } catch (err) { console.error('[AI] loadLLMConfig error:', err); }
  },

  _syncAnalystSelected() {
    const map = {};
    (this.data.analysts || []).forEach(k => { map[k] = true; });
    this.setData({ analystSelected: map });
  },

  /** 加载当前 Tab 类型的研报列表（按 created_at 倒序，分页） */
  async loadTabReports(reset) {
    try {
      if (this.data.tabLoadingMore) return;
      const isReset = reset !== false;
      const page = isReset ? 0 : this.data.tabPage;
      const pageSize = this.data.tabPageSize;
      this.setData({ tabLoadingMore: true });
      const reports = await api.getAnalysisReports(page * pageSize, pageSize, this.data.selectedType);
      const merged = isReset ? reports : this.data.tabReports.concat(reports);
      const hasMore = reports.length >= pageSize;
      const patch = {
        tabReports: merged,
        tabPage: page,
        tabHasMore: hasMore,
        tabLoadingMore: false,
      };
      if (isReset) { patch.historyExpanded = {}; patch.historyBlocks = {}; }
      this.setData(patch);
    } catch (err) {
      console.error('[AI] loadTabReports error:', err);
      this.setData({ tabLoadingMore: false });
    }
  },

  onLoadMoreTabReports() {
    if (!this.data.tabHasMore || this.data.tabLoadingMore) return;
    const nextPage = this.data.tabPage + 1;
    this.setData({ tabPage: nextPage });
    this.loadTabReports(false);
  },

  /** 切换某条历史研报的展开/折叠态 */
  onToggleHistoryItem(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const expanded = Object.assign({}, this.data.historyExpanded);
    const blocks = Object.assign({}, this.data.historyBlocks);
    if (expanded[id]) {
      delete expanded[id];
    } else {
      expanded[id] = true;
      if (!blocks[id]) {
        const report = this.data.tabReports.find(r => r._id === id);
        if (report) blocks[id] = parseMarkdown(report.report_content || '');
      }
    }
    this.setData({ historyExpanded: expanded, historyBlocks: blocks });
  },

  updateCanAnalyze() {
    this.setData({
      canAnalyze: this.data.summary.holdings && this.data.summary.holdings.length > 0 && this.data.providerConfigured && this.data.analysts.length > 0,
    });
  },

  onToggleAnalyst(e) {
    const key = e.currentTarget.dataset.key;
    let analysts = this.data.analysts.slice();
    const idx = analysts.indexOf(key);
    if (idx >= 0) {
      if (analysts.length <= 1) { wx.showToast({ title: '至少选择 1 个模型', icon: 'none' }); return; }
      analysts.splice(idx, 1);
    } else { analysts.push(key); }
    this.setData({ analysts });
    this._syncAnalystSelected();
    this.updateSynthNames();
    this.updateCanAnalyze();
  },

  updateSynthNames() {
    const selected = this.data.configuredProviders.filter(p => this.data.analysts.indexOf(p.key) >= 0);
    const synthNames = selected.map(p => p.name);
    let synthIndex = this.data.synthIndex;
    if (synthIndex >= synthNames.length) synthIndex = 0;
    this.setData({ synthNames, synthIndex });
  },

  onSynthChange(e) { this.setData({ synthIndex: parseInt(e.detail.value, 10) }); },

  /** Tab 切换 */
  onTabSelect(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.selectedType) return;
    this.setData({
      selectedType: key,
      result: { show: false, summary: '', keyFindings: [], findingBlocks: [],
        riskLevel: '', content: '', contentBlocks: [], subContentBlocks: [],
        date: '', multiMode: false, subReports: [] },
      showSubReports: false,
      hasPendingReport: false,
      pendingHint: '',
    });
    this._updateTypeDisplay();
    this.loadTabReports(true);
  },

  /** ═══════ 开始分析 ═══════ */
  async onStartAnalysis() {
    if (!this.data.canAnalyze || this.data.analyzing) return;
    const analysts = this.data.analysts;
    if (analysts.length === 0) { wx.showToast({ title: '请至少选择 1 个模型', icon: 'none' }); return; }

    this.setData({ analyzing: true, showSubReports: false, analyzeProgress: '准备分析数据...' });
    const multi = analysts.length > 1;

    if (!multi) {
      // ════ 单模型：优先前端直调 LLM（绕过 60s 云函数限制）════
      try {
        await this._directLLMAnalysis(analysts[0]);
        wx.hideLoading();
        this.setData({ analyzing: false });
        return;
      } catch (directErr) {
        console.warn('[AI] direct LLM failed, fallback to cloud function:', directErr);
        // fallback 到云函数
      }
    }

    // ════ 云函数模式（多模型 or 直调失败降级）════
    this.setData({ analyzeProgress: multi ? `多模型协作分析中（${analysts.length} 个模型）...` : 'AI 分析中...' });
    wx.showLoading({ title: multi ? `多模型分析中...` : 'AI 分析中...', mask: true });

    const startedAt = Date.now();
    try {
      let analyzePromise;
      if (multi) {
        const synthKey = this.data.analysts[this.data.synthIndex] || analysts[0];
        analyzePromise = api.analyzePortfolioMulti(this.data.selectedType, analysts, synthKey);
      } else {
        analyzePromise = api.analyzePortfolio(this.data.selectedType, analysts[0]);
      }
      const res = await Promise.race([
        analyzePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('ANALYZE_TIMEOUT')), ANALYZE_TIMEOUT_MS)),
      ]);

      if (res && res.success) {
        const report = res.report || {};
        this.fillResultFromReport(report, { multiMode: !!res.multiMode, subReports: res.subReports || [] });
        this.setData({ hasPendingReport: false, pendingHint: '' });
        try { wx.removeStorageSync('ai_pending_report'); } catch (e) {}
        this._stopPollLatest();
        wx.hideLoading();
        this.loadTabReports(true);
      } else {
        wx.hideLoading();
        wx.showToast({ title: res?.message || '分析失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      const isTimeout = (err && err.message === 'ANALYZE_TIMEOUT');
      const isResultExpired = err && (
        err.errCode === -404010 ||
        (err.errMsg && err.errMsg.indexOf('-404010') >= 0) ||
        (err.message && err.message.indexOf('result expired') >= 0)
      );
      if (isTimeout || isResultExpired) {
        try { wx.setStorageSync('ai_pending_report', { startedAt, type: this.data.selectedType }); } catch (e) {}
        this.setData({
          hasPendingReport: true,
          pendingHint: isResultExpired ? '云函数结果已过期，但服务端可能仍在生成。正在为您轮询最新结果…' : '分析耗时较长，服务端仍在生成中。您可以切出本页稍后回来查看。',
        });
        wx.showModal({
          title: isResultExpired ? '结果拉取超时' : '分析超时',
          content: 'AI 正在生成报告，但耗时较长。云函数会继续完成并保存。您可以切出本页做其他事，稍后回来将自动展示最新结果。',
          showCancel: false, confirmText: '我知道了',
        });
        this.loadTabReports(true);
        this._startPollLatest(startedAt);
      } else {
        wx.showToast({ title: '网络错误或 API Key 无效', icon: 'none' });
        console.error('[AI] analysis error:', err);
      }
    }
    this.setData({ analyzing: false });
  },

  /**
   * 前端直接调用 LLM API（单模型模式，绕过云函数 60s 限制）
   * 流程：
   *   1. 调用 llm_gateway(return_prompt_only=true) → 获取 prompt + API Key
   *   2. 前端直接调用 LLM API（wx.request，无超时限制）
   *   3. 解析结果 → 保存到 analysis_reports（通过 save_ai_report 云函数）
   *   4. 展示结果
   */
  async _directLLMAnalysis(provider) {
    const { selectedType } = this.data;
    this.setData({ analyzeProgress: '获取分析数据...' });

    // 1. 获取 prompt + API Key
    const prep = await api.prepareAnalysis(selectedType, provider);
    if (!prep || !prep.success || !prep.return_prompt_only) {
      throw new Error('prepareAnalysis failed: ' + (prep?.message || 'unknown'));
    }

    const { prompt, apiKey, baseURL, model } = prep;
    if (!apiKey) throw new Error('API Key 为空');
    if (provider === 'claude' && !baseURL) {
      // Claude 特殊处理：调用 Anthropic API
      this.setData({ analyzeProgress: '调用 Claude API（无超时限制）...' });
      const claudeBody = {
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: '你是一位专业的投资顾问，回答要专业、具体、以数据为基础。使用中文回复。',
        messages: [{ role: 'user', content: prompt }],
      };
      const claudeRes = await new Promise((resolve, reject) => {
        wx.request({
          url: 'https://api.anthropic.com/v1/messages',
          method: 'POST',
          header: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          data: claudeBody,
          timeout: 120000, // 120s 超时
          success: resolve,
          fail: reject,
        });
      });
      if (claudeRes.statusCode !== 200) {
        throw new Error(`Claude API error ${claudeRes.statusCode}: ${JSON.stringify(claudeRes.data)}`);
      }
      const responseContent = (claudeRes.data.content && claudeRes.data.content[0] && claudeRes.data.content[0].text) || '';
      await this._saveAndShowResult(responseContent, provider, model);
      return;
    }

    // OpenAI 兼容接口
    const effectiveBaseURL = baseURL || 'https://api.deepseek.com';
    const effectiveModel = model || 'deepseek-chat';
    const url = effectiveBaseURL.replace(/\/+$/, '') + '/chat/completions';

    this.setData({ analyzeProgress: `调用 ${provider} API（无 60s 限制）...` });

    const llmRes = await new Promise((resolve, reject) => {
      wx.request({
        url,
        method: 'POST',
        header: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        data: {
          model: effectiveModel,
          messages: [
            { role: 'system', content: '你是一位专业的投资顾问，回答要专业、具体、以数据为基础。使用中文回复。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 4096,
        },
        timeout: 120000, // 120s 超时，远超云函数的 60s
        success: resolve,
        fail: reject,
      });
    });

    if (llmRes.statusCode !== 200) {
      throw new Error(`LLM API error ${llmRes.statusCode}: ${JSON.stringify(llmRes.data)}`);
    }
    const content = (llmRes.data.choices && llmRes.data.choices[0] && llmRes.data.choices[0].message && llmRes.data.choices[0].message.content) || '';
    if (!content) throw new Error('LLM 返回内容为空');

    await this._saveAndShowResult(content, provider, effectiveModel);
  },

  /** 保存 & 展示 LLM 返回的分析结果 */
  async _saveAndShowResult(content, provider, model) {
    this.setData({ analyzeProgress: '正在保存分析报告...' });
    const parsed = this._parseAnalysisResult(content);
    const { selectedType } = this.data;

    // 保存到云数据库
    try {
      await api.saveAIReport({
        type: selectedType,
        provider,
        model: model || '',
        summary: parsed.summary,
        report_content: content,
        key_findings: parsed.key_findings,
        risk_level: parsed.risk_level,
      });
    } catch (saveErr) {
      console.warn('[AI] save report error:', saveErr);
      // 保存失败不影响展示
    }

    this.fillResultFromReport(parsed, { multiMode: false, subReports: [] });
    this.loadTabReports(true);
    wx.showToast({ title: '分析完成', icon: 'success' });
  },

  /** 本地解析 LLM 分析结果（与 llm_gateway 中的 parseAnalysisResult 同步） */
  _parseAnalysisResult(content) {
    const result = {
      summary: '', key_findings: [], risk_level: '', report_content: content,
    };
    const summaryMatch = content.match(/【摘要】([\s\S]*?)(?=【|$)/);
    if (summaryMatch) result.summary = summaryMatch[1].trim();
    const riskMatch = content.match(/(?:风险等级|风险评级|综合评级)[：:]?\s*(A|B|C|D|保守|稳健|进取|激进|低|中低|中等|中高|高)/);
    if (riskMatch) result.risk_level = riskMatch[1];
    const findingLines = content.split('\n').filter(line => line.match(/[🟢🟡🔴•·-]\s/) || line.match(/^\d+[.、]/)).slice(0, 10);
    result.key_findings = findingLines.map(l => l.replace(/^[🟢🟡🔴]\s*/, '').trim()).filter(Boolean);
    return result;
  },

  fillResultFromReport(report, extra) {
    const keyFindings = report.key_findings || [];
    const findingBlocks = keyFindings.map(f => parseMarkdown(String(f)));
    const contentBlocks = parseMarkdown(report.report_content || '');
    const subReports = (extra && extra.subReports) || [];
    const subContentBlocks = subReports.map(s => parseMarkdown(String(s.content || '')));
    this.setData({
      result: {
        show: true,
        summary: report.summary || '', keyFindings, findingBlocks,
        riskLevel: report.risk_level || '', content: report.report_content || '', contentBlocks,
        subContentBlocks, date: formatDate(new Date()),
        multiMode: (extra && extra.multiMode) || false, subReports,
      },
    });
  },

  onToggleSubReports() { this.setData({ showSubReports: !this.data.showSubReports }); },

  /** ═══════ 下载当前分析结果 ═══════ */
  onDownloadCurrentReport() {
    const { result, selectedType } = this.data;
    if (!result.content) { wx.showToast({ title: '无报告可下载', icon: 'none' }); return; }
    this._downloadReportContent(result.content, this._typeName(selectedType) + '_' + result.date);
  },

  /** 下载历史研报 */
  onDownloadHistoryReport(e) {
    const id = e.currentTarget.dataset.id;
    const report = this.data.tabReports.find(r => r._id === id);
    if (!report || !report.report_content) { wx.showToast({ title: '报告内容为空', icon: 'none' }); return; }
    this._downloadReportContent(report.report_content, this._typeName(report.type) + '_' + (report.snapshot_date || report.created_at || ''));
  },

  /** 通用下载：复制到剪贴板 + 弹窗提示 */
  _downloadReportContent(content, filename) {
    // 截取前 100 字符作为预览
    const preview = content.slice(0, 100).replace(/[\n\r]+/g, ' ') + (content.length > 100 ? '...' : '');
    wx.setClipboardData({
      data: content,
      success() {
        wx.showModal({
          title: '研报已复制',
          content: `「${filename}」\n\n前 100 字预览：${preview}\n\n内容已复制到剪贴板，可粘贴到备忘录或笔记软件保存。`,
          showCancel: false,
          confirmText: '知道了',
        });
      },
      fail() {
        wx.showToast({ title: '复制失败', icon: 'none' });
      },
    });
  },

  _typeName(key) {
    const t = ANALYSIS_TYPES.find(a => a.key === key);
    return t ? t.name : key;
  },

  // ═══════ 智能问答 ═══════
  async onAskQuestion() {
    const question = this.data.qaQuestion.trim();
    if (!question) return;
    const provider = this.data.analysts[0] || 'deepseek';

    this.setData({ qaAnswer: '' });
    wx.showLoading({ title: '思考中...', mask: true });

    try {
      const res = await api.askAI(question, provider);
      wx.hideLoading();
      if (res && res.success) {
        this.setData({ qaAnswer: res.answer || '暂无回答' });
      } else {
        wx.showToast({ title: res?.message || '回答失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
    }
  },

  onQaInputChange(e) { this.setData({ canAsk: (e.detail.value || '').trim().length > 0 }); },
  onQuickQuestion(e) {
    const q = e.currentTarget.dataset.q;
    this.setData({ qaQuestion: q, canAsk: true }, () => { this.onAskQuestion(); });
  },

  formatMoney, formatDate,
});
