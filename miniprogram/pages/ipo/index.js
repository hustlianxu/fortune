/**
 * 打新中签战绩统计页
 * 汇总所有 ipo_win 交易，结合持仓行情计算盈亏
 * 维度：总体汇总 / 年度统计 / 明细列表
 */
const { formatMoney } = require('../../utils/format');

function getPriceColor(val) {
  if (val > 0) return 'price-up';
  if (val < 0) return 'price-down';
  return 'price-flat';
}

Page({
  data: {
    loading: true,
    stats: {
      count: 0,
      totalInvest: 0,
      currentValue: 0,
      currentPnl: 0,
      pnlPercent: 0,
      realizedPnl: 0,
    },
    yearlyStats: [],     // [{ year, count, invest, pnl }]
    list: [],            // 明细列表
    pnlColor: 'price-flat',
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    try {
      const db = wx.cloud.database();
      const PAGE_SIZE = 100;
      let ipoTxns = [];
      let skip = 0;
      while (true) {
        const res = await db.collection('transactions')
          .where({ type: 'ipo_win' })
          .orderBy('trade_date', 'desc')
          .orderBy('created_at', 'desc')
          .skip(skip)
          .limit(PAGE_SIZE)
          .get();
        const batch = res.data || [];
        ipoTxns = ipoTxns.concat(batch);
        if (batch.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
        if (skip > 5000) break;
      }

      if (ipoTxns.length === 0) {
        this.setData({ loading: false, list: [], yearlyStats: [] });
        return;
      }

      // 按 product_code 聚合
      const productMap = {};
      let totalInvest = 0;
      for (const t of ipoTxns) {
        const key = t.product_code || '';
        if (!productMap[key]) {
          productMap[key] = {
            product_code: key,
            product_name: t.product_name || key,
            product_type: t.product_type || '',
            exchange: t.exchange || '',
            ipo_count: 0,
            ipo_invest: 0,
            ipo_shares: 0,
            ipo_price: 0,
            first_date: t.trade_date || '9999',
          };
        }
        const amt = Number(t.amount) || 0;
        const shr = Number(t.shares) || 0;
        const prc = Number(t.price) || 0;
        productMap[key].ipo_count += 1;
        productMap[key].ipo_invest += amt;
        productMap[key].ipo_shares += shr;
        if (prc > 0) productMap[key].ipo_price = prc;
        if (t.trade_date && t.trade_date < productMap[key].first_date) {
          productMap[key].first_date = t.trade_date;
        }
        totalInvest += amt;
      }

      // 拉取相关持仓
      const productCodes = Object.keys(productMap).filter(k => k);
      let holdingsByCode = {};
      for (const code of productCodes) {
        try {
          const hRes = await db.collection('holdings')
            .where({ product_code: code })
            .limit(1)
            .get();
          if (hRes.data && hRes.data.length > 0) {
            holdingsByCode[code] = hRes.data[0];
          }
        } catch (e) { /* 忽略单条错误 */ }
      }

      let currentPnl = 0;
      let currentValue = 0;
      let realizedPnl = 0;
      const list = [];
      const yearlyMap = {};

      for (const key of Object.keys(productMap)) {
        const p = productMap[key];
        const h = holdingsByCode[key];
        let pnl = 0;
        let mv = 0;
        let shares = 0;
        let currentPrice = 0;
        let realized = 0;
        let isCleared = false;
        if (h) {
          mv = Number(h.market_value) || 0;
          const cv = Number(h.cost_value) || 0;
          realized = Number(h.realized_pnl) || 0;
          pnl = (mv - cv) + realized;
          shares = Number(h.shares) || 0;
          currentPrice = Number(h.current_price) || 0;
          isCleared = !!h.is_cleared;
        }
        currentPnl += pnl;
        currentValue += mv;
        realizedPnl += realized;
        list.push({
          product_code: p.product_code,
          product_name: p.product_name,
          product_type: p.product_type,
          ipo_count: p.ipo_count,
          ipo_invest: Number(p.ipo_invest.toFixed(2)),
          ipo_shares: p.ipo_shares,
          ipo_price: p.ipo_price,
          first_date: p.first_date,
          current_value: Number(mv.toFixed(2)),
          current_shares: shares,
          current_price: currentPrice,
          pnl: Number(pnl.toFixed(2)),
          realized_pnl: Number(realized.toFixed(2)),
          is_cleared: isCleared,
        });

        // 年度统计
        const year = (p.first_date || '').substring(0, 4) || '未知';
        if (!yearlyMap[year]) yearlyMap[year] = { year, count: 0, invest: 0, pnl: 0 };
        yearlyMap[year].count += p.ipo_count;
        yearlyMap[year].invest += p.ipo_invest;
        yearlyMap[year].pnl += pnl;
      }

      list.sort((a, b) => b.pnl - a.pnl);
      const yearlyStats = Object.values(yearlyMap).sort((a, b) => b.year.localeCompare(a.year));
      yearlyStats.forEach(y => {
        y.invest = Number(y.invest.toFixed(2));
        y.pnl = Number(y.pnl.toFixed(2));
      });

      const pnlPercent = totalInvest > 0 ? (currentPnl / totalInvest) * 100 : 0;
      this.setData({
        loading: false,
        stats: {
          count: ipoTxns.length,
          totalInvest: Number(totalInvest.toFixed(2)),
          currentValue: Number(currentValue.toFixed(2)),
          currentPnl: Number(currentPnl.toFixed(2)),
          pnlPercent: Number(pnlPercent.toFixed(2)),
          realizedPnl: Number(realizedPnl.toFixed(2)),
        },
        yearlyStats,
        list,
        pnlColor: getPriceColor(currentPnl),
      });
    } catch (err) {
      console.error('[IPO] load error:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onHoldingTap(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    const db = wx.cloud.database();
    db.collection('holdings').where({ product_code: code }).limit(1).get().then(res => {
      if (res.data && res.data.length > 0) {
        wx.navigateTo({ url: `/pages/holding/detail?id=${res.data[0]._id}` });
      }
    });
  },

  formatMoney,
});
