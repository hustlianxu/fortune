/**
 * 推送通知设置页面
 *
 * 设置同时写入：
 *   - 本地 storage（notify_settings）
 *   - 云数据库 notify_settings 集合（按 openid 隔离，通过 save_notify_settings 云函数 upsert）
 * 读取时以云端为准，云端不可用时回退本地。
 */
// 订阅消息模板 ID（占位符）
// 注意：以下为占位符，需在微信公众平台「订阅消息」后台申请真实模板 ID 后替换。
// 当前为占位值时 wx.requestSubscribeMessage 调用会 fail，属预期行为，不影响本地与云端保存。
const SUBSCRIBE_TMPL_IDS = {
  morning: 'YOUR_MORNING_TMPL_ID',
  evening: 'YOUR_EVENING_TMPL_ID',
  price_alert: 'YOUR_PRICE_ALERT_TMPL_ID',
};

Page({
  data: {
    morningNews: true,
    eveningNews: true,
    priceAlert: false,
    alertThreshold: '3',
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
    this.setData({
      morningNews: settings.morningNews !== false,
      eveningNews: settings.eveningNews !== false,
      priceAlert: settings.priceAlert || false,
      alertThreshold: settings.alertThreshold || '3',
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

  onSave() {
    const settings = {
      morningNews: this.data.morningNews,
      eveningNews: this.data.eveningNews,
      priceAlert: this.data.priceAlert,
      alertThreshold: this.data.alertThreshold,
    };

    // 1. 本地保存
    try {
      wx.setStorageSync('notify_settings', settings);
    } catch (err) {
      console.error('[Notify] local save error:', err);
    }

    // 2. 收集需订阅的模板 ID（仅开启项）
    const tmplIds = [];
    if (settings.morningNews) tmplIds.push(SUBSCRIBE_TMPL_IDS.morning);
    if (settings.eveningNews) tmplIds.push(SUBSCRIBE_TMPL_IDS.evening);
    if (settings.priceAlert) tmplIds.push(SUBSCRIBE_TMPL_IDS.price_alert);

    // 3. 请求订阅消息权限
    //    模板 ID 为占位符时调用必然 fail，属预期行为，仅 warn 不阻塞保存
    if (tmplIds.length > 0) {
      wx.requestSubscribeMessage({
        tmplIds,
        success(res) {
          console.log('[SubscribeMessage] success:', res);
        },
        fail(err) {
          console.warn('[SubscribeMessage] fail (expected if template IDs are placeholders):', err);
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

    // 5. 提示成功，并说明推送生效前提
    wx.showToast({ title: '保存成功', icon: 'success' });
    setTimeout(() => {
      wx.showToast({
        title: '推送需在微信公众平台申请订阅消息模板并替换占位符后生效',
        icon: 'none',
        duration: 3000,
      });
    }, 1500);
  },
});
