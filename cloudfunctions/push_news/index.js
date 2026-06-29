/**
 * 资讯推送云函数
 * 通过微信订阅消息推送财经资讯给当前调用用户
 *
 * 注意：cloud.openapi.subscribeMessage.send 必须传 touser（接收者 openid）
 *      否则会报 "missing touser" 错误。这里从 cloud.getWXContext() 获取当前调用者 openid
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  try {
    // 获取当前调用者的 openid（订阅消息必须指定 touser）
    const wxContext = cloud.getWXContext();
    const touser = wxContext.openid || event.touser;

    if (!touser) {
      return {
        success: false,
        message: '无法获取推送目标用户 openid',
        pushed: 0,
      };
    }

    // 获取最新资讯（取前 5 条最重要的）
    const { data: news } = await db.collection('news_cache')
      .orderBy('importance', 'desc')
      .orderBy('publish_time', 'desc')
      .limit(5)
      .get();

    if (!news || news.length === 0) {
      return { success: true, message: '暂无新资讯', pushed: 0 };
    }

    // 构建推送消息
    const topNews = news[0];
    const title = topNews.title || '资讯更新';
    const summary = (topNews.summary || '').slice(0, 50) || title.slice(0, 50);
    const now = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // 通过云调用发送订阅消息
    try {
      await cloud.openapi.subscribeMessage.send({
        touser,
        templateId: 'your-template-id',  // 需要在微信公众平台申请模板
        // page: 'pages/news/index',       // 点击跳转页面，可选
        data: {
          thing1: { value: title.slice(0, 20) },
          thing2: { value: summary.slice(0, 20) },
          time3: { value: timeStr },
        },
      });
      return {
        success: true,
        message: '推送成功',
        pushed: 1,
        touser,
      };
    } catch (pushErr) {
      console.error('[push_news] subscribeMessage error:', pushErr);
      // 订阅消息未配置 / 模板 ID 未填写 / 用户未订阅，不影响整体功能
      return {
        success: true,
        message: '订阅消息推送被跳过（模板未配置或用户未订阅）',
        pushed: 0,
        error: pushErr.errMsg || pushErr.message,
      };
    }
  } catch (err) {
    console.error('[push_news] error:', err);
    return { success: false, message: err.message, pushed: 0 };
  }
};
