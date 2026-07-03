/**
 * 推送通知设置页面
 *
 * 设置同时写入：
 *   - 本地 storage（notify_settings）
 *   - 云数据库 notify_settings 集合（按 openid 隔离，通过 save_notify_settings 云函数 upsert）
 * 读取时以云端为准，云端不可用时回退本地。
 *
 * 订阅消息模板 ID：
 *   用户在微信公众平台「订阅消息」后台申请后，在本页填入对应模板 ID；
 *   保存后写入云端 notify_settings.tmplIds 字段，push_news / check_price_alert 云函数读取后即可推送。
 */
Page({
  data: {
    morningNews: true,
    eveningNews: true,
    priceAlert: false,
    alertThreshold: '3',
    // 订阅消息模板 ID（用户在微信公众平台申请后填入）
    tmplIds: {
      morning: '',
      evening: '',
      price_alert: '',
    },
  },

  onLoad() {
    this.loadSettings();
  },

  loadSettings() {
    // 先读本地，立即回显
    let local = {};
    try {
      const settings = wx.getStorageSync('notify_settings');
      if (settings) local = settings;
    } catch (err) {
      console.error('[Notify] local load error:', err);
    }
    this._applySettings(local);

    // 再尝试云端，以云端为准
    wx.cloud.callFunction({
      name: 'get_notify_settings',
      success: (res) => {
        const cloudSettings = (res && res.result) || {};
        // 云端返回空对象（无记录或云函数失败）则保持本地
        if (cloudSettings && Object.keys(cloudSettings).length > 0) {
          this._applySettings(cloudSettings);
        }
      },
      fail: (err) => {
        // 云函数不存在或调用失败，回退本地
        console.warn('[Notify] get_notify_settings failed, fallback to local:', err);
      },
    });
  },

  _applySettings(settings) {
    if (!settings) return;
    const tmplIds = settings.tmplIds || this.data.tmplIds;
    this.setData({
      morningNews: settings.morningNews !== false,
      eveningNews: settings.eveningNews !== false,
      priceAlert: settings.priceAlert || false,
      alertThreshold: settings.alertThreshold || '3',
      tmplIds: {
        morning: tmplIds.morning || '',
        evening: tmplIds.evening || '',
        price_alert: tmplIds.price_alert || '',
      },
    });
  },

  onToggleMorning() {
    this.setData({ morningNews: !this.data.morningNews });
  },

  onToggleEvening() {
    this.setData({ eveningNews: !this.data.eveningNews });
  },

  onToggleAlert() {
    this.setData({ priceAlert: !this.data.priceAlert });
  },

  onMorningTmplInput(e) {
    this.setData({ 'tmplIds.morning': (e.detail.value || '').trim() });
  },

  onEveningTmplInput(e) {
    this.setData({ 'tmplIds.evening': (e.detail.value || '').trim() });
  },

  onPriceAlertTmplInput(e) {
    this.setData({ 'tmplIds.price_alert': (e.detail.value || '').trim() });
  },

  onSave() {
    const settings = {
      morningNews: this.data.morningNews,
      eveningNews: this.data.eveningNews,
      priceAlert: this.data.priceAlert,
      alertThreshold: this.data.alertThreshold,
      tmplIds: this.data.tmplIds,
    };

    // 1. 本地保存
    try {
      wx.setStorageSync('notify_settings', settings);
    } catch (err) {
      console.error('[Notify] local save error:', err);
    }

    // 2. 收集需订阅的模板 ID（仅开启项 + 已填写真实模板 ID）
    const tmplIds = [];
    if (settings.morningNews && settings.tmplIds.morning) tmplIds.push(settings.tmplIds.morning);
    if (settings.eveningNews && settings.tmplIds.evening) tmplIds.push(settings.tmplIds.evening);
    if (settings.priceAlert && settings.tmplIds.price_alert) tmplIds.push(settings.tmplIds.price_alert);

    // 3. 请求订阅消息权限（仅当存在已填写的真实模板 ID 时）
    //    未填写的项将使用云函数中的默认模板，无需请求订阅授权也能正常推送
    if (tmplIds.length > 0) {
      wx.requestSubscribeMessage({
        tmplIds,
        success(res) {
          console.log('[SubscribeMessage] success:', res);
        },
        fail(err) {
          console.warn('[SubscribeMessage] fail:', err);
        },
      });
    }

    // 4. 同步云端（save_notify_settings 云函数 upsert 到 notify_settings 集合）
    wx.cloud.callFunction({
      name: 'save_notify_settings',
      data: settings,
      success: (res) => {
        console.log('[Notify] cloud save success:', res);
      },
      fail: (err) => {
        console.warn('[Notify] cloud save failed:', err);
      },
    });

    // 5. 提示成功
    wx.showToast({ title: '保存成功', icon: 'success' });
  },
});
