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
    typeNames: ['全部类型'],   // 类型 picker range（首项为”全部”）
    typeIndex: 0,              // 当前选中的类型索引
    typeKeys: ['all'],         // 与 typeNames 对应的 key
    summary: {
      buyAmount: 0,           // 本期买入总额（现金流出）
      sellAmount: 0,          // 本期卖出总额（现金流入）
      netCashFlow: 0,         // 净现金流 = sell - buy
      count: 0,
    },
    unappliedCount: 0,        // 未同步到持仓的交易数
    syncing: false,           // 正在同步中
    swipedItemId: '',         // 左滑展开的项 _id
    touchStartX: 0,           // 滑动检测起始 X
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

      // 统计未同步到持仓的交易数
      const unappliedCount = allItems.filter(t =>
        t.type === 'buy' || t.type === 'sell'
      ).filter(t => !t.applied_holding).length;

      this.setData({
        rawItems: allItems,
        transactions: grouped,
        summary,
        unappliedCount,
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
      content: '确定要删除这条交易记录吗？删除后对应持仓将自动修正。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中...', mask: true });
        try {
          // 1. 先查出交易详情（用于反算持仓）
          const txnRes = await db.collection('transactions').doc(id).get();
          const txn = txnRes.data;

          // 2. 删除交易
          await db.collection('transactions').doc(id).remove();

          // 3. 如果是买卖交易，反算持仓
          if (txn && (txn.type === 'buy' || txn.type === 'sell')) {
            await this.undoHolding(txn);
          }

          wx.hideLoading();
          wx.showToast({ title: '已删除，持仓已修正', icon: 'success' });
          this.reload();
        } catch (err) {
          console.error('[Transactions] delete error:', err);
          wx.hideLoading();
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      },
    });
  },

  /** 删除交易后修正对应持仓 */
  async undoHolding(txn) {
    try {
      const holdingRes = await db.collection('holdings')
        .where({ account_id: txn.account_id, product_code: txn.product_code })
        .limit(1).get();
      const holding = holdingRes.data[0];
      if (!holding) return;

      const shares = Number(txn.shares) || 0;
      const price = Number(txn.price) || 0;
      const curShares = Number(holding.shares) || 0;
      const curPrice = Number(holding.current_price) || 0;

      if (txn.type === 'buy') {
        // 删除买入 → 减去份额，反推加权平均成本
        const newShares = Math.max(0, curShares - shares);
        if (newShares <= 0) {
          await db.collection('holdings').doc(holding._id).update({
            data: { shares: 0, is_cleared: true, updated_at: db.serverDate() },
          });
        } else {
          const oldCostValue = Number(holding.cost_value) || 0;
          const buyCost = shares * price;
          const newCostValue = Math.max(0, oldCostValue - buyCost);
          const newCostPrice = newCostValue / newShares;
          const newMarketValue = newShares * curPrice;
          const pnl = newMarketValue - newCostValue;
          await db.collection('holdings').doc(holding._id).update({
            data: {
              shares: newShares,
              cost_price: Number(newCostPrice.toFixed(4)),
              cost_value: Number(newCostValue.toFixed(2)),
              market_value: Number(newMarketValue.toFixed(2)),
              pnl: Number(pnl.toFixed(2)),
              pnl_percent: newCostValue > 0 ? Number(((pnl / newCostValue) * 100).toFixed(2)) : 0,
              is_cleared: false,
              updated_at: db.serverDate(),
            },
          });
        }
      } else if (txn.type === 'sell') {
        // 删除卖出 → 加回份额，成本价不变
        const newShares = curShares + shares;
        const costPrice = Number(holding.cost_price) || 0;
        const newCostValue = newShares * costPrice;
        const newMarketValue = newShares * curPrice;
        const pnl = newMarketValue - newCostValue;
        await db.collection('holdings').doc(holding._id).update({
          data: {
            shares: newShares,
            is_cleared: false,
            cost_value: Number(newCostValue.toFixed(2)),
            market_value: Number(newMarketValue.toFixed(2)),
            pnl: Number(pnl.toFixed(2)),
            pnl_percent: newCostValue > 0 ? Number(((pnl / newCostValue) * 100).toFixed(2)) : 0,
            updated_at: db.serverDate(),
          },
        });
      }
    } catch (err) {
      console.error('[undoHolding] error:', err);
    }
  },

  /**
   * 单条交易重试同步到持仓
   */
  async syncTransaction(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showLoading({ title: '同步中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'apply_transaction',
        data: { transaction_id: id },
      });
      wx.hideLoading();
      if (res.result && res.result.success) {
        wx.showToast({ title: '同步成功', icon: 'success' });
        this.reload();
      } else {
        wx.showToast({ title: '同步失败：' + (res.result?.message || '未知错误'), icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      const msg = err.errMsg && err.errMsg.indexOf('FUNCTION_NOT_FOUND') >= 0
        ? '请先部署 apply_transaction 云函数'
        : '同步失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  /**
   * 批量同步所有未同步到持仓的交易
   */
  async syncAll() {
    const unapplied = this.data.rawItems.filter(t =>
      (t.type === 'buy' || t.type === 'sell') && !t.applied_holding
    );
    if (unapplied.length === 0) {
      wx.showToast({ title: '没有需要同步的记录', icon: 'none' });
      return;
    }

    wx.showLoading({ title: `同步 ${unapplied.length} 条...`, mask: true });
    this.setData({ syncing: true });
    let success = 0;
    let fail = 0;

    for (const t of unapplied) {
      try {
        const res = await wx.cloud.callFunction({
          name: 'apply_transaction',
          data: { transaction_id: t._id },
        });
        if (res.result && res.result.success) success++;
        else fail++;
      } catch {
        fail++;
      }
    }

    wx.hideLoading();
    this.setData({ syncing: false });
    wx.showToast({
      title: `同步完成：${success} 成功${fail > 0 ? `，${fail} 失败` : ''}`,
      icon: fail > 0 ? 'none' : 'success',
    });
    this.reload();
  },

  /**
   * 长按交易记录 → 底部操作菜单
   */
  onLongPress(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    // 关闭左滑状态
    this.setData({ swipedItemId: '' });
    wx.showActionSheet({
      itemList: ['编辑', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.onEditTransaction(e);
        } else if (res.tapIndex === 1) {
          this.onDeleteTransaction(e);
        }
      },
    });
  },

  /**
   * 左滑手势 → 触摸开始
   */
  onTouchStart(e) {
    this.setData({ touchStartX: e.touches[0].clientX });
  },

  /**
   * 左滑手势 → 触摸结束
   */
  onTouchEnd(e) {
    const { touchStartX, swipedItemId } = this.data;
    const deltaX = e.changedTouches[0].clientX - touchStartX;
    const id = e.currentTarget.dataset.id;

    if (deltaX < -60) {
      // 左滑超过 60px → 展开
      this.setData({ swipedItemId: id });
    } else if (deltaX > 60 && swipedItemId === id) {
      // 右滑超过 60px → 收起
      this.setData({ swipedItemId: '' });
    } else {
      // 点击其他区域 → 收起
      this.setData({ swipedItemId: '' });
    }
  },

  /**
   * 从左滑菜单编辑
   */
  onSwipeEdit(e) {
    this.setData({ swipedItemId: '' });
    this.onEditTransaction(e);
  },

  /**
   * 从左滑菜单删除
   */
  onSwipeDelete(e) {
    this.setData({ swipedItemId: '' });
    this.onDeleteTransaction(e);
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadTransactions();
  },
});
