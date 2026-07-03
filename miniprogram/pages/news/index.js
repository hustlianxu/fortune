/**
 * 财经资讯页面
 */
const api = require('../../utils/api');
const { formatDate } = require('../../utils/format');
const { NEWS_CATEGORIES } = require('../../utils/constants');

Page({
  data: {
    loading: false,
    todayDate: '',
    categories: NEWS_CATEGORIES,
    currentCategory: 'all',
    newsList: [],
  },

  onLoad() {
    this.setData({
      todayDate: formatDate(new Date(), 'YYYY年MM月DD日'),
    });
  },

  onShow() {
    this.loadNews();
  },

  async loadNews() {
    this.setData({ loading: true });
    try {
      const news = await api.getNews(this.data.currentCategory);
      this.setData({
        newsList: news,
        loading: false,
      });
    } catch (err) {
      console.error('[News] loadNews error:', err);
      this.setData({ loading: false });
    }
  },

  onCategoryChange(e) {
    const category = e.currentTarget.dataset.key;
    this.setData({ currentCategory: category }, () => {
      this.loadNews();
    });
  },

  categoryName(key) {
    const found = NEWS_CATEGORIES.find(c => c.key === key);
    return found ? found.name : key;
  },

  formatTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    return formatDate(d, 'MM-DD');
  },

  onNewsTap(e) {
    const url = e.currentTarget.dataset.url;
    if (url) {
      // 使用小程序内置浏览器打开
      wx.setClipboardData({
        data: url,
        success() {
          wx.showToast({ title: '链接已复制，可到浏览器中打开', icon: 'none' });
        },
      });
    }
  },

  async onManualFetch() {
    wx.showLoading({ title: '获取中...' });
    try {
      const result = await api.callCloudFunction('fetch_news');
      wx.hideLoading();
      if (result && result.success) {
        wx.showToast({ title: `获取到 ${result.count || 0} 条资讯`, icon: 'success' });
        this.loadNews();
      } else {
        // 获取失败时，显示缓存数据 + Toast 提示（不弹模态框遮挡）
        const msg = (result && result.message) ? result.message : '获取失败';
        wx.showToast({ title: '获取失败：' + msg.slice(0, 20), icon: 'none', duration: 3000 });
        // 尝试加载已有缓存
        await this.loadNews();
        if (this.data.newsList.length === 0) {
          wx.showModal({
            title: '获取失败',
            content: msg + '\n\n目前也无缓存资讯，请稍后再试。',
            showCancel: false,
          });
        }
      }
    } catch (err) {
      wx.hideLoading();
      const errMsg = err && err.errMsg ? err.errMsg : '网络错误';
      wx.showToast({ title: '获取超时' + (errMsg.length > 8 ? '' : '：' + errMsg), icon: 'none', duration: 2000 });
      // 超时也尝试加载已有缓存
      await this.loadNews();
      if (this.data.newsList.length === 0) {
        wx.showModal({
          title: '获取失败',
          content: errMsg + '\n\n目前也无缓存资讯，请稍后再试。',
          showCancel: false,
        });
      }
    }
  },
});
