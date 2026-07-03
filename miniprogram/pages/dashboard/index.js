/**
 * 资产看板页面
 */
const api = require('../../utils/api');
const { formatDate, getPriceColor, getPriceArrow } = require('../../utils/format');

Page({
  data: {
    loading: true,
    summary: {
      totalAssets: 0,
      totalPnL: 0,
      totalPnLPercent: 0,
      todayPnL: 0,
      holdingCount: 0,
      accountCount: 0,
      accounts: [],
    },
    distributionList: [],
    lastUpdate: '',
    pnlColor: 'price-flat',
    pnlArrow: '→',
    todayPnlColor: 'price-flat',
    // 总盈亏百分比显示文本
    pnlPercentText: '0.00%',
    // 打新战绩统计
    ipoStats: {
      count: 0,           // 中签次数
      totalInvest: 0,     // 累计中签投入金额
      currentPnl: 0,      // 当前打新浮动+已实现盈亏（按中签产品聚合）
      pnlPercent: 0,      // 收益率
      list: [],           // 明细列表（按中签日期倒序）
    },
    ipoPnlColor: 'price-flat',
  },

  onLoad() {
    // 注册全局刷新
    const app = getApp();
    app.onRefresh(() => {
      this.loadData();
    });
  },

  onReady() {
    // Canvas 2D 需要在 ready 后才能拿到节点
    this.drawPie();
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const summary = await api.getPortfolioSummary();
      // 优先使用总收益（同花顺口径：浮动+已实现+分红），回退到浮动盈亏
      const totalPnlForDisplay = summary.totalAllPnL != null ? summary.totalAllPnL : summary.totalPnL;
      const totalPnlPctForDisplay = summary.totalAllPnLPercent != null ? summary.totalAllPnLPercent : (summary.totalPnLPercent || 0);
      this.setData({
        summary,
        pnlColor: getPriceColor(totalPnlForDisplay),
        pnlArrow: getPriceArrow(totalPnlForDisplay),
        todayPnlColor: getPriceColor(summary.todayPnL),
        pnlPercentText: (totalPnlPctForDisplay || 0).toFixed(2) + '%',
        lastUpdate: wx.getStorageSync('last_price_update') || '',
        distributionList: this.buildDistribution(summary),
        loading: false,
      });

      // 更新全局数据
      const app = getApp();
      app.globalData.totalAssets = summary.totalAssets;
      app.globalData.totalPnL = totalPnlForDisplay;

      // 数据就绪后绘制饼图
      this.drawPie();

      // 加载打新战绩统计
      this.loadIpoStats();

      // 检查是否需要自动更新行情
      if (wx.getStorageSync('need_price_update')) {
        this.autoRefreshPrices();
      }
    } catch (err) {
      console.error('[Dashboard] loadData error:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  /**
   * 加载打新中签战绩统计
   * 拉取所有 ipo_win 交易，结合 holdings 行情计算：
   *   - 中签次数 = ipo_win 交易条数
   *   - 累计投入 = sum(amount)
   *   - 当前盈亏 = sum(该产品持仓的 market_value - cost_value + realized_pnl)
   *     （按 product_code 聚合，含已卖出部分的已实现盈亏）
   */
  async loadIpoStats() {
    try {
      const db = wx.cloud.database();
      const PAGE_SIZE = 100;
      let ipoTxns = [];
      let skip = 0;
      // 分页拉取 ipo_win 交易
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
        this.setData({
          'ipoStats.count': 0,
          'ipoStats.totalInvest': 0,
          'ipoStats.currentPnl': 0,
          'ipoStats.pnlPercent': 0,
          'ipoStats.list': [],
          ipoPnlColor: 'price-flat',
        });
        return;
      }

      // 按 product_code 聚合（同一只新股可能多次中签）
      const productMap = {};
      let totalInvest = 0;
      for (const t of ipoTxns) {
        const key = t.product_code || '';
        if (!productMap[key]) {
          productMap[key] = {
            product_code: key,
            product_name: t.product_name || key,
            ipo_count: 0,
            ipo_invest: 0,
            ipo_shares: 0,
            ipo_price: 0,
            first_date: t.trade_date || '',
          };
        }
        const amt = Number(t.amount) || 0;
        const shr = Number(t.shares) || 0;
        const prc = Number(t.price) || 0;
        productMap[key].ipo_count += 1;
        productMap[key].ipo_invest += amt;
        productMap[key].ipo_shares += shr;
        if (prc > 0) productMap[key].ipo_price = prc;
        // 取最早中签日期
        if (t.trade_date && t.trade_date < productMap[key].first_date) {
          productMap[key].first_date = t.trade_date;
        }
        totalInvest += amt;
      }

      // 拉取相关持仓，计算当前盈亏
      const productCodes = Object.keys(productMap).filter(k => k);
      let holdingsByCode = {};
      if (productCodes.length > 0) {
        // 分批 where 查询（云数据库 where in 限制，逐个查或用复合查询）
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
      }

      let currentPnl = 0;
      const list = [];
      for (const key of Object.keys(productMap)) {
        const p = productMap[key];
        const h = holdingsByCode[key];
        // 当前盈亏 = 持仓浮动盈亏 + 已实现盈亏（含已清仓）
        let pnl = 0;
        let currentValue = 0;
        let shares = 0;
        let currentPrice = 0;
        if (h) {
          const mv = Number(h.market_value) || 0;
          const cv = Number(h.cost_value) || 0;
          const realized = Number(h.realized_pnl) || 0;
          pnl = (mv - cv) + realized;
          currentValue = mv;
          shares = Number(h.shares) || 0;
          currentPrice = Number(h.current_price) || 0;
        }
        currentPnl += pnl;
        list.push({
          product_code: p.product_code,
          product_name: p.product_name,
          ipo_count: p.ipo_count,
          ipo_invest: Number(p.ipo_invest.toFixed(2)),
          ipo_shares: p.ipo_shares,
          ipo_price: p.ipo_price,
          first_date: p.first_date,
          current_value: Number(currentValue.toFixed(2)),
          current_shares: shares,
          current_price: currentPrice,
          pnl: Number(pnl.toFixed(2)),
        });
      }
      // 按盈亏倒序
      list.sort((a, b) => b.pnl - a.pnl);

      const pnlPercent = totalInvest > 0 ? (currentPnl / totalInvest) * 100 : 0;
      this.setData({
        'ipoStats.count': ipoTxns.length,
        'ipoStats.totalInvest': Number(totalInvest.toFixed(2)),
        'ipoStats.currentPnl': Number(currentPnl.toFixed(2)),
        'ipoStats.pnlPercent': Number(pnlPercent.toFixed(2)),
        'ipoStats.list': list,
        ipoPnlColor: getPriceColor(currentPnl),
      });
    } catch (err) {
      console.error('[loadIpoStats] error:', err);
    }
  },

  /**
   * 构建饼图分布数据
   */
  buildDistribution(summary) {
    if (!summary.accounts || summary.accounts.length === 0) return [];
    const colors = ['#6c63ff', '#1890ff', '#52c41a', '#fa8c16', '#13c2c2', '#eb2f96', '#722ed1', '#a0d911'];
    const total = summary.totalAssets || 1;
    return summary.accounts.map((acc, i) => ({
      name: acc.name,
      value: acc.total_value || 0,
      percent: (((acc.total_value || 0) / total) * 100).toFixed(1),
      color: colors[i % colors.length],
    }));
  },

  /**
   * 绘制资产分布饼图（Canvas 2D）
   */
  drawPie() {
    const list = this.data.distributionList;
    if (!list || list.length === 0) return;
    const query = wx.createSelectorQuery();
    query.select('#pieCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2;
      const width = res[0].width || 150;
      const height = res[0].height || 150;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);

      const total = list.reduce((s, i) => s + (parseFloat(i.value) || 0), 0);
      if (total <= 0) return;

      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) / 2 - 4;

      let startAngle = -Math.PI / 2;
      list.forEach((item) => {
        const value = parseFloat(item.value) || 0;
        if (value <= 0) return;
        const angle = (value / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, radius, startAngle, startAngle + angle);
        ctx.closePath();
        ctx.fillStyle = item.color;
        ctx.fill();
        startAngle += angle;
      });

      // 中心空心
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    });
  },

  /**
   * 自动刷新行情
   */
  async autoRefreshPrices() {
    try {
      wx.showLoading({ title: '更新行情中...' });
      const result = await api.refreshPrices();
      if (result && result.success) {
        this.markUpdated();
        wx.hideLoading();
        // 重新加载数据
        this.loadData();
      } else {
        wx.hideLoading();
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[autoRefreshPrices] error:', err);
    }
  },

  /**
   * 手动刷新
   */
  async onRefresh() {
    wx.showLoading({ title: '刷新中...' });
    try {
      const result = await api.refreshPrices();
      if (result && result.success) {
        this.markUpdated();
        wx.showToast({ title: '刷新成功', icon: 'success' });
      } else {
        wx.showToast({ title: (result && result.message) || '刷新失败', icon: 'none' });
      }
      this.loadData();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
    }
  },

  /**
   * 记录已刷新行情的时间戳
   * 统一使用 toDateString 格式，与 app.checkDailyUpdate 对齐
   */
  markUpdated() {
    const now = new Date();
    wx.setStorageSync('last_price_update', formatDate(now, 'MM-DD HH:mm'));
    wx.setStorageSync('last_price_update_day', now.toDateString());
    wx.setStorageSync('need_price_update', false);
  },

  /**
   * 点击账户
   */
  onAccountTap(e) {
    const account = e.currentTarget.dataset.account;
    wx.navigateTo({
      url: `/pages/account/detail?id=${account._id}`,
    });
  },

  /**
   * 添加账户
   */
  onAddAccount() {
    wx.navigateTo({ url: '/pages/account/edit' });
  },

  /**
   * 跳转 AI 分析
   */
  onGoToAI() {
    wx.switchTab({ url: '/pages/ai/index' });
  },

  /** 跳转打新战绩统计页 */
  onGoIpo() {
    wx.navigateTo({ url: '/pages/ipo/index' });
  },

  /**
   * 跳转导入
   */
  onGoToImport() {
    wx.navigateTo({ url: '/pages/import/index' });
  },

  /**
   * 手动添加持仓
   */
  onAddHolding() {
    wx.navigateTo({ url: '/pages/holding/edit' });
  },
});
