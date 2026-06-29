/**
 * 持仓详情页面
 * - 展示持仓盈亏/份额/成本
 * - 「记一笔买卖」入口：跳转交易编辑页并预填，记账后自动反算持仓
 * - 展示该持仓的最近交易
 */
const { formatMoney, formatDate, formatQuantity, formatPercent, getPriceColor } = require('../../utils/format');
const { PRODUCT_TYPES } = require('../../utils/constants');

const db = wx.cloud.database();

Page({
  data: {
    holding: {},
    holdingId: '',
    priceColor: 'price-flat',
    recentTransactions: [],
    loadingTxns: false,
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ holdingId: options.id });
    }
  },

  onShow() {
    // 每次显示都刷新（从交易编辑页返回时能反映最新持仓与流水）
    if (this.data.holdingId) {
      this.loadHolding(this.data.holdingId);
      this.loadRecentTransactions();
    }
  },

  async loadHolding(id) {
    try {
      const res = await db.collection('holdings').doc(id).get();
      const holding = res.data || {};
      this.setData({
        holding,
        priceColor: getPriceColor(holding.pnl),
      });
    } catch (err) {
      console.error('[Holding Detail] load error:', err);
    }
  },

  /**
   * 拉取该持仓的最近交易（按 account_id + product_code）
   */
  async loadRecentTransactions() {
    const { holding } = this.data;
    if (!holding.account_id || !holding.product_code) return;
    this.setData({ loadingTxns: true });
    try {
      const res = await db.collection('transactions')
        .where({
          account_id: holding.account_id,
          product_code: holding.product_code,
        })
        .orderBy('trade_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(10)
        .get();
      this.setData({
        recentTransactions: res.data || [],
        loadingTxns: false,
      });
    } catch (err) {
      console.error('[Holding Detail] load txns error:', err);
      this.setData({ loadingTxns: false });
    }
  },

  /**
   * 记一笔买卖：跳转交易编辑页，预填账户/产品/名称
   */
  onRecordTrade() {
    const h = this.data.holding;
    const params = [
      `account_id=${encodeURIComponent(h.account_id || '')}`,
      `product_code=${encodeURIComponent(h.product_code || '')}`,
      `product_name=${encodeURIComponent(h.product_name || '')}`,
      `product_type=${encodeURIComponent(h.product_type || '')}`,
      `exchange=${encodeURIComponent(h.exchange || '')}`,
      `from=holding`,
    ].join('&');
    wx.navigateTo({
      url: `/pages/transactions/edit?${params}`,
    });
  },

  onEdit() {
    wx.navigateTo({
      url: `/pages/holding/edit?id=${this.data.holding._id}`,
    });
  },

  onDelete() {
    wx.showModal({
      title: '确认删除',
      content: `删除 ${this.data.holding.product_name} 的持仓记录？`,
      success: async (res) => {
        if (res.confirm) {
          try {
            await db.collection('holdings').doc(this.data.holding._id).remove();
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 1000);
          } catch (err) {
            wx.showToast({ title: '删除失败', icon: 'none' });
          }
        }
      },
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

  formatMoney, formatDate, formatQuantity, formatPercent,
});
