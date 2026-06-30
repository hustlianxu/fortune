/**
 * 持仓详情页面
 * - 展示持仓盈亏/份额/成本
 * - 「记一笔买卖」入口：跳转交易编辑页并预填
 * - 展示该持仓的所有交易，可编辑/删除/长按操作
 * - 累计投入折线图
 */
const { formatMoney, formatDate, formatQuantity, formatPercent, getPriceColor } = require('../../utils/format');
const { PRODUCT_TYPES } = require('../../utils/constants');

const db = wx.cloud.database();

Page({
  data: {
    holding: {},
    holdingId: '',
    priceColor: 'price-flat',
    transactions: [],         // 该持仓的全部交易（按日期正序）
    loadingTxns: false,
    chartRendered: false,
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ holdingId: options.id });
    }
  },

  onShow() {
    if (this.data.holdingId) {
      this.loadAll();
    }
  },

  /** 按顺序加载持仓 → 交易 → 画图 */
  async loadAll() {
    await this.loadHolding();
    await this.loadAllTransactions();
    this.drawChart();
  },

  async loadHolding() {
    try {
      const res = await db.collection('holdings').doc(this.data.holdingId).get();
      const holding = res.data || {};
      // 实时重算盈亏，避免行情刷新/编辑持仓后仍使用旧快照导致与同花顺偏差
      const shares = Number(holding.shares) || 0;
      const currentPrice = Number(holding.current_price) || 0;
      const costValue = Number(holding.cost_value) || (shares * Number(holding.cost_price || 0));
      const marketValue = shares * currentPrice;
      const pnl = marketValue - costValue;                                  // 浮动盈亏
      const pnlPercent = costValue > 0 ? (pnl / costValue) * 100 : 0;
      const realized = Number(holding.realized_pnl) || 0;                   // 累计已实现盈亏
      const dividend = Number(holding.total_dividend) || 0;                 // 累计分红
      const totalFee = Number(holding.total_fee) || 0;                      // 累计手续费
      // 总收益（同花顺口径） = 浮动 + 已实现 + 分红 - 手续费
      const totalPnl = Number((pnl + realized + dividend - totalFee).toFixed(2));
      // 总收益率（按累计投入成本算）
      const investedCost = costValue + Math.max(0, realized);  // 已实现盈亏对应的部分已退出，用累计投入近似
      const totalPnlPercent = investedCost > 0 ? (totalPnl / investedCost) * 100 : 0;

      const recomputed = Object.assign({}, holding, {
        market_value: marketValue,
        cost_value: costValue,
        pnl,
        pnl_percent: pnlPercent,
        realized_pnl: realized,
        total_dividend: dividend,
        total_fee: totalFee,
        total_pnl: totalPnl,
        total_pnl_percent: totalPnlPercent,
      });
      this.setData({
        holding: recomputed,
        priceColor: getPriceColor(totalPnl),
      });
    } catch (err) {
      console.error('[Holding Detail] load error:', err);
    }
  },

  /** 加载该持仓的全部交易（按日期正序，用于图表和列表） */
  async loadAllTransactions() {
    const { holding } = this.data;
    if (!holding.account_id || !holding.product_code) return;
    this.setData({ loadingTxns: true });
    try {
      const res = await db.collection('transactions')
        .where({
          account_id: holding.account_id,
          product_code: holding.product_code,
        })
        .orderBy('trade_date', 'asc')
        .orderBy('created_at', 'asc')
        .get();
      this.setData({
        transactions: res.data || [],
        loadingTxns: false,
      });
    } catch (err) {
      console.error('[Holding Detail] load txns error:', err);
      this.setData({ loadingTxns: false });
    }
  },

  /**
   * 绘制累计投入折线图
   */
  drawChart() {
    const txns = this.data.transactions;
    if (txns.length < 2) {
      this.setData({ chartRendered: false });
      return;
    }

    const query = wx.createSelectorQuery();
    query.select('#costChart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0]) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getSystemInfoSync().pixelRatio;
      const width = res[0].width;
      const height = res[0].height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);

      // 计算累计数据
      const points = [];
      let cumShares = 0;
      let cumCost = 0;
      for (const t of txns) {
        const amt = Number(t.amount) || 0;
        const shr = Number(t.shares) || 0;
        if (t.type === 'buy') {
          cumShares += shr;
          cumCost += amt;
        } else if (t.type === 'sell') {
          cumShares = Math.max(0, cumShares - shr);
          // cost doesn't decrease on sell in weighted avg method,
          // but for chart purposes we reduce proportionally
        }
        points.push({
          date: (t.trade_date || '').slice(5), // MM-DD
          cost: cumCost,
          shares: cumShares,
        });
      }

      if (points.length < 2) {
        this.setData({ chartRendered: false });
        return;
      }

      const pad = { top: 20, right: 20, bottom: 36, left: 60 };
      const chartW = width - pad.left - pad.right;
      const chartH = height - pad.top - pad.bottom;

      const maxVal = Math.max(...points.map(p => p.cost), 1) * 1.15;
      const minDate = 0;
      const maxDate = points.length - 1;

      const getX = (i) => pad.left + (i / maxDate) * chartW;
      const getY = (v) => pad.top + chartH - (v / maxVal) * chartH;

      // 清空
      ctx.clearRect(0, 0, width, height);

      // 网格线
      ctx.strokeStyle = '#f0f0f0';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = pad.top + (chartH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        // Y 轴标签
        const val = maxVal - (maxVal / 4) * i;
        ctx.fillStyle = '#999';
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('¥' + (val >= 10000 ? (val / 10000).toFixed(1) + '万' : val.toFixed(0)), pad.left - 8, y + 6);
      }

      // X 轴日期标签（仅首尾和中间）
      ctx.fillStyle = '#999';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      [0, Math.floor(points.length / 2), points.length - 1].forEach(i => {
        if (i < points.length) {
          ctx.fillText(points[i].date, getX(i), height - pad.bottom + 24);
        }
      });

      // 累计成本线
      ctx.strokeStyle = '#6c63ff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = getX(i);
        const y = getY(p.cost);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      // 成本线下渐变填充
      const lastCost = points[points.length - 1].cost;
      const gradient = ctx.createLinearGradient(0, getY(lastCost), 0, pad.top + chartH);
      gradient.addColorStop(0, 'rgba(108, 99, 255, 0.15)');
      gradient.addColorStop(1, 'rgba(108, 99, 255, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(getX(0), pad.top + chartH);
      points.forEach((p, i) => {
        ctx.lineTo(getX(i), getY(p.cost));
      });
      ctx.lineTo(getX(points.length - 1), pad.top + chartH);
      ctx.closePath();
      ctx.fill();

      // 数据点圆点
      ctx.fillStyle = '#6c63ff';
      points.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(getX(i), getY(p.cost), 3, 0, 2 * Math.PI);
        ctx.fill();
      });

      this.setData({ chartRendered: true });
    });
  },

  /** 长按交易 → 操作菜单 */
  onLongPressTxn(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showActionSheet({
      itemList: ['编辑', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.onEditTxn(e);
        } else if (res.tapIndex === 1) {
          this.onDeleteTxn(e);
        }
      },
    });
  },

  /** 编辑交易 */
  onEditTxn(e) {
    const id = e.currentTarget.dataset.id;
    if (id) {
      wx.navigateTo({ url: `/pages/transactions/edit?id=${id}` });
    }
  },

  /** 删除交易 */
  onDeleteTxn(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除交易',
      content: '确定要删除这条交易记录吗？删除后对应持仓将自动修正。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中...', mask: true });
        try {
          const txnRes = await db.collection('transactions').doc(id).get();
          const txn = txnRes.data;
          await db.collection('transactions').doc(id).remove();
          if (txn && (txn.type === 'buy' || txn.type === 'sell' || txn.type === 'dividend' || txn.type === 'interest')) {
            await this.undoHolding(txn);
          }
          wx.hideLoading();
          wx.showToast({ title: '已删除，持仓已修正', icon: 'success' });
          this.loadAll();
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      },
    });
  },

  /** 删除交易后修正对应持仓：全量回放剩余交易，保证 realized_pnl/total_dividend/total_fee/total_pnl 与 apply_transaction 口径一致 */
  async undoHolding(txn) {
    try {
      const holdingRes = await db.collection('holdings')
        .where({ account_id: txn.account_id, product_code: txn.product_code })
        .limit(1).get();
      const holding = holdingRes.data[0];
      if (!holding) return;

      // 拉取该持仓剩余的全部交易（被删除的已不在集合中），按日期正序回放
      const txnsRes = await db.collection('transactions')
        .where({ account_id: txn.account_id, product_code: txn.product_code })
        .orderBy('trade_date', 'asc')
        .orderBy('created_at', 'asc')
        .get();
      const txns = txnsRes.data || [];

      let shares = 0;
      let costValue = 0;
      let costPrice = 0;
      let realizedPnl = 0;
      let totalDividend = 0;
      let totalFee = 0;

      for (const t of txns) {
        const type = t.type;
        const tShares = Number(t.shares) || 0;
        const tPrice = Number(t.price) || 0;
        const tFee = Number(t.fee) || 0;
        const tAmount = Number(t.amount) || 0;

        if (type === 'buy') {
          // 买入成本含手续费（同花顺口径）
          const buyCost = tShares * tPrice + tFee;
          const newShares = shares + tShares;
          const newCostValue = costValue + buyCost;
          costPrice = newShares > 0 ? newCostValue / newShares : tPrice;
          shares = newShares;
          costValue = newCostValue;
          totalFee += tFee;
        } else if (type === 'sell') {
          // 已实现盈亏 = (卖出价 - 成本价) × 卖出份额 - 卖出手续费
          const sellRealized = (tPrice - costPrice) * tShares - tFee;
          realizedPnl += sellRealized;
          shares = Math.max(0, shares - tShares);
          costValue = shares * costPrice;
          totalFee += tFee;
        } else if (type === 'dividend' || type === 'interest') {
          totalDividend += tAmount;
        }
      }

      const curPrice = Number(holding.current_price) || 0;
      const marketValue = Number((shares * curPrice).toFixed(2));
      const pnl = Number((marketValue - costValue).toFixed(2));
      const totalPnl = Number((pnl + realizedPnl + totalDividend - totalFee).toFixed(2));
      const isCleared = shares <= 0;

      await db.collection('holdings').doc(holding._id).update({
        data: {
          shares: shares,
          cost_price: Number(costPrice.toFixed(4)),
          cost_value: Number(costValue.toFixed(2)),
          market_value: marketValue,
          pnl: pnl,
          pnl_percent: costValue > 0 ? Number(((pnl / costValue) * 100).toFixed(2)) : 0,
          realized_pnl: Number(realizedPnl.toFixed(2)),
          total_dividend: Number(totalDividend.toFixed(2)),
          total_fee: Number(totalFee.toFixed(2)),
          total_pnl: totalPnl,
          is_cleared: isCleared,
          updated_at: db.serverDate(),
        },
      });
    } catch (err) {
      console.error('[undoHolding] error:', err);
    }
  },

  onRecordTrade() {
    const h = this.data.holding;
    const params = [
      `account_id=${encodeURIComponent(h.account_id || '')}`,
      `product_code=${encodeURIComponent(h.product_code || '')}`,
      `product_name=${encodeURIComponent(h.product_name || '')}`,
      `product_type=${encodeURIComponent(h.product_type || '')}`,
      `exchange=${encodeURIComponent(h.exchange || '')}`,
      `current_shares=${encodeURIComponent(String(h.shares || '0'))}`,
      `from=holding`,
    ].join('&');
    wx.navigateTo({
      url: `/pages/transactions/edit?${params}`,
    });
  },

  onEdit() {
    wx.navigateTo({
      url: `/pages/holding/edit?id=${this.data.holding._id}`,
    });
  },

  onDelete() {
    wx.showModal({
      title: '确认删除',
      content: `删除 ${this.data.holding.product_name} 的持仓记录？`,
      success: async (res) => {
        if (res.confirm) {
          try {
            await db.collection('holdings').doc(this.data.holding._id).remove();
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 1000);
          } catch (err) {
            wx.showToast({ title: '删除失败', icon: 'none' });
          }
        }
      },
    });
  },

  tagClass(type) {
    const t = PRODUCT_TYPES[type?.toUpperCase()];
    return t?.tag || 'tag-stock';
  },

  productTypeName(type) {
    const t = PRODUCT_TYPES[type?.toUpperCase()];
    return t?.name || type || '股票';
  },

  formatMoney, formatDate, formatQuantity, formatPercent,
});
