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
