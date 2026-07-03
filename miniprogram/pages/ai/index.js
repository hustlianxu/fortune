/**
 * AI 持仓分析页面
 * - 支持多 AI 协作：选中多个分析师独立分析，再由汇总模型综合
 * - 单选时退化为单模型分析（向后兼容）
 */
const api = require('../../utils/api');
const { formatMoney, formatDate, getPriceColor } = require('../../utils/format');
const { ANALYSIS_TYPES, LLM_PROVIDERS } = require('../../utils/constants');

Page({
  data: {
    loading: true,
    analyzing: false,
    canAnalyze: false,
    providerConfigured: false,
    configuredProviders: [],   // 已配置且启用的 provider 列表 [{key,name}]
    analysts: [],              // 选中的分析师 provider key 数组
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
      riskLevel: '',
      content: '',
      date: '',
      multiMode: false,
      subReports: [],
    },
    showSubReports: false,
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
      this.updateSynthNames();
      this.updateCanAnalyze();
    } catch (err) {
      console.error('[AI] loadLLMConfig error:', err);
    }
  },

  async loadHistory() {
    try {
      const reports = await api.getAnalysisReports();
      this.setData({ historyReports: reports });
      // 进入页面时若结果区为空，自动展示最近一份报告（含生成时间）
      if (reports.length > 0 && !this.data.result.show) {
        const latest = reports[0];
        this.setData({
          result: {
            show: true,
            summary: latest.summary || '',
            keyFindings: latest.key_findings || [],
            riskLevel: latest.risk_level || '',
            content: latest.report_content || '',
            date: formatDate(new Date(latest.created_at)),
            multiMode: false,
            subReports: [],
          },
        });
      }
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

    try {
      let res;
      if (multi) {
        // 汇总模型 = 当前 picker 选中的
        const synthKey = this.data.analysts[this.data.synthIndex] || analysts[0];
        res = await api.analyzePortfolioMulti(this.data.selectedType, analysts, synthKey);
      } else {
        res = await api.analyzePortfolio(this.data.selectedType, analysts[0]);
      }

      if (res && res.success) {
        const report = res.report || {};
        this.setData({
          result: {
            show: true,
            summary: report.summary || '',
            keyFindings: report.key_findings || [],
            riskLevel: report.risk_level || '',
            content: report.report_content || '',
            date: formatDate(new Date()),
            multiMode: !!res.multiMode,
            subReports: res.subReports || [],
          },
        });
        wx.hideLoading();
        this.loadHistory();
      } else {
        wx.hideLoading();
        wx.showToast({ title: res?.message || '分析失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络错误或 API Key 无效', icon: 'none' });
      console.error('[AI] analysis error:', err);
    }

    this.setData({ analyzing: false });
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
