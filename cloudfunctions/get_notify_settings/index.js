/**
 * get_notify_settings
 * 读取当前用户的推送通知设置。
 *
 * 返回：设置对象（无记录或失败时返回空对象 {}），字段：
 *   morningNews, eveningNews, priceAlert, alertThreshold
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    if (!openid) {
      return {};
    }

    const res = await db.collection('notify_settings')
      .where({ _openid: openid })
      .limit(1)
      .get();
    const rec = res.data && res.data[0];
    if (!rec) {
      return {};
    }

    return {
      morningNews: rec.morningNews !== false,
      eveningNews: rec.eveningNews !== false,
      priceAlert: !!rec.priceAlert,
      alertThreshold: rec.alertThreshold || '3',
    };
  } catch (err) {
    console.error('[get_notify_settings] error:', err);
    return {};
  }
};
