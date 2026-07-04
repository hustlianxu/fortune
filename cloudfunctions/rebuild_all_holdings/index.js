/**
 * rebuild_all_holdings
 * 全量重建当前用户的所有持仓（遍历所有账户下所有有交易的产品）。
 * 用于修复因历史 bug（ipo_win/stock_dividend 未回放，validateHoldingByReplay 自动修正为 0 等）
 * 导致持仓数据错误的场景。
 *
 * 无入参（自动识别当前用户的全部交易记录）
 * 返回：{ success, results: [{ account_id, product_code, message }] }
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PAGE_SIZE = 100;

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';

  try {
    // 1. 收集需要重建的 (account_id, product_code) 唯一组合
    //    来源A：该用户有 _openid 的交易记录
    //    来源B：该用户账户下已有的持仓（兼容历史无 _openid 的交易）
    const productSet = new Set();

    // 来源A：查询有 _openid 的交易
    let allTxns = [];
    let skip = 0;
    while (true) {
      const res = await db.collection('transactions')
        .where({ _openid: openid })
        .skip(skip).limit(PAGE_SIZE)
        .get();
      const batch = res.data || [];
      allTxns = allTxns.concat(batch);
      if (batch.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
      if (skip > 10000) break;
    }
    for (const t of allTxns) {
      if (t.account_id && t.product_code) {
        productSet.add(t.account_id + '|' + t.product_code);
      }
    }

    // 来源B：查询该用户账户下现有的持仓（兼容无 _openid 的历史交易）
    const accRes = await db.collection('accounts').where({ _openid: openid }).get();
    const userAccountIds = (accRes.data || []).map(a => a._id);
    if (userAccountIds.length > 0) {
      const _ = db.command;
      const holdingsRes = await db.collection('holdings')
        .where({ account_id: _.in(userAccountIds) })
        .limit(500).get();
      for (const h of (holdingsRes.data || [])) {
        if (h.account_id && h.product_code) {
          productSet.add(h.account_id + '|' + h.product_code);
        }
      }
    }

    const products = [];
    for (const key of productSet) {
      const [acc, code] = key.split('|');
      products.push({ account_id: acc, product_code: code });
    }

    if (products.length === 0) {
      return { success: true, message: '没有需要重建的持仓', results: [] };
    }

    // 2. 逐个调用 rebuild_holdings
    const results = [];
    let success = 0;
    let failed = 0;
    for (const p of products) {
      try {
        const r = await cloud.callFunction({
          name: 'rebuild_holdings',
          data: { account_id: p.account_id, product_code: p.product_code, openid },
        });
        const rr = (r && r.result) || {};
        if (rr.success) {
          success++;
          results.push({ ...p, message: rr.message || 'OK' });
        } else {
          failed++;
          results.push({ ...p, message: rr.message || 'FAIL' });
        }
      } catch (e) {
        failed++;
        results.push({ ...p, message: e.message || '异常' });
      }
    }

    // 3. 同步所有账户余额
    const accountIds = new Set(allTxns.map(t => t.account_id).filter(Boolean));
    for (const aid of accountIds) {
      try {
        await cloud.callFunction({
          name: 'recalc_cash_balance',
          data: { account_id: aid },
        });
      } catch (e) {
        console.warn('[rebuild_all] recalc balance error for', aid, e);
      }
    }

    return {
      success: true,
      message: `全量重建完成：成功 ${success} 个，失败 ${failed} 个，共 ${products.length} 个产品`,
      results,
      totalProducts: products.length,
    };
  } catch (err) {
    console.error('[rebuild_all] error:', err);
    return { success: false, message: err.message || '全量重建失败' };
  }
};
