/**
 * 多维度分析页
 * 支持按 产品类型 / 交易所 / 账户 / 策略 / 行业 5个维度查看持仓分布与盈亏
 * 行业维度依赖 holdings.industry 字段（可在持仓编辑页填写）
 */
const api = require('../../utils/api');
const { formatMoney } = require('../../utils/format');
const { inferProductType, productTypeName } = require('../../utils/inferProduct');

const DIMENSIONS = [
  { key: 'product_type', name: '产品类型' },
  { key: 'exchange', name: '市场' },
  { key: 'account', name: '账户' },
  { key: 'strategy', name: '策略' },
  { key: 'industry', name: '行业' },
];

Page({
  data: {
    loading: true,
    dimensions: DIMENSIONS,
    currentDim: 'product_type',
    groups: [],          // [{ name, count, marketValue, costValue, pnl, pnlPercent }]
    totalMarketValue: 0,
    totalPnL: 0,
    expandedGroups: {},  // 分组展开状态
    hideCleared: false,
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    try {
      const summary = await api.getPortfolioSummary();
      const accounts = summary.accounts || [];
      // 构建持仓扁平列表，附带账户名
      const allHoldings = [];
      accounts.forEach(acc => {
        (acc.holdings || []).forEach(h => {
          allHoldings.push({ ...h, _account_name: acc.name || '未命名' });
        });
      });

      this._buildGroups(allHoldings);
    } catch (err) {
      console.error('[Analysis] load error:', err);
      this.setData({ loading: false });
    }
  },

  _buildGroups(allHoldings) {
    const { currentDim, hideCleared } = this.data;
    let holdings = allHoldings;
    if (hideCleared) {
      holdings = holdings.filter(h => !h.is_cleared && (Number(h.shares) || 0) > 0);
    }

    const groupMap = {};
    holdings.forEach(h => {
      let name = '';
      switch (currentDim) {
        case 'product_type':
          // 缺类型时按代码推断兜底，并映射为中文名（如 stock→股票，etf→ETF）
          name = productTypeName(h.product_type || inferProductType(h.product_code));
          break;
        case 'exchange':
          name = h.exchange || '未知';
          break;
        case 'account':
          name = h._account_name || '未命名';
          break;
        case 'strategy':
          name = (h.strategy || '').trim() || '未分类';
          break;
        case 'industry':
          name = (h.industry || '').trim() || '未分类';
          break;
      }
      if (!groupMap[name]) {
        groupMap[name] = { name, holdings: [], marketValue: 0, costValue: 0, pnl: 0, count: 0 };
      }
      groupMap[name].holdings.push(h);
      groupMap[name].marketValue += Number(h.market_value) || 0;
      groupMap[name].costValue += Number(h.cost_value) || 0;
      groupMap[name].pnl += Number(h.total_pnl || h.pnl) || 0;
      groupMap[name].count += 1;
    });

    let groups = Object.values(groupMap).map(g => {
      g.marketValue = Number(g.marketValue.toFixed(2));
      g.costValue = Number(g.costValue.toFixed(2));
      g.pnl = Number(g.pnl.toFixed(2));
      g.pnlPercent = g.costValue > 0 ? Number(((g.pnl / g.costValue) * 100).toFixed(2)) : 0;
      return g;
    });
    // 按市值倒序
    groups.sort((a, b) => b.marketValue - a.marketValue);

    const totalMarketValue = groups.reduce((s, g) => s + g.marketValue, 0);
    const totalPnL = groups.reduce((s, g) => s + g.pnl, 0);

    // 默认展开第一个分组
    const expandedGroups = {};
    if (groups.length > 0) expandedGroups[groups[0].name] = true;

    this.setData({
      loading: false,
      groups,
      totalMarketValue: Number(totalMarketValue.toFixed(2)),
      totalPnL: Number(totalPnL.toFixed(2)),
      expandedGroups,
    });
  },

  onDimChange(e) {
    const dim = e.currentTarget.dataset.dim;
    if (dim === this.data.currentDim) return;
    this.setData({ currentDim: dim, expandedGroups: {} }, () => {
      // 重新分组（不需重新拉数据，用缓存的 holdings）
      this._rebuildFromCache();
    });
  },

  _rebuildFromCache() {
    // 由于 loadData 已构建过，这里简单重新拉取
    this.loadData();
  },

  onToggleGroup(e) {
    const name = e.currentTarget.dataset.name;
    const key = `expandedGroups.${name}`;
    this.setData({ [key]: !this.data.expandedGroups[name] });
  },

  onToggleHideCleared() {
    this.setData({ hideCleared: !this.data.hideCleared }, () => {
      this._rebuildFromCache();
    });
  },

  onHoldingTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/holding/detail?id=${id}` });
  },

  formatMoney,
});
