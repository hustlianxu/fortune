/**
 * 我的 - 设置页面
 */
const api = require('../../utils/api');
const { LLM_PROVIDERS } = require('../../utils/constants');

Page({
  data: {
    llmProviders: [],
    userInfo: null,
    tempAvatarUrl: '',
    tempNickName: '',
  },

  onShow() {
    this.loadUserInfo();
    this.loadProviderStatus();
  },

  /** 从全局/本地读取已登录用户信息 */
  loadUserInfo() {
    const app = getApp();
    let info = app.globalData.userInfo;
    if (!info) {
      try {
        info = wx.getStorageSync('userInfo') || null;
        if (info) app.globalData.userInfo = info;
      } catch (e) {}
    }
    this.setData({ userInfo: info });
  },

  /** 选择头像回调（微信基础库 2.21.2+ chooseAvatar） */
  onChooseAvatar(e) {
    this.setData({ tempAvatarUrl: e.detail.avatarUrl || '' });
  },

  onNicknameInput(e) {
    this.setData({ tempNickName: e.detail.value || '' });
  },

  /** 登录：保存头像+昵称到本地与全局 */
  onLogin() {
    const avatarUrl = this.data.tempAvatarUrl;
    const nickName = (this.data.tempNickName || '').trim();
    if (!avatarUrl) {
      wx.showToast({ title: '请先选择头像', icon: 'none' });
      return;
    }
    if (!nickName) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    const userInfo = { avatarUrl, nickName };
    try {
      wx.setStorageSync('userInfo', userInfo);
    } catch (e) {}
    const app = getApp();
    app.globalData.userInfo = userInfo;
    this.setData({ userInfo, tempAvatarUrl: '', tempNickName: '' });
    wx.showToast({ title: '登录成功', icon: 'success' });
  },

  /** 退出登录 */
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后本地保存的用户信息将被清除，您的云端数据仍保留。是否继续？',
      success: (r) => {
        if (!r.confirm) return;
        try {
          wx.removeStorageSync('userInfo');
        } catch (e) {}
        const app = getApp();
        app.globalData.userInfo = null;
        this.setData({ userInfo: null });
        wx.showToast({ title: '已退出', icon: 'none' });
      },
    });
  },

  async loadProviderStatus() {
    try {
      const config = await api.getLLMConfig();
      const providers = LLM_PROVIDERS.map(p => ({
        ...p,
        configured: config?.providers?.[p.key]?.enabled && config?.providers?.[p.key]?.api_key,
      }));
      this.setData({ llmProviders: providers });
    } catch (err) {
      this.setData({
        llmProviders: LLM_PROVIDERS.map(p => ({ ...p, configured: false })),
      });
    }
  },

  onGoToAccounts() {
    wx.navigateTo({ url: '/pages/holdings/index' });
  },

  onGoToTransactions() {
    wx.navigateTo({ url: '/pages/transactions/index' });
  },

  onGoToImport() {
    wx.navigateTo({ url: '/pages/import/index' });
  },

  onGoToVoiceImport() {
    wx.navigateTo({ url: '/pages/import/voice' });
  },

  onRebuildHoldings() {
    wx.showModal({
      title: '重建持仓',
      content: '将根据全部交易流水重新计算持仓份额与成本（幂等，可重复执行）。是否继续？',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '重建中...' });
        try {
          const r = await wx.cloud.callFunction({ name: 'rebuild_holdings' });
          const result = r.result || {};
          wx.hideLoading();
          if (result.success) {
            wx.showModal({
              title: '重建完成',
              content: result.message || '已完成',
              showCancel: false,
            });
          } else {
            wx.showToast({ title: result.message || '重建失败', icon: 'none' });
          }
        } catch (err) {
          console.error('[Rebuild] error:', err);
          wx.hideLoading();
          wx.showToast({ title: '重建失败', icon: 'none' });
        }
      },
    });
  },

  onGoToExport() {
    this.exportData();
  },

  async exportData() {
    wx.showLoading({ title: '导出中...' });
    try {
      const result = await api.callCloudFunction('export_data');
      if (result && result.success) {
        // 保存到本地
        const fs = wx.getFileSystemManager();
        const filePath = `${wx.env.USER_DATA_PATH}/asset_backup_${Date.now()}.json`;
        fs.writeFileSync(filePath, JSON.stringify(result.data, null, 2));
        wx.hideLoading();
        wx.showModal({
          title: '导出成功',
          content: '数据已保存到本地文件',
          success() {
            wx.openDocument({
              filePath,
              fileType: 'json',
              showMenu: true,
            });
          },
        });
      } else {
        wx.hideLoading();
        wx.showToast({ title: '导出失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '导出失败', icon: 'none' });
    }
  },

  onConfigureLLM(e) {
    const provider = e.currentTarget.dataset.provider;
    wx.navigateTo({ url: `/pages/settings/llm/index?provider=${provider}` });
  },

  onGoToLLMSettings() {
    wx.navigateTo({ url: '/pages/settings/llm/index' });
  },

  onGoToNotifySettings() {
    wx.navigateTo({ url: '/pages/settings/notify/index' });
  },

  onShowPrivacy() {
    wx.showModal({
      title: '隐私说明',
      content: '您的金融数据仅存储在微信云数据库中，采用加密传输和存储。AI 分析时调用的 API Key 经过 AES-256 加密存储，仅在云函数内存中解密。您的持仓数据不会用于任何其他目的，也不会分享给第三方。',
      showCancel: false,
    });
  },
});
