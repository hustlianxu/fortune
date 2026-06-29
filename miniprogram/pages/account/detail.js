/**
 * 账户详情页面
 */
const api = require('../../utils/api');
const { formatMoney, formatQuantity } = require('../../utils/format');
const { ACCOUNT_PLATFORMS } = require('../../utils/constants');

const db = wx.cloud.database();

Page({
  data: {
    account: {
      holdings: [],
      total_value: 0,
      pnl: 0,
      holdingCount: 0,
    },
    strategyGroups: [],       // [{ name, holdings, marketValue, pnl }]
    unassignedHoldings: [],   // 无策略标签的持仓
    expandedGroups: {},       // { '策略名': true/false }
    recentTxns: [],           // 该账户最近交易
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ 'account._id': options.id });
      this.loadAccount(options.id);
    }
  },

  onShow() {
    if (this.data.account._id) {
      this.loadAll();
    }
  },

  async loadAll() {
    const id = this.data.account._id;
    await this.loadAccount(id);
    await this.loadTransactions(id);
    this.drawChart();
  },

  async loadAccount(id) {
    try {
      const summary = await api.getPortfolioSummary();
      const account = (summary.accounts || []).find(a => a._id === id);
      if (account) {
        const grouped = {};
        const unassigned = [];
        (account.holdings || []).forEach(h => {
          const s = (h.strategy || '').trim();
          if (s) {
            if (!grouped[s]) grouped[s] = [];
            grouped[s].push(h);
          } else {
            unassigned.push(h);
          }
        });
        this.setData({
          account,
          strategyGroups: Object.entries(grouped).map(([name, hList]) => {
            const mktVal = hList.reduce((s, h) => s + (h.market_value || 0), 0);
            const costVal = hList.reduce((s, h) => s + (h.cost_value || 0), 0);
            return { name, holdings: hList, marketValue: mktVal, pnl: mktVal - costVal };
          }),
          unassignedHoldings: unassigned,
        });
      }
    } catch (err) {
      console.error('[Account Detail] error:', err);
    }
  },

  /** 加载该账户最近交易（用于图表） */
  async loadTransactions(id) {
    try {
      const res = await db.collection('transactions')
        .where({ account_id: id })
        .orderBy('trade_date', 'asc')
        .orderBy('created_at', 'asc')
        .get();
      this.setData({ recentTxns: res.data || [] });
    } catch (err) {
      console.error('[Account Detail] load txns error:', err);
    }
  },

  /** 绘制累计投入折线图 */
  drawChart() {
    const txns = this.data.recentTxns;
    if (txns.length < 2) return;

    const query = wx.createSelectorQuery();
    query.select('#accountChart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0]) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getSystemInfoSync().pixelRatio;
      const width = res[0].width;
      const height = res[0].height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);

      // 计算累计投入
      const points = [];
      let cumNet = 0;
      for (const t of txns) {
        const amt = Number(t.amount) || 0;
        if (t.type === 'buy' || t.type === 'transfer_out' || t.type === 'fee') {
          cumNet -= amt;
        } else if (t.type === 'sell' || t.type === 'dividend' || t.type === 'transfer_in' || t.type === 'interest') {
          cumNet += amt;
        }
        points.push({
          date: (t.trade_date || '').slice(5),
          value: cumNet,
        });
      }

      if (points.length < 2) return;

      const pad = { top: 20, right: 20, bottom: 36, left: 60 };
      const chartW = width - pad.left - pad.right;
      const chartH = height - pad.top - pad.bottom;

      const vals = points.map(p => p.value);
      const minVal = Math.min(0, ...vals) * 1.1;
      const maxVal = Math.max(0, ...vals) * 1.1;
      const range = maxVal - minVal || 1;

      const getX = (i) => pad.left + (i / (points.length - 1)) * chartW;
      const getY = (v) => pad.top + chartH - ((v - minVal) / range) * chartH;

      ctx.clearRect(0, 0, width, height);

      // 网格
      ctx.strokeStyle = '#f0f0f0';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = pad.top + (chartH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        const val = maxVal - (range / 4) * i;
        ctx.fillStyle = '#999';
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('¥' + (Math.abs(val) >= 10000 ? (val / 10000).toFixed(1) + '万' : val.toFixed(0)), pad.left - 8, y + 6);
      }

      // X轴日期
      ctx.fillStyle = '#999';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      [0, Math.floor(points.length / 2), points.length - 1].forEach(i => {
        if (i < points.length) ctx.fillText(points[i].date, getX(i), height - pad.bottom + 24);
      });

      // 折线
      const lineColor = points[points.length - 1].value >= 0 ? '#52c41a' : '#ff4d4f';
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      points.forEach((p, i) => {
        i === 0 ? ctx.moveTo(getX(i), getY(p.value)) : ctx.lineTo(getX(i), getY(p.value));
      });
      ctx.stroke();

      // 填充
      const lastY = getY(points[points.length - 1].value);
      const grad = ctx.createLinearGradient(0, getY(maxVal), 0, pad.top + chartH);
      grad.addColorStop(0, lineColor.replace(')', ', 0.15)').replace('rgb', 'rgba').replace('#', 'rgba(?'));
      // simple gradient
      grad.addColorStop(0, 'rgba(108,99,255,0.12)');
      grad.addColorStop(1, 'rgba(108,99,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(getX(0), pad.top + chartH);
      points.forEach((p, i) => ctx.lineTo(getX(i), getY(p.value)));
      ctx.lineTo(getX(points.length - 1), pad.top + chartH);
      ctx.closePath();
      ctx.fill();
    });
  },

  onToggleGroup(e) {
    const name = e.currentTarget.dataset.name;
    const key = `expandedGroups.${name}`;
    this.setData({ [key]: !this.data.expandedGroups[name] });
  },

  onHoldingTap(e) {
    const holding = e.currentTarget.dataset.holding;
    wx.navigateTo({
      url: `/pages/holding/detail?id=${holding._id}`,
    });
  },

  onEditAccount() {
    wx.navigateTo({
      url: `/pages/account/edit?id=${this.data.account._id}`,
    });
  },

  onAddHolding() {
    wx.navigateTo({
      url: `/pages/holding/edit?account_id=${this.data.account._id}`,
    });
  },

  platformName(platformKey) {
    for (const group of ACCOUNT_PLATFORMS) {
      if (group.platforms) {
        const found = group.platforms.find(p => p.key === platformKey);
        if (found) return found.name;
      }
    }
    return platformKey || '未知';
  },

  formatMoney,
  formatQuantity,
});
