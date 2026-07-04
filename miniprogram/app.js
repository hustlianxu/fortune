/**
 * 个人资产管家 - 微信小程序
 * 统一管理多平台投资资产（股票/ETF/LOF/场外基金）
 */
App({
  onLaunch() {
    // 初始化云开发环境
    // 注意：traceUser 设为 false，避免微信 WACloud 内置「行业任务」定时调用
    // 不存在的云函数导致 [IndustryTask] batch error: FunctionName not found 报错。
    // 用户身份仍可通过 cloud.getWXContext().OPENID 获取，不影响按 openid 隔离数据。
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: 'cloud1-d6geurbo125795334',  // 替换为实际云环境 ID
        traceUser: false
      });
    }

    // 拦截全局未处理 Promise rejection，过滤掉微信框架内部产生的非业务错误
    // （如 WACloud 的 [IndustryTask] / WASubContext 内置任务报错），避免污染用户日志。
    wx.onUnhandledRejection && wx.onUnhandledRejection((res) => {
      const reason = res && (res.reason || '');
      const msg = (typeof reason === 'string' ? reason : (reason && (reason.errMsg || reason.message))) || '';
      if (msg && (msg.indexOf('IndustryTask') >= 0
        || msg.indexOf('WACloud') >= 0
        || msg.indexOf('WASubContext') >= 0
        || msg.indexOf('FunctionName parameter could not be found') >= 0)) {
        // 微信框架内置任务的非业务错误，静默忽略
        return;
      }
      console.warn('[UnhandledRejection]', reason);
    });

    // 获取系统信息（从 3.7.0+ 起推荐 getWindowInfo + getDeviceInfo 替代 getSystemInfo）
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const deviceInfo = wx.getDeviceInfo ? wx.getDeviceInfo() : {};
    this.globalData.systemInfo = {
      ...windowInfo,
      ...deviceInfo,
      // 兼容旧版：wx.getSystemInfoSync 直接返回全部
      SDKVersion: deviceInfo.SDKVersion || windowInfo.SDKVersion || '',
      brand: deviceInfo.brand || '',
      model: deviceInfo.model || '',
      platform: deviceInfo.platform || '',
    };
    this.globalData.statusBarHeight = windowInfo.statusBarHeight || 20;

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
