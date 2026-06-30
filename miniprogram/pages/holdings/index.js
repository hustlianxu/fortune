/**
 * 持仓列表页面
 */
const api = require('../../utils/api');
const { formatMoney, formatQuantity } = require('../../utils/format');
const { PRODUCT_TYPES } = require('../../utils/constants');

Page({
  data: {
    accountList: [],
    strategyList: [],         // 策略汇总 [{ name, holdingCount, marketValue, costValue, pnl, pnlPercent }]
    allSummary: {             // 「全部」策略卡的汇总数据（避免硬编码 0 导致显示错位）
      marketValue: 0,
      pnl: 0,
      pnlPercent: 0,
      holdingCount: 0,
    },
    selectedStrategy: '',     // 当前筛选的策略名，''=全部
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    try {
      const summary = await api.getPortfolioSummary();
      const accounts = (summary.accounts || []).map(acc => ({
        ...acc,
        expanded: true,
        visible: true,
        displayHoldings: acc.holdings,
      }));
      this.setData({
        accountList: accounts,
        strategyList: summary.strategySummaries || [],
        allSummary: {
          marketValue: summary.totalMarketValue || 0,
          pnl: summary.totalAllPnL || summary.totalPnL || 0,   // 优先总收益口径
          pnlPercent: summary.totalAllPnLPercent || summary.totalPnLPercent || 0,
          holdingCount: summary.holdingCount || 0,
        },
      });
    } catch (err) {
      console.error('[Holdings] load error:', err);
    }
  },

  /**
   * 根据 selectedStrategy 重新计算每个 account 的 visible 和 displayHoldings
   */
  applyFilter() {
    const { accountList, selectedStrategy } = this.data;
    this.setData({
      accountList: accountList.map(acc => {
        if (!selectedStrategy) {
          return { ...acc, visible: true, displayHoldings: acc.holdings };
        }
        const filtered = (acc.holdings || []).filter(h =>
          (h.strategy || '').trim() === selectedStrategy
        );
        return {
          ...acc,
          visible: filtered.length > 0,
          displayHoldings: filtered,
        };
      }),
    });
  },

  /** 切换策略筛选 */
  onStrategyFilter(e) {
    const name = e.currentTarget.dataset.name || '';
    const next = name === this.data.selectedStrategy ? '' : name;
    this.setData({ selectedStrategy: next }, () => {
      this.applyFilter();
    });
  },

  onToggleAccount(e) {
    const id = e.currentTarget.dataset.id;
    const list = this.data.accountList.map(a => {
      if (a._id === id) return { ...a, expanded: !a.expanded };
      return a;
    });
    this.setData({ accountList: list });
  },

  onHoldingTap(e) {
    const holding = e.currentTarget.dataset.holding;
    wx.navigateTo({
      url: `/pages/holding/detail?id=${holding._id}`,
    });
  },

  tagClass(type) {
    const t = PRODUCT_TYPES[type?.toUpperCase()];
    return t?.tag || 'tag-stock';
  },

  productTypeName(type) {
    const t = PRODUCT_TYPES[type?.toUpperCase()];
    return t?.name || type || '股票';
  },

  formatMoney,
  formatQuantity,
});
