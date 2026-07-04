/**
 * delete_holding
 * 物理删除持仓及全部关联交易记录（不可恢复）。
 *
 * 入参：
 *   { account_id, product_code }   按产品删除
 *   { holding_id }                 按持仓文档 ID 删除（会自动查找 account_id+product_code）
 *
 * 为什么需要云函数：
 *   1. 客户端 .get() 默认上限 20 条，分页删除时 skip 会因前序删除导致记录位移，
 *      产生"删除不干净，旧记录残留"的顽疾。
 *   2. 云函数以 admin 身份运行，无权限/性能问题。
 *   3. 一次性完成"删持仓 + 删交易"，原子性强。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PAGE_SIZE = 100;

async function fetchAll(collection, where) {
  let all = [];
  let skip = 0;
  while (true) {
    let q = db.collection(collection);
    if (where) q = q.where(where);
    const res = await q.skip(skip).limit(PAGE_SIZE).get();
    all = all.concat(res.data);
    if (res.data.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    if (skip > 10000) break;
  }
  return all;
}

exports.main = async (event) => {
  const { account_id, product_code, holding_id } = event || {};

  try {
    let aid = account_id;
    let pcode = product_code;

    // 如果传了 holding_id，先查出 account_id + product_code
    if (!aid || !pcode) {
      if (holding_id) {
        const hRes = await db.collection('holdings').doc(holding_id).get();
        const h = hRes.data;
        if (!h || !h.account_id || !h.product_code) {
          return { success: false, message: '未找到对应持仓记录' };
        }
        aid = h.account_id;
        pcode = h.product_code;
      } else {
        return { success: false, message: '缺少 account_id + product_code 或 holding_id' };
      }
    }

    // 1. 删除所有关联交易记录（物理删除，一次性全量）
    const txns = await fetchAll('transactions', { account_id: aid, product_code: pcode });
    let deletedTxns = 0;
    for (const t of txns) {
      try {
        await db.collection('transactions').doc(t._id).remove();
        deletedTxns++;
      } catch (e) {
        console.warn('[delete_holding] delete txn failed:', t._id, e);
      }
    }

    // 2. 删除所有关联持仓（可能有多条重复持仓）
    const holdings = await fetchAll('holdings', { account_id: aid, product_code: pcode });
    let deletedHoldings = 0;
    for (const h of holdings) {
      try {
        await db.collection('holdings').doc(h._id).remove();
        deletedHoldings++;
      } catch (e) {
        console.warn('[delete_holding] delete holding failed:', h._id, e);
      }
    }

    console.log('[delete_holding] done:',
      'deleted', deletedTxns, 'txns,', deletedHoldings, 'holdings for',
      'account=' + aid + ', product=' + pcode);

    // 同步账户余额
    try {
      await cloud.callFunction({
        name: 'recalc_cash_balance',
        data: { account_id: aid },
      });
    } catch (e) {
      console.warn('[delete_holding] recalc_cash_balance error:', e);
    }

    return {
      success: true,
      message: `已删除 ${deletedTxns} 条交易记录、${deletedHoldings} 条持仓记录`,
      deletedTxns,
      deletedHoldings,
    };
  } catch (err) {
    console.error('[delete_holding] error:', err);
    return { success: false, message: err.message || '删除失败' };
  }
};
