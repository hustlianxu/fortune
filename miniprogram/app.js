/**
 * 个人资产管家 - 微信小程序
 * 统一管理多平台投资资产（股票/ETF/LOF/场外基金）
 */
App({
  onLaunch() {
    // 初始化云开发环境
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: 'cloud1-d6geurbo125795334',  // 替换为实际云环境 ID
        traceUser: true
      });
    }

    // 获取系统信息
    const systemInfo = wx.getSystemInfoSync();
    this.globalData.systemInfo = systemInfo;
    this.globalData.statusBarHeight = systemInfo.statusBarHeight;

    // 检查是否有缓存的行情数据
    this.checkDailyUpdate();

    // 恢复已登录用户信息（仅用于展示，云端数据通过 OPENID 隔离）
    try {
      const userInfo = wx.getStorageSync('userInfo');
      if (userInfo) this.globalData.userInfo = userInfo;
    } catch (e) {}
  },

  globalData: {
    // 系统信息
    systemInfo: null,
    statusBarHeight: 20,

    // 全局状态
    accounts: [],         // 账户列表缓存
    holdings: [],         // 持仓列表缓存
    totalAssets: 0,       // 总资产
    totalPnL: 0,          // 总盈亏
    totalPnLPercent: 0,   // 总盈亏百分比

    // 刷新回调
    refreshCallbacks: [],

    // 默认模型配置
    defaultLLMProvider: 'deepseek',

    // 当前登录用户信息 { avatarUrl, nickName }（由"我的"页登录写入）
    // 云函数通过 cloud.getWXContext().OPENID 隔离数据，前端 userInfo 仅用于展示
    userInfo: null,
  },

  /**
   * 注册数据刷新回调
   */
  onRefresh(callback) {
    this.globalData.refreshCallbacks.push(callback);
  },

  /**
   * 触发全局刷新
   */
  triggerRefresh() {
    this.globalData.refreshCallbacks.forEach(cb => {
      typeof cb === 'function' && cb();
    });
  },

  /**
   * 检查每日更新
   * last_price_update_day 使用 toDateString 格式存储，便于跨日比对
   */
  checkDailyUpdate() {
    const lastUpdateDay = wx.getStorageSync('last_price_update_day');
    const today = new Date().toDateString();
    if (lastUpdateDay !== today) {
      // 标记需要更新，进入首页时自动刷新
      wx.setStorageSync('need_price_update', true);
    }
  }
});
