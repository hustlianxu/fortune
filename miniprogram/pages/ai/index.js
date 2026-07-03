/**
 * AI 持仓分析页面
 * - 支持多 AI 协作：选中多个分析师独立分析，再由汇总模型综合
 * - 单选时退化为单模型分析（向后兼容）
 */
const api = require('../../utils/api');
const { formatMoney, formatDate, getPriceColor } = require('../../utils/format');
const { ANALYSIS_TYPES, LLM_PROVIDERS } = require('../../utils/constants');
const { parseMarkdown } = require('../../utils/markdown');

// 单次分析最久等待时间（毫秒）。超过即视为超时，提示用户稍后查看，
// 并允许重新进入页面时自动加载最近一次报告（见 onShow 与 onAnalyzeTimeout）。
const ANALYZE_TIMEOUT_MS = 55 * 1000;

Page({
  data: {
    loading: true,
    analyzing: false,
    canAnalyze: false,
    providerConfigured: false,
    configuredProviders: [],   // 已配置且启用的 provider 列表 [{key,name}]
    analysts: [],              // 选中的分析师 provider key 数组
    // 选中态 map（{ providerKey: true }），供 WXML 用 analystSelected[item.key] 判断。
    // 历史根因：WXML 表达式不支持函数调用，analysts.indexOf(item.key) 永远返回 undefined，
    // 改用对象成员访问才能正确驱动 selected class / active 图标 / ✓ 勾选标记。
    analystSelected: {},
    synthIndex: 0,             // 汇总模型 picker 索引
    synthNames: [],            // 汇总模型名称列表（随选中分析师动态更新）
    selectedType: 'portfolio_health',
    analysisTypes: ANALYSIS_TYPES,
    summary: {
      totalAssets: 0,
      totalPnL: 0,
      holdings: [],
      holdingCount: 0,
      accountCount: 0,
    },
    result: {
      show: false,
      summary: '',
      keyFindings: [],
      findingBlocks: [],     // 每条 key_finding 解析后的 markdown blocks
      riskLevel: '',
      content: '',
      contentBlocks: [],     // report_content 解析后的 markdown blocks
      subContentBlocks: [],  // 子报告解析后的 markdown blocks 数组（与 subReports 一一对应）
      date: '',
      multiMode: false,
      subReports: [],
    },
    showSubReports: false,
    // 上一次分析超时但服务端可能仍在生成，重新进入页面时自动展示最新报告
    hasPendingReport: false,
    pendingHint: '',
    historyReports: [],
    qaQuestion: '',
    qaAnswer: '',
    canAsk: false,
    pnlColor: 'price-flat',
  },

  onShow() {
    this.loadData();
    this.loadLLMConfig();
    this.loadHistory();
    // 若上次分析超时（hasPendingReport，内存态），自动尝试加载最新报告
    if (this.data.hasPendingReport) {
      this.tryLoadLatestAfterTimeout();
      return;
    }
    // 即便内存态丢失（用户切出后页面被回收），也检查本地 storage 中的 pending 标记，
    // 让用户重新进来即可看到刚才的解析结果。
    this._checkStoredPending();
  },

  onHide() {
    // 离开页面时停止轮询，避免后台空跑
    this._stopPollLatest();
  },
  onUnload() {
    this._stopPollLatest();
  },

  /** 检查本地 storage 中是否有 pending 标记（跨页面生命周期） */
  _checkStoredPending() {
    try {
      const pending = wx.getStorageSync('ai_pending_report');
      if (!pending || !pending.startedAt) return;
      // 超过 30 分钟视为已过期，不再尝试拉取
      if (Date.now() - pending.startedAt > 30 * 60 * 1000) {
        wx.removeStorageSync('ai_pending_report');
        return;
      }
      this.setData({
        hasPendingReport: true,
        pendingHint: '上次分析仍在生成中，正在为您拉取最新结果…',
      });
      this.tryLoadLatestAfterTimeout();
    } catch (e) {}
  },

  /**
   * 超时后重新进入页面，自动尝试拉取最新一份报告并展示。
   * 若最新报告时间在「分析开始时间」之后，则视为本次超时分析的结果。
   * 同时启动轮询：每 8 秒拉一次，最多 5 次（覆盖 40 秒），让用户切回来也能看到。
   */
  async tryLoadLatestAfterTimeout() {
    const startedAt = (function () {
      try {
        const p = wx.getStorageSync('ai_pending_report');
        return (p && p.startedAt) || (Date.now() - 60 * 1000);
      } catch (e) { return Date.now() - 60 * 1000; }
    })();
    const got = await this._fetchLatestAndFill(startedAt);
    if (got) {
      this._stopPollLatest();
      return;
    }
    // 没拉到 → 启动轮询
    this._startPollLatest(startedAt);
  },

  /** 拉取最新报告，若 created_at > startedAt 则填充并清除 pending 标记，返回 true */
  async _fetchLatestAndFill(startedAt) {
    try {
      const reports = await api.getAnalysisReports();
      if (!reports || reports.length === 0) return false;
      const latest = reports[0];
      const created = latest.created_at ? new Date(latest.created_at) : null;
      if (!created) return false;
      // 最新报告创建时间晚于「分析开始时间」即视为本次结果
      if (created.getTime() >= startedAt) {
        this.fillResultFromReport(latest, { multiMode: false, subReports: [] });
        this.setData({ hasPendingReport: false, pendingHint: '' });
        try { wx.removeStorageSync('ai_pending_report'); } catch (e) {}
        this.loadHistory();
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[AI] _fetchLatestAndFill error:', e);
      return false;
    }
  },

  /** 启动轮询拉取最新报告（最多 5 次，每 8 秒） */
  _startPollLatest(startedAt) {
    this._stopPollLatest();
    let count = 0;
    const MAX = 5;
    this._pollTimer = setInterval(async () => {
      count++;
      const got = await this._fetchLatestAndFill(startedAt);
      if (got || count >= MAX) {
        this._stopPollLatest();
        if (!got && count >= MAX) {
          this.setData({
            pendingHint: '仍在生成中，请稍后下拉刷新或前往「历史分析记录」查看。',
          });
        }
      }
    }, 8000);
  },

  _stopPollLatest() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
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
      // 默认选中第一个已配置模型
      let analysts = this.data.analysts;
      if (analysts.length === 0 && configuredProviders.length > 0) {
        analysts = [configuredProviders[0].key];
      } else if (configuredProviders.length > 0) {
        // 过滤掉已失效的选中项
        analysts = analysts.filter(k => configuredProviders.some(p => p.key === k));
        if (analysts.length === 0) analysts = [configuredProviders[0].key];
      } else {
        analysts = [];
      }
      this.setData({ configuredProviders, providerConfigured, analysts });
      this._syncAnalystSelected();
      this.updateSynthNames();
      this.updateCanAnalyze();
    } catch (err) {
      console.error('[AI] loadLLMConfig error:', err);
    }
  },

  /** 由 analysts 数组派生 analystSelected map，供 WXML 模板用 obj[key] 判断选中态 */
  _syncAnalystSelected() {
    const map = {};
    (this.data.analysts || []).forEach(k => { map[k] = true; });
    this.setData({ analystSelected: map });
  },

  async loadHistory() {
    try {
      const reports = await api.getAnalysisReports();
      this.setData({ historyReports: reports });
    } catch (err) {
      console.error('[AI] loadHistory error:', err);
    }
  },

  updateCanAnalyze() {
    this.setData({
      canAnalyze: this.data.summary.holdings &&
                  this.data.summary.holdings.length > 0 &&
                  this.data.providerConfigured &&
                  this.data.analysts.length > 0,
    });
  },

  /** 切换分析师选中态 */
  onToggleAnalyst(e) {
    const key = e.currentTarget.dataset.key;
    let analysts = this.data.analysts.slice();
    const idx = analysts.indexOf(key);
    if (idx >= 0) {
      // 至少保留 1 个
      if (analysts.length <= 1) {
        wx.showToast({ title: '至少选择 1 个模型', icon: 'none' });
        return;
      }
      analysts.splice(idx, 1);
    } else {
      analysts.push(key);
    }
    this.setData({ analysts });
    this._syncAnalystSelected();
    this.updateSynthNames();
    this.updateCanAnalyze();
  },

  /** 更新汇总模型候选列表（仅含已选中的分析师） */
  updateSynthNames() {
    const selected = this.data.configuredProviders.filter(p => this.data.analysts.indexOf(p.key) >= 0);
    const synthNames = selected.map(p => p.name);
    // 索引越界保护
    let synthIndex = this.data.synthIndex;
    if (synthIndex >= synthNames.length) synthIndex = 0;
    this.setData({ synthNames, synthIndex });
  },

  onSynthChange(e) {
    this.setData({ synthIndex: parseInt(e.detail.value, 10) });
  },

  onTypeSelect(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ selectedType: key });
  },

  async onStartAnalysis() {
    if (!this.data.canAnalyze || this.data.analyzing) return;
    const analysts = this.data.analysts;
    if (analysts.length === 0) {
      wx.showToast({ title: '请至少选择 1 个模型', icon: 'none' });
      return;
    }

    this.setData({ analyzing: true, showSubReports: false });
    const multi = analysts.length > 1;
    wx.showLoading({
      title: multi ? `多模型协作分析中（${analysts.length} 个模型）...` : 'AI 分析中...',
      mask: true,
    });

    // 用 Promise.race 与超时竞争：超过 ANALYZE_TIMEOUT_MS 即视为超时，
    // 但云函数可能仍在生成报告（服务端会写库），标记为 hasPendingReport，
    // 让用户稍后或重新进入页面时通过 tryLoadLatestAfterTimeout 自动看到结果。
    const startedAt = Date.now();
    let analyzePromise;
    try {
      if (multi) {
        const synthKey = this.data.analysts[this.data.synthIndex] || analysts[0];
        analyzePromise = api.analyzePortfolioMulti(this.data.selectedType, analysts, synthKey);
      } else {
        analyzePromise = api.analyzePortfolio(this.data.selectedType, analysts[0]);
      }
      const res = await Promise.race([
        analyzePromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('ANALYZE_TIMEOUT')), ANALYZE_TIMEOUT_MS)
        ),
      ]);

      if (res && res.success) {
        const report = res.report || {};
        this.fillResultFromReport(report, { multiMode: !!res.multiMode, subReports: res.subReports || [] });
        this.setData({ hasPendingReport: false, pendingHint: '' });
        try { wx.removeStorageSync('ai_pending_report'); } catch (e) {}
        this._stopPollLatest();
        wx.hideLoading();
        this.loadHistory();
      } else {
        wx.hideLoading();
        wx.showToast({ title: res?.message || '分析失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      const isTimeout = (err && err.message === 'ANALYZE_TIMEOUT');
      if (isTimeout) {
        // 客户端超时，但服务端可能仍在生成。
        // 将 startedAt 写入本地 storage，让用户重新进入页面（即便页面被回收）也能自动看到最新报告；
        // 同时启动轮询，用户当前页等待 40 秒内也能看到结果。
        try {
          wx.setStorageSync('ai_pending_report', { startedAt, type: this.data.selectedType });
        } catch (e) {}
        this.setData({
          hasPendingReport: true,
          pendingHint: '分析耗时较长，服务端仍在生成中。您可以切出本页稍后回来查看，本页也会每 8 秒自动刷新。',
        });
        wx.showModal({
          title: '分析超时',
          content: 'AI 正在生成报告，但耗时较长。云函数会继续完成并保存。您可以切出本页做其他事，稍后回来将自动展示最新结果；也可在「历史分析记录」中查看。',
          showCancel: false,
          confirmText: '我知道了',
        });
        this.loadHistory();
        // 启动轮询：用户留在本页时也能看到结果
        this._startPollLatest(startedAt);
      } else {
        wx.showToast({ title: '网络错误或 API Key 无效', icon: 'none' });
        console.error('[AI] analysis error:', err);
      }
    }

    this.setData({ analyzing: false });
  },

  /**
   * 把后端 report 填到 result 并解析 markdown 为结构化 blocks（用于原生 view 渲染表格/列表/标题）
   */
  fillResultFromReport(report, extra) {
    const keyFindings = report.key_findings || [];
    const findingBlocks = keyFindings.map(f => parseMarkdown(String(f)));
    const contentBlocks = parseMarkdown(report.report_content || '');
    const subReports = (extra && extra.subReports) || [];
    const subContentBlocks = subReports.map(s => parseMarkdown(String(s.content || '')));
    this.setData({
      result: {
        show: true,
        summary: report.summary || '',
        keyFindings,
        findingBlocks,
        riskLevel: report.risk_level || '',
        content: report.report_content || '',
        contentBlocks,
        subContentBlocks,
        date: formatDate(new Date()),
        multiMode: (extra && extra.multiMode) || false,
        subReports,
      },
    });
  },

  onToggleSubReports() {
    this.setData({ showSubReports: !this.data.showSubReports });
  },

  onViewHistory(e) {
    const report = e.currentTarget.dataset.report;
    wx.navigateTo({
      url: `/pages/ai/report-detail?id=${report._id}`,
    });
  },

  async onAskQuestion() {
    const question = this.data.qaQuestion.trim();
    if (!question) return;
    // QA 模式用第一个选中的模型
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

  onQaInputChange(e) {
    this.setData({ canAsk: (e.detail.value || '').trim().length > 0 });
  },

  onQuickQuestion(e) {
    const q = e.currentTarget.dataset.q;
    this.setData({ qaQuestion: q, canAsk: true }, () => {
      this.onAskQuestion();
    });
  },

  analysisTypeName(typeKey) {
    const found = ANALYSIS_TYPES.find(t => t.key === typeKey);
    return found ? found.name : typeKey;
  },

  formatMoney,
  formatDate,
});
