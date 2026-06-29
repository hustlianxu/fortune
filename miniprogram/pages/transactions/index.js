/**
 * 交易流水列表页面
 * 按交易日期倒序展示所有交易记录，支持账户/类型筛选
 * 顶部展示本期买入/卖出/净现金流汇总
 */
const { TRANSACTION_TYPES } = require('../../utils/constants');

const db = wx.cloud.database();
const _ = db.command;

Page({
  data: {
    transactions: [],         // 已加载的交易列表（已按日期分组，用于渲染）
    rawItems: [],             // 原始扁平列表（用于累计加载/汇总）
    accountList: [],          // 账户列表
    accountNames: [],         // 账户名 picker range
    accountIndex: 0,          // 当前选中的账户索引（0 = 全部）
    typeNames: ['全部类型'],   // 类型 picker range（首项为“全部”）
    typeIndex: 0,              // 当前选中的类型索引
    typeKeys: ['all'],         // 与 typeNames 对应的 key
    summary: {
      buyAmount: 0,           // 本期买入总额（现金流出）
      sellAmount: 0,          // 本期卖出总额（现金流入）
      netCashFlow: 0,         // 净现金流 = sell - buy
      count: 0,
    },
    loading: false,
    page: 0,
    pageSize: 50,
    hasMore: true,
  },

  onLoad() {
    // 初始化交易类型 picker
    const typeNames = ['全部类型'];
    const typeKeys = ['all'];
    TRANSACTION_TYPES.forEach(t => {
      typeNames.push(t.name);
      typeKeys.push(t.key);
    });
    this.setData({ typeNames, typeKeys });
  },

  onShow() {
    this.loadAccounts().then(() => this.reload());
  },

  async loadAccounts() {
    try {
      const res = await db.collection('accounts').orderBy('sort_order', 'asc').get();
      const accounts = res.data || [];
      const accountNames = ['全部账户'].concat(accounts.map(a => a.name || '未命名'));
      this.setData({
        accountList: accounts,
        accountNames,
      });
    } catch (err) {
      console.error('[Transactions] load accounts error:', err);
    }
  },

  /**
   * 重置并加载第一页
   */
  reload() {
    this.setData({ page: 0, hasMore: true, rawItems: [], transactions: [] });
    return this.loadTransactions();
  },

  async loadTransactions() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });

    try {
      const { accountIndex, accountList, typeIndex, typeKeys, page, pageSize } = this.data;

      let query = db.collection('transactions');
      if (accountIndex > 0) {
        const acc = accountList[accountIndex - 1];
        if (acc) query = query.where({ account_id: acc._id });
      }
      if (typeIndex > 0) {
        query = query.where({ type: typeKeys[typeIndex] });
      }

      const res = await query
        .orderBy('trade_date', 'desc')
        .orderBy('created_at', 'desc')
        .skip(page * pageSize)
        .limit(pageSize)
        .get();

      const newItems = res.data || [];
      const allItems = this.data.rawItems.concat(newItems);
      const hasMore = newItems.length === pageSize;

      // 重新计算汇总（基于当前已加载的全部数据）
      const summary = this.computeSummary(allItems);

      // 按交易日期分组
      const grouped = this.groupByDate(allItems);

      this.setData({
        rawItems: allItems,
        transactions: grouped,
        summary,
        page: page + 1,
        hasMore,
        loading: false,
      });
    } catch (err) {
      console.error('[Transactions] load error:', err);
      this.setData({ loading: false });
      // 集合可能尚未创建
      if (err && (err.errCode === -502005 || (err.message && err.message.indexOf('collection not exist') >= 0))) {
        wx.showToast({ title: '暂无交易记录', icon: 'none' });
      }
    }
  },

  computeSummary(items) {
    let buyAmount = 0;
    let sellAmount = 0;
    items.forEach(t => {
      const amount = typeof t.amount === 'number' ? t.amount : 0;
      if (t.type === 'buy' || t.type === 'transfer_out' || t.type === 'fee') {
        buyAmount += amount;
      } else if (t.type === 'sell' || t.type === 'dividend' || t.type === 'transfer_in' || t.type === 'interest') {
        sellAmount += amount;
      }
    });
    return {
      buyAmount,
      sellAmount,
      netCashFlow: sellAmount - buyAmount,
      count: items.length,
    };
  },

  /**
   * 按交易日期分组（同一天合并为一组）
   */
  groupByDate(items) {
    const map = {};
    const order = [];
    items.forEach(t => {
      const date = t.trade_date || '未知日期';
      if (!map[date]) {
        map[date] = [];
        order.push(date);
      }
      map[date].push(t);
    });
    // order 已经按 trade_date desc（因为查询时已排序），未知日期排最后
    return order.map(date => ({ date, items: map[date] }));
  },

  onAccountChange(e) {
    this.setData({ accountIndex: parseInt(e.detail.value, 10) });
    this.reload();
  },

  onTypeChange(e) {
    this.setData({ typeIndex: parseInt(e.detail.value, 10) });
    this.reload();
  },

  onAddTransaction() {
    const { accountIndex, accountList } = this.data;
    let url = '/pages/transactions/edit';
    if (accountIndex > 0 && accountList[accountIndex - 1]) {
      url += `?account_id=${accountList[accountIndex - 1]._id}`;
    }
    wx.navigateTo({ url });
  },

  onEditTransaction(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/transactions/edit?id=${id}` });
  },

  onDeleteTransaction(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除确认',
      content: '确定要删除这条交易记录吗？',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中...' });
        try {
          await db.collection('transactions').doc(id).remove();
          wx.hideLoading();
          wx.showToast({ title: '已删除', icon: 'success' });
          this.reload();
        } catch (err) {
          console.error('[Transactions] delete error:', err);
          wx.hideLoading();
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      },
    });
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadTransactions();
  },
});
