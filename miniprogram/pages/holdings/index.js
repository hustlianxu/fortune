/**
 * 持仓列表页面
 */
const api = require('../../utils/api');
const { formatMoney, formatQuantity } = require('../../utils/format');
const { PRODUCT_TYPES } = require('../../utils/constants');

// 行业刷新任务的每批大小（与云函数 BATCH_SIZE 对齐，保证单次调用不超时）
const INDUSTRY_BATCH = 8;

Page({
  data: {
    accountList: [],
    strategyList: [],         // 策略汇总 [{ name, holdingCount, marketValue, costValue, pnl, pnlPercent }]
    allSummary: {             // 「全部」策略卡的汇总数据（避免硬编码 0 导致显示错位）
      marketValue: 0,
      pnl: 0,
      pnlPercent: 0,
      holdingCount: 0,
    },
    selectedStrategy: '',     // 当前筛选的策略名，''=全部
    hideCleared: false,       // 隐藏已清仓持仓
    // ═══════ 行业刷新任务状态 ═══════
    industryTask: {
      show: false,            // 是否显示任务面板
      running: false,         // 是否正在运行
      total: 0,               // 待处理总数
      processed: 0,           // 已处理数
      updated: 0,             // 成功分类数
      failed: 0,              // 失败数
      log: '',                // 进度文案
    },
    _stopFlag: false,         // 停止标志位（任务循环每批前检查）
    // ═══════ 已清理数据面板（持仓删除后保留的交易，可恢复）═══════
    clearedPanel: {
      show: false,
      loading: false,
      groups: [],             // [{ account_id, product_code, product_name, account_name, count, latest_date, txnIds }]
    },
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    try {
      const summary = await api.getPortfolioSummary();
      const accounts = (summary.accounts || []).map(acc => {
        let holdings = acc.holdings || [];
        if (this.data.hideCleared) {
          holdings = holdings.filter(h => !h.is_cleared && (Number(h.shares) || 0) > 0);
        }
        return {
          ...acc,
          expanded: true,
          visible: true,
          displayHoldings: holdings,
        };
      });
      this.setData({
        accountList: accounts,
        strategyList: summary.strategySummaries || [],
        allSummary: {
          marketValue: summary.totalMarketValue || 0,
          pnl: summary.totalAllPnL || summary.totalPnL || 0,   // 优先总收益口径
          pnlPercent: summary.totalAllPnLPercent || summary.totalPnLPercent || 0,
          holdingCount: summary.holdingCount || 0,
        },
      });
    } catch (err) {
      console.error('[Holdings] load error:', err);
    }
  },

  /**
   * 根据 selectedStrategy 重新计算每个 account 的 visible 和 displayHoldings
   */
  applyFilter() {
    const { accountList, selectedStrategy, hideCleared } = this.data;
    this.setData({
      accountList: accountList.map(acc => {
        let base = acc.holdings || [];
        if (hideCleared) {
          base = base.filter(h => !h.is_cleared && (Number(h.shares) || 0) > 0);
        }
        if (!selectedStrategy) {
          return { ...acc, visible: true, displayHoldings: base };
        }
        const filtered = base.filter(h =>
          (h.strategy || '').trim() === selectedStrategy
        );
        return {
          ...acc,
          visible: filtered.length > 0,
          displayHoldings: filtered,
        };
      }),
    });
  },

  /** 切换隐藏已清仓持仓 */
  onToggleHideCleared() {
    this.setData({ hideCleared: !this.data.hideCleared }, () => {
      this.loadData();
    });
  },

  /** 切换策略筛选 */
  onStrategyFilter(e) {
    const name = e.currentTarget.dataset.name || '';
    const next = name === this.data.selectedStrategy ? '' : name;
    this.setData({ selectedStrategy: next }, () => {
      this.applyFilter();
    });
  },

  onToggleAccount(e) {
    const id = e.currentTarget.dataset.id;
    const list = this.data.accountList.map(a => {
      if (a._id === id) return { ...a, expanded: !a.expanded };
      return a;
    });
    this.setData({ accountList: list });
  },

  onHoldingTap(e) {
    const holding = e.currentTarget.dataset.holding;
    wx.navigateTo({
      url: `/pages/holding/detail?id=${holding._id}`,
    });
  },

  /** 跳转多维度分析页 */
  onGoAnalysis() {
    wx.navigateTo({
      url: '/pages/analysis/index',
    });
  },

  // ═══════ 行业分类刷新任务 ═══════

  /**
   * 打开行业刷新任务面板（仅显示，不自动开始）
   * 先统计当前待处理持仓数（industry 为空且未关闭自动刷新的）
   */
  async onOpenIndustryTask() {
    this.setData({ 'industryTask.show': true, _stopFlag: false });
    await this._refreshIndustryTaskStats();
  },

  /** 关闭任务面板（若正在运行则先停止） */
  onCloseIndustryTask() {
    this._stopFlag = true;
    this.setData({ _stopFlag: true, 'industryTask.show': false, 'industryTask.running': false });
  },

  /** 统计待处理持仓数并刷新面板 */
  async _refreshIndustryTaskStats() {
    try {
      const all = await api.getHoldings();
      const targets = all.filter(h => h.product_code
        && h.industry_auto_refresh !== false
        && (!h.industry || String(h.industry).trim() === ''));
      this.setData({
        'industryTask.total': targets.length,
        'industryTask.processed': 0,
        'industryTask.updated': 0,
        'industryTask.failed': 0,
        'industryTask.log': targets.length > 0
          ? `待分类 ${targets.length} 只持仓，点击「开始」启动 AI 推断`
          : '没有需要分类的持仓（全部已有行业或已关闭自动刷新）',
      });
    } catch (err) {
      console.error('[IndustryTask] stats error:', err);
      this.setData({ 'industryTask.log': '统计失败：' + (err.message || err) });
    }
  },

  /**
   * 启动行业刷新任务
   * 策略：前端循环，每批 INDUSTRY_BATCH 个持仓调用一次 infer_industry 云函数
   * 通过 _stopFlag 控制可随时停止
   */
  async onStartIndustryTask() {
    if (this.data.industryTask.running) return;
    this._stopFlag = false;
    this.setData({ _stopFlag: false, 'industryTask.running': true });

    try {
      const all = await api.getHoldings();
      // 仅处理 industry 为空 + 未关闭自动刷新的持仓
      const targets = all.filter(h => h.product_code
        && h.industry_auto_refresh !== false
        && (!h.industry || String(h.industry).trim() === ''));
      const total = targets.length;
      let processed = 0;
      let updated = 0;
      let failed = 0;

      this.setData({
        'industryTask.total': total,
        'industryTask.processed': 0,
        'industryTask.updated': 0,
        'industryTask.failed': 0,
        'industryTask.log': total === 0 ? '没有需要分类的持仓' : `开始推断 0/${total}...`,
      });

      if (total === 0) {
        this.setData({ 'industryTask.running': false });
        return;
      }

      // 分批调用云函数（每批传入 holding_ids，only_missing=true 不覆盖已有值）
      for (let i = 0; i < total; i += INDUSTRY_BATCH) {
        // 每批前检查停止标志
        if (this._stopFlag) {
          this.setData({
            'industryTask.running': false,
            'industryTask.log': `已停止（已处理 ${processed}/${total}，成功 ${updated}，失败 ${failed}）`,
          });
          return;
        }

        const batch = targets.slice(i, i + INDUSTRY_BATCH);
        const batchIds = batch.map(h => h._id);
        this.setData({
          'industryTask.log': `推断中 ${processed}/${total}（第 ${Math.floor(i / INDUSTRY_BATCH) + 1} 批，${batch.length} 只）...`,
        });

        try {
          const res = await api.inferIndustry({
            holding_ids: batchIds,
            only_missing: true,
          });
          if (res && res.success) {
            updated += res.updated || 0;
            failed += res.failed || 0;
          } else {
            failed += batch.length;
          }
        } catch (err) {
          console.error('[IndustryTask] batch error:', err);
          // 检测云函数未部署（errCode -501000 / FUNCTION_NOT_FOUND）
          // 此时继续下一批也会失败，提前终止并给出明确指引
          const errMsg = (err && (err.errMsg || err.message)) || '';
          if (errMsg.indexOf('FUNCTION_NOT_FOUND') >= 0
            || errMsg.indexOf('could not be found') >= 0
            || errMsg.indexOf('-501000') >= 0) {
            this.setData({
              _stopFlag: true,
              'industryTask.running': false,
              'industryTask.log': 'infer_industry 云函数未部署，请在开发者工具右键 cloudfunctions/infer_industry 上传并部署',
            });
            wx.showModal({
              title: '云函数未部署',
              content: '行业分类需要 infer_industry 云函数。请在微信开发者工具中右键 cloudfunctions/infer_industry 文件夹，选择「上传并部署：云端安装依赖」后重试。',
              showCancel: false,
            });
            return;
          }
          failed += batch.length;
        }

        processed += batch.length;
        const pct = total > 0 ? Math.round(processed / total * 100) : 100;
        this.setData({
          'industryTask.processed': processed,
          'industryTask.updated': updated,
          'industryTask.failed': failed,
          'industryTask.log': `已处理 ${processed}/${total}（${pct}%）· 成功 ${updated} · 失败 ${failed}`,
        });
      }

      this.setData({
        'industryTask.running': false,
        'industryTask.log': `完成：${updated}/${total} 已分类 · 失败 ${failed}`,
      });
      // 任务完成后刷新持仓列表
      this.loadData();
      wx.showToast({ title: `已分类 ${updated} 只`, icon: 'success' });
    } catch (err) {
      console.error('[IndustryTask] error:', err);
      this.setData({
        'industryTask.running': false,
        'industryTask.log': '任务异常：' + (err.message || err),
      });
    }
  },

  /** 停止行业刷新任务 */
  onStopIndustryTask() {
    this._stopFlag = true;
    this.setData({ _stopFlag: true, 'industryTask.running': false, 'industryTask.log': '正在停止...' });
  },

  // ═══════ 已清理数据（持仓删除后保留的交易，可恢复）═══════

  /** 打开「已清理数据」面板 */
  async onOpenCleared() {
    this.setData({ 'clearedPanel.show': true, 'clearedPanel.loading': true, 'clearedPanel.groups': [] });
    await this.loadClearedData();
  },

  /** 关闭面板 */
  onCloseCleared() {
    this.setData({ 'clearedPanel.show': false });
  },

  /** 查询所有 holding_deleted:true 的交易，按 (account,product) 分组 */
  async loadClearedData() {
    try {
      const db = wx.cloud.database();
      // 拉取账户名映射
      let accMap = {};
      try {
        const accRes = await db.collection('accounts').get();
        (accRes.data || []).forEach(a => { accMap[a._id] = a.name || '未命名'; });
      } catch (e) {}

      // 查询被标记为 holding_deleted 的交易（客户端单次最多 100 条）
      const res = await db.collection('transactions')
        .where({ holding_deleted: true })
        .orderBy('trade_date', 'desc')
        .limit(100)
        .get();
      const txns = res.data || [];

      // 按 (account_id, product_code) 分组
      const groupMap = {};
      for (const t of txns) {
        const key = (t.account_id || '') + '|' + (t.product_code || '');
        if (!groupMap[key]) {
          groupMap[key] = {
            account_id: t.account_id || '',
            product_code: t.product_code || '',
            product_name: t.product_name || t.product_code || '未知',
            account_name: accMap[t.account_id] || '未知账户',
            count: 0,
            latest_date: '',
            txnIds: [],
          };
        }
        const g = groupMap[key];
        g.count++;
        g.txnIds.push(t._id);
        if (t.trade_date && t.trade_date > g.latest_date) {
          g.latest_date = t.trade_date;
        }
      }
      const groups = Object.values(groupMap).sort((a, b) => b.latest_date.localeCompare(a.latest_date));
      this.setData({ 'clearedPanel.groups': groups, 'clearedPanel.loading': false });
    } catch (err) {
      console.error('[Cleared] load error:', err);
      this.setData({ 'clearedPanel.loading': false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  /** 恢复一组已清理的交易：取消 holding_deleted 标记 → 重建持仓 */
  onRestoreCleared(e) {
    const idx = e.currentTarget.dataset.index;
    const group = this.data.clearedPanel.groups[idx];
    if (!group) return;

    wx.showModal({
      title: '确认恢复',
      content: `将恢复「${group.product_name}」（${group.account_name}）的 ${group.count} 笔交易并重建持仓？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '恢复中...', mask: true });
        try {
          const db = wx.cloud.database();
          // 1. 取消 holding_deleted 标记
          for (const tid of group.txnIds) {
            try {
              await db.collection('transactions').doc(tid).update({
                data: { holding_deleted: false, updated_at: db.serverDate() },
              });
            } catch (e) {
              console.warn('[Cleared] unmark txn failed:', tid, e);
            }
          }
          // 2. 重建该 product 的持仓
          try {
            await wx.cloud.callFunction({
              name: 'rebuild_holdings',
              data: { account_id: group.account_id, product_code: group.product_code },
            });
          } catch (e) {
            console.warn('[Cleared] rebuild failed:', e);
          }
          // 3. 从面板移除该组
          const newGroups = this.data.clearedPanel.groups.filter((_, i) => i !== idx);
          this.setData({ 'clearedPanel.groups': newGroups });
          wx.hideLoading();
          wx.showToast({ title: '已恢复', icon: 'success' });
          // 4. 刷新持仓列表
          this.loadData();
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: '恢复失败', icon: 'none' });
          console.error('[Cleared] restore error:', err);
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

  formatMoney,
  formatQuantity,
});
