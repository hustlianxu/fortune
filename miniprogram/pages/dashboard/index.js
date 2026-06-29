/**
 * 资产看板页面
 */
const api = require('../../utils/api');
const { formatDate, getPriceColor, getPriceArrow } = require('../../utils/format');

Page({
  data: {
    loading: true,
    summary: {
      totalAssets: 0,
      totalPnL: 0,
      totalPnLPercent: 0,
      todayPnL: 0,
      holdingCount: 0,
      accountCount: 0,
      accounts: [],
    },
    distributionList: [],
    lastUpdate: '',
    pnlColor: 'price-flat',
    pnlArrow: '→',
    todayPnlColor: 'price-flat',
    // 总盈亏百分比显示文本
    pnlPercentText: '0.00%',
  },

  onLoad() {
    // 注册全局刷新
    const app = getApp();
    app.onRefresh(() => {
      this.loadData();
    });
  },

  onReady() {
    // Canvas 2D 需要在 ready 后才能拿到节点
    this.drawPie();
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const summary = await api.getPortfolioSummary();
      this.setData({
        summary,
        pnlColor: getPriceColor(summary.totalPnL),
        pnlArrow: getPriceArrow(summary.totalPnL),
        todayPnlColor: getPriceColor(summary.todayPnL),
        pnlPercentText: (summary.totalPnLPercent || 0).toFixed(2) + '%',
        lastUpdate: wx.getStorageSync('last_price_update') || '',
        distributionList: this.buildDistribution(summary),
        loading: false,
      });

      // 更新全局数据
      const app = getApp();
      app.globalData.totalAssets = summary.totalAssets;
      app.globalData.totalPnL = summary.totalPnL;

      // 数据就绪后绘制饼图
      this.drawPie();

      // 检查是否需要自动更新行情
      if (wx.getStorageSync('need_price_update')) {
        this.autoRefreshPrices();
      }
    } catch (err) {
      console.error('[Dashboard] loadData error:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  /**
   * 构建饼图分布数据
   */
  buildDistribution(summary) {
    if (!summary.accounts || summary.accounts.length === 0) return [];
    const colors = ['#6c63ff', '#1890ff', '#52c41a', '#fa8c16', '#13c2c2', '#eb2f96', '#722ed1', '#a0d911'];
    const total = summary.totalAssets || 1;
    return summary.accounts.map((acc, i) => ({
      name: acc.name,
      value: acc.total_value || 0,
      percent: (((acc.total_value || 0) / total) * 100).toFixed(1),
      color: colors[i % colors.length],
    }));
  },

  /**
   * 绘制资产分布饼图（Canvas 2D）
   */
  drawPie() {
    const list = this.data.distributionList;
    if (!list || list.length === 0) return;
    const query = wx.createSelectorQuery();
    query.select('#pieCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getSystemInfoSync().pixelRatio || 1;
      const width = res[0].width || 150;
      const height = res[0].height || 150;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);

      const total = list.reduce((s, i) => s + (parseFloat(i.value) || 0), 0);
      if (total <= 0) return;

      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) / 2 - 4;

      let startAngle = -Math.PI / 2;
      list.forEach((item) => {
        const value = parseFloat(item.value) || 0;
        if (value <= 0) return;
        const angle = (value / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, radius, startAngle, startAngle + angle);
        ctx.closePath();
        ctx.fillStyle = item.color;
        ctx.fill();
        startAngle += angle;
      });

      // 中心空心
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    });
  },

  /**
   * 自动刷新行情
   */
  async autoRefreshPrices() {
    try {
      wx.showLoading({ title: '更新行情中...' });
      const result = await api.refreshPrices();
      if (result && result.success) {
        this.markUpdated();
        wx.hideLoading();
        // 重新加载数据
        this.loadData();
      } else {
        wx.hideLoading();
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[autoRefreshPrices] error:', err);
    }
  },

  /**
   * 手动刷新
   */
  async onRefresh() {
    wx.showLoading({ title: '刷新中...' });
    try {
      const result = await api.refreshPrices();
      if (result && result.success) {
        this.markUpdated();
        wx.showToast({ title: '刷新成功', icon: 'success' });
      } else {
        wx.showToast({ title: (result && result.message) || '刷新失败', icon: 'none' });
      }
      this.loadData();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
    }
  },

  /**
   * 记录已刷新行情的时间戳
   * 统一使用 toDateString 格式，与 app.checkDailyUpdate 对齐
   */
  markUpdated() {
    const now = new Date();
    wx.setStorageSync('last_price_update', formatDate(now, 'MM-DD HH:mm'));
    wx.setStorageSync('last_price_update_day', now.toDateString());
    wx.setStorageSync('need_price_update', false);
  },

  /**
   * 点击账户
   */
  onAccountTap(e) {
    const account = e.currentTarget.dataset.account;
    wx.navigateTo({
      url: `/pages/account/detail?id=${account._id}`,
    });
  },

  /**
   * 添加账户
   */
  onAddAccount() {
    wx.navigateTo({ url: '/pages/account/edit' });
  },

  /**
   * 跳转 AI 分析
   */
  onGoToAI() {
    wx.switchTab({ url: '/pages/ai/index' });
  },

  /**
   * 跳转导入
   */
  onGoToImport() {
    wx.navigateTo({ url: '/pages/import/index' });
  },

  /**
   * 手动添加持仓
   */
  onAddHolding() {
    wx.navigateTo({ url: '/pages/holding/edit' });
  },
});
