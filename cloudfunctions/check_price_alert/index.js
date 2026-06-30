/**
 * check_price_alert
 * 涨跌提醒：遍历所有 holdings，按 _openid 分组，查对应 notify_settings，
 * 若 priceAlert=true 且持仓涨跌幅绝对值超过 alertThreshold，则通过订阅消息推送。
 *
 * 定时触发：交易日（周一至周五）14:50 收盘前 —— `50 14 * * 1-5`
 *
 * 涨跌幅计算：
 *   - 优先使用 holdings.daily_change（百分比）
 *   - 否则用 current_price 与 prev_close 计算
 *
 * 注意：模板 ID 为占位符，需在微信公众平台申请真实订阅消息模板后替换；
 *      替换后请保证 data 中的字段名（thing1/amount2/time3）与申请到的模板一致。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 涨跌提醒订阅消息模板 ID（占位符，需替换）
const PRICE_ALERT_TMPL_ID = 'YOUR_PRICE_ALERT_TMPL_ID';

const MAX_BATCH = 1000; // 单次 get 上限

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

exports.main = async () => {
  try {
    // 1. 取全部 holdings（云函数 admin 权限可读全部）
    const holdingsRes = await db.collection('holdings').limit(MAX_BATCH).get();
    const holdings = holdingsRes.data || [];

    if (holdings.length === 0) {
      return { success: true, message: '无持仓', alerted: 0 };
    }

    // 2. 按 _openid 分组
    const groups = {};
    holdings.forEach((h) => {
      const oid = h._openid;
      if (!oid) return;
      if (!groups[oid]) groups[oid] = [];
      groups[oid].push(h);
    });

    const openids = Object.keys(groups);
    if (openids.length === 0) {
      return { success: true, message: '无持仓用户', alerted: 0 };
    }

    // 3. 一次性查询这些用户的 notify_settings
    const _ = db.command;
    const settingsRes = await db.collection('notify_settings')
      .where({ _openid: _.in(openids) })
      .limit(MAX_BATCH)
      .get();
    const settingsMap = {};
    (settingsRes.data || []).forEach((s) => {
      settingsMap[s._openid] = s;
    });

    let alerted = 0;
    const alerts = [];
    const errors = [];

    // 4. 逐用户判断阈值并推送
    for (const oid of openids) {
      const s = settingsMap[oid];
      if (!s || !s.priceAlert) continue; // 未开启涨跌提醒，跳过

      const parsed = parseFloat(s.alertThreshold);
      const threshold = isNaN(parsed) ? 3 : Math.abs(parsed);

      const userHoldings = groups[oid];
      for (const h of userHoldings) {
        if (h.is_cleared) continue;

        const currentPrice = Number(h.current_price) || 0;
        if (currentPrice <= 0) continue;

        // 涨跌幅：优先 daily_change，否则用 prev_close 计算
        let changePct = Number(h.daily_change);
        if (changePct == null || isNaN(changePct)) {
          const prevClose = Number(h.prev_close) || 0;
          if (prevClose > 0) {
            changePct = ((currentPrice - prevClose) / prevClose) * 100;
          } else {
            continue; // 无法计算涨跌幅，跳过
          }
        }

        if (Math.abs(changePct) < threshold) continue;

        const direction = changePct > 0 ? '上涨' : '下跌';
        const productName = (h.product_name || h.product_code || '持仓').slice(0, 20);
        const changeText = `${direction}${Math.abs(changePct).toFixed(2)}%`;

        try {
          await cloud.openapi.subscribeMessage.send({
            touser: oid,
            templateId: PRICE_ALERT_TMPL_ID,
            page: 'pages/index/index',
            data: {
              thing1: { value: productName },
              amount2: { value: changeText },
              time3: { value: nowStr() },
            },
          });
          alerted++;
          alerts.push({ openid: oid, product: h.product_code, change: Number(changePct.toFixed(2)) });
        } catch (pushErr) {
          // 不吞错误：记录到 errors
          console.error('[check_price_alert] push error:', oid, h.product_code, pushErr);
          errors.push({
            openid: oid,
            product: h.product_code,
            error: pushErr.errMsg || pushErr.message,
          });
        }
      }
    }

    return {
      success: true,
      alerted,
      alerts,
      errors,
    };
  } catch (err) {
    console.error('[check_price_alert] error:', err);
    return {
      success: false,
      alerted: 0,
      error: err.errMsg || err.message,
      errors: [],
    };
  }
};
