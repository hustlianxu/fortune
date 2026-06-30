/**
 * save_notify_settings
 * 保存当前用户的推送通知设置到云数据库 notify_settings 集合（按 _openid 隔离，唯一）。
 *
 * 入参（event 即 data）：
 *   morningNews      Boolean  是否开启早报
 *   eveningNews      Boolean  是否开启晚报
 *   priceAlert       Boolean  是否开启涨跌提醒
 *   alertThreshold   String   涨跌幅阈值（百分比，如 "3"）
 *
 * 返回：{ success: true } 或 { success: false, error }
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    if (!openid) {
      return { success: false, error: '无法获取用户 openid' };
    }

    const data = {
      morningNews: !!event.morningNews,
      eveningNews: !!event.eveningNews,
      priceAlert: !!event.priceAlert,
      alertThreshold: event.alertThreshold != null ? String(event.alertThreshold) : '3',
      updated_at: db.serverDate(),
    };

    // upsert：按 _openid 唯一
    const existRes = await db.collection('notify_settings')
      .where({ _openid: openid })
      .limit(1)
      .get();
    const existing = existRes.data && existRes.data[0];

    if (existing) {
      await db.collection('notify_settings').doc(existing._id).update({ data });
    } else {
      data.created_at = db.serverDate();
      await db.collection('notify_settings').add({ data });
    }

    return { success: true };
  } catch (err) {
    console.error('[save_notify_settings] error:', err);
    return { success: false, error: err.errMsg || err.message };
  }
};
