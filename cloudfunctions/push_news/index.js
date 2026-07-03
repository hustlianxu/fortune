/**
 * 资讯推送云函数 push_news
 *
 * 定时触发：早报 0 8 * * *（TriggerName=morningNews），晚报 0 17 * * *（TriggerName=eveningNews）。
 * 也支持手动调用：event.pushType = 'morning' | 'evening'。
 *
 * 逻辑：
 *   1. 据 TriggerName / pushType 判定早报或晚报，选择对应模板与开关字段。
 *   2. 从 notify_settings 集合读取所有开启该项推送的用户（按 _openid 隔离，云函数具备 admin 权限可读全部）。
 *   3. 模板 ID 优先取自用户在 notify_settings 中填写的 tmplIds 字段；
 *      若该用户未填写则跳过该用户并在 errors 中清晰标记原因，避免静默失败。
 *   4. 取 news_cache 最新资讯，逐用户通过 cloud.openapi.subscribeMessage.send 推送。
 *   5. 单条发送失败不吞错误，记录到 errors；若全部失败则返回 success:false。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_BATCH = 1000; // 单次 get 上限

// 占位符（仅用于判断用户是否填了真实模板 ID，不再用于实际推送）
const PLACEHOLDER_HINT = 'YOUR_';

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

exports.main = async (event) => {
  try {
    // 1. 判定推送类型：定时触发器通过 TriggerName 区分；手动调用通过 pushType 区分
    let pushType = event.pushType;
    if (!pushType && event.TriggerName === 'morningNews') pushType = 'morning';
    if (!pushType && event.TriggerName === 'eveningNews') pushType = 'evening';
    if (!pushType) pushType = 'morning'; // 默认早报

    const enabledField = pushType === 'evening' ? 'eveningNews' : 'morningNews';
    const tmplField = pushType === 'evening' ? 'evening' : 'morning';

    // 2. 读取所有开启该项推送的用户设置（按 _openid 隔离）
    const settingsRes = await db.collection('notify_settings')
      .where({ [enabledField]: true })
      .limit(MAX_BATCH)
      .get();
    const targets = settingsRes.data || [];

    if (targets.length === 0) {
      return { success: true, message: '无开启该推送的用户', pushed: 0, pushType };
    }

    // 3. 取最新资讯
    const { data: news } = await db.collection('news_cache')
      .orderBy('importance', 'desc')
      .orderBy('publish_time', 'desc')
      .limit(5)
      .get();

    if (!news || news.length === 0) {
      return { success: true, message: '暂无新资讯', pushed: 0, pushType };
    }

    const topNews = news[0];
    const title = topNews.title || '资讯更新';
    const summary = (topNews.summary || '').slice(0, 50) || title.slice(0, 50);
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // 4. 逐用户推送（模板 ID 优先从用户配置读取）
    let pushed = 0;
    let skippedNoTmpl = 0;
    const errors = [];
    for (const setting of targets) {
      const touser = setting._openid;
      if (!touser) continue;

      // 模板 ID 解析：优先用户配置 tmplIds.{tmplField}，缺失则跳过
      const userTmplIds = setting.tmplIds || {};
      const templateId = (userTmplIds[tmplField] || '').trim();
      if (!templateId || templateId.indexOf(PLACEHOLDER_HINT) === 0) {
        skippedNoTmpl++;
        errors.push({
          touser,
          error: '未配置订阅消息模板 ID（请在「我-推送设置」中填入）',
        });
        continue;
      }

      try {
        await cloud.openapi.subscribeMessage.send({
          touser,
          templateId,
          // page: 'pages/news/index', // 点击跳转页面，可选
          data: {
            thing1: { value: title.slice(0, 20) },
            thing2: { value: summary.slice(0, 20) },
            time3: { value: timeStr },
          },
        });
        pushed++;
      } catch (pushErr) {
        // 不吞错误：记录到 errors，最终随返回结果暴露给前端/日志
        console.error('[push_news] subscribeMessage error:', touser, pushErr);
        errors.push({
          touser,
          error: pushErr.errMsg || pushErr.message,
        });
      }
    }

    // 全部失败：返回失败，暴露首个错误原因
    if (pushed === 0 && errors.length > 0) {
      return {
        success: false,
        pushed: 0,
        pushType,
        error: errors[0].error,
        errors,
        skippedNoTmpl,
      };
    }

    return {
      success: true,
      pushed,
      pushType,
      total: targets.length,
      skippedNoTmpl,
      errors,
    };
  } catch (err) {
    console.error('[push_news] error:', err);
    return { success: false, pushed: 0, error: err.errMsg || err.message };
  }
};
