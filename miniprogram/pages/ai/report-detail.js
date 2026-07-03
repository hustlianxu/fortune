/**
 * AI 分析报告详情页面
 */
const { formatDate } = require('../../utils/format');
const { ANALYSIS_TYPES } = require('../../utils/constants');
const { parseMarkdown } = require('../../utils/markdown');

Page({
  data: {
    report: {},
    contentBlocks: [],     // report_content 解析后的结构化 blocks
    findingBlocks: [],     // key_findings 每项解析后的 blocks
  },

  onLoad(options) {
    if (options.id) {
      this.loadReport(options.id);
    }
  },

  async loadReport(id) {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('analysis_reports').doc(id).get();
      const report = res.data || {};

      // 中文风险等级 → 英文 CSS 类名映射
      const riskMap = {
        '保守': 'conservative', '稳健': 'steady', '进取': 'aggressive', '激进': 'radical',
        '低': 'low', '中低': 'low', '中等': 'medium', '中高': 'high', '高': 'high',
        'A': 'conservative', 'B': 'steady', 'C': 'aggressive', 'D': 'radical',
      };
      report.riskClass = riskMap[report.risk_level] || 'steady';

      // 将 report_content 解析为结构化 blocks（表格/列表/标题/段落），
      // 用原生 view 渲染，表格才能正常显示，且暗黑模式字体颜色自动适配
      const contentBlocks = parseMarkdown(report.report_content || '');
      // key_findings 每条也可能含 markdown，统一解析
      const findingBlocks = (report.key_findings || []).map(f => parseMarkdown(String(f)));

      this.setData({
        report,
        contentBlocks,
        findingBlocks,
      });
    } catch (err) {
      console.error('[Report Detail] error:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  analysisTypeName(typeKey) {
    const found = ANALYSIS_TYPES.find(t => t.key === typeKey);
    return found ? found.name : typeKey || '未知';
  },

  /** 下载（复制到剪贴板） */
  onDownload() {
    const content = this.data.report.report_content || '';
    if (!content) { wx.showToast({ title: '报告内容为空', icon: 'none' }); return; }
    const preview = content.slice(0, 100).replace(/[\n\r]+/g, ' ') + (content.length > 100 ? '...' : '');
    wx.setClipboardData({
      data: content,
      success() {
        wx.showModal({
          title: '研报已复制',
          content: `前 100 字预览：${preview}\n\n内容已复制到剪贴板，可粘贴到笔记软件保存。`,
          showCancel: false, confirmText: '知道了',
        });
      },
      fail() { wx.showToast({ title: '复制失败', icon: 'none' }); },
    });
  },

  formatDate,
});
