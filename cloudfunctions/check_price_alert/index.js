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
 * 模板 ID：从每个用户在 notify_settings 中填写的 tmplIds.price_alert 读取，
 *        缺失时跳过该用户并在 errors 中清晰标记原因。
 *
 * 注意：替换后请保证 data 中的字段名（thing1/amount2/time3）与申请到的模板一致。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_BATCH = 1000; // 单次 get 上限

// 默认模板 ID（开发者在小程序后台申请后填入，当用户未配置时使用）
// 请替换为你在微信公众平台「订阅消息」模块申请到的实际模板 ID
const DEFAULT_TMPL_ID = '';

const PLACEHOLDER_HINT = 'YOUR_';

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
    let skippedNoTmpl = 0;
    const alerts = [];
    const errors = [];

    // 4. 逐用户判断阈值并推送
    for (const oid of openids) {
      const s = settingsMap[oid];
      if (!s || !s.priceAlert) continue; // 未开启涨跌提醒，跳过

      // 模板 ID 解析：优先用户配置 tmplIds.price_alert，未配置则使用默认模板
      const userTmplIds = s.tmplIds || {};
      let templateId = (userTmplIds.price_alert || '').trim();
      if (!templateId || templateId.indexOf(PLACEHOLDER_HINT) === 0) {
        templateId = DEFAULT_TMPL_ID;
      }
      if (!templateId) {
        // 一个用户只标记一次缺失
        if (!errors.some(e => e.openid === oid && e.error.indexOf('未配置订阅消息') === 0)) {
          skippedNoTmpl++;
          errors.push({
            openid: oid,
            error: '未配置订阅消息模板 ID（开发者需在 check_price_alert/index.js 设置 DEFAULT_TMPL_ID）',
          });
        }
        continue;
      }

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
            templateId,
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
      skippedNoTmpl,
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
