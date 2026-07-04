/**
 * 语音/文字录入交易页面
 * - 文字 Tab：粘贴自然语言 → AI 解析 → 预览 → 批量导入
 * - JSON  Tab：粘贴外部 LLM 已解析的 JSON → 校验 → 批量导入
 *
 * 详见 docs/06-大模型语音导入指南.md
 */
const api = require('../../utils/api');

const db = wx.cloud.database();

const TYPE_LABELS = {
  buy: '买入',
  sell: '卖出',
  ipo_win: '打新中签',
  dividend: '分红',
  stock_dividend: '红股入账',
  split: '拆分/合并',
  tax: '纳税',
  transfer_in: '银证转入',
  transfer_out: '银证转出',
  fee: '手续费',
  interest: '利息',
};

const TYPE_KEYS = ['buy', 'sell', 'ipo_win', 'dividend', 'stock_dividend', 'split', 'tax', 'transfer_in', 'transfer_out', 'fee', 'interest'];
const TYPE_NAME_LIST = TYPE_KEYS.map(k => TYPE_LABELS[k]);

Page({
  data: {
    activeTab: 'text',     // 'text' | 'json'
    accounts: [],
    accountNames: [],
    accountIndex: 0,
    textInput: '',         // 自然语言输入
    jsonInput: '',         // JSON 输入
    parsing: false,
    importing: false,
    parsedTrades: [],      // 解析结果（预览用）
    warnings: [],
    sampleText: '3月15号买入1000股招商银行，36块5，手续费5块\n4月20号卖出500股招商银行，38块2\n5月10号买入2000股上证50ETF，2.85\n6月1号招行分红500块\n7月15号茅台10送1股红股\n8月2号通信ETF 1拆3\n9月20号打新中签某新股500股，发行价12块5',
    sampleJson: '[\n  {\n    "type": "buy",\n    "product_name": "招商银行",\n    "product_code": "600036",\n    "shares": 1000,\n    "price": 36.50,\n    "fee": 5,\n    "amount": 36500,\n    "ratio": 0,\n    "trade_date": "2025-03-15",\n    "note": ""\n  },\n  {\n    "type": "stock_dividend",\n    "product_name": "贵州茅台",\n    "product_code": "600519",\n    "shares": 100,\n    "price": 0,\n    "amount": 0,\n    "fee": 0,\n    "ratio": 0,\n    "trade_date": "2025-07-15",\n    "note": "10送1"\n  },\n  {\n    "type": "split",\n    "product_name": "通信ETF",\n    "product_code": "515880",\n    "shares": 0,\n    "price": 0,\n    "amount": 0,\n    "fee": 0,\n    "ratio": 3,\n    "trade_date": "2025-08-02",\n    "note": "1拆3"\n  }\n]',
    // 编辑弹层
    editVisible: false,
    editIndex: -1,
    editTrade: null,
    editTypeIndex: 0,
    editTypeNames: TYPE_NAME_LIST,
  },

  onLoad() {
    this.loadAccounts();
  },

  async loadAccounts() {
    try {
      const res = await db.collection('accounts').orderBy('sort_order', 'asc').get();
      const accounts = res.data || [];
      const accountNames = accounts.map(a => a.name || '未命名');
      // 恢复上次选择的账户
      let savedIdx = 0;
      try {
        const saved = wx.getStorageSync('voice_last_account_idx');
        if (saved !== undefined && saved !== null && accounts[saved]) savedIdx = saved;
      } catch (e) {}
      this.setData({
        accounts,
        accountNames,
        accountIndex: accounts.length > 0 ? savedIdx : -1,
      });
    } catch (err) {
      console.error('[voice] load accounts error:', err);
    }
  },

  onTabChange(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  onAccountChange(e) {
    const idx = parseInt(e.detail.value, 10);
    this.setData({ accountIndex: idx });
    try { wx.setStorageSync('voice_last_account_idx', idx); } catch (e) {}
  },

  onTextInput(e) {
    this.setData({ textInput: e.detail.value });
  },

  onJsonInput(e) {
    this.setData({ jsonInput: e.detail.value });
  },

  onFillSample() {
    if (this.data.activeTab === 'text') {
      this.setData({ textInput: this.data.sampleText });
    } else {
      this.setData({ jsonInput: this.data.sampleJson });
    }
  },

  onClearInput() {
    if (this.data.activeTab === 'text') {
      this.setData({ textInput: '' });
    } else {
      this.setData({ jsonInput: '' });
    }
  },

  /** 解析（dry_run=true）：仅解析不写入，预览结果 */
  async onParse() {
    if (this.data.accountIndex < 0 || !this.data.accounts[this.data.accountIndex]) {
      wx.showToast({ title: '请先选择账户', icon: 'none' });
      return;
    }
    const account_id = this.data.accounts[this.data.accountIndex]._id;

    if (this.data.activeTab === 'text') {
      if (!this.data.textInput.trim()) {
        wx.showToast({ title: '请输入文字', icon: 'none' });
        return;
      }
      await this.callParse({
        mode: 'text',
        text: this.data.textInput,
        account_id,
        dry_run: true,
      });
    } else {
      if (!this.data.jsonInput.trim()) {
        wx.showToast({ title: '请输入 JSON', icon: 'none' });
        return;
      }
      await this.callParse({
        mode: 'json',
        json: this.data.jsonInput,
        account_id,
        dry_run: true,
      });
    }
  },

  async callParse(params) {
    this.setData({ parsing: true, warnings: [] });
    wx.showLoading({ title: 'AI 解析中...', mask: true });
    try {
      const result = await wx.cloud.callFunction({
        name: 'parse_trades_by_text',
        data: params,
      });
      wx.hideLoading();
      const res = result.result || {};
      if (!res.success) {
        wx.showModal({
          title: '解析失败',
          content: res.message || '请稍后重试',
          showCancel: false,
        });
        this.setData({ parsing: false });
        return;
      }
      const trades = (res.trades || []).map((t, i) => {
        // 展示金额：split/stock_dividend 无现金流，展示 ratio 或份额
        let amountText = t.amount.toFixed(2);
        if (t.type === 'split' && t.ratio) {
          amountText = t.ratio > 1 ? `1拆${t.ratio}` : `${(1/t.ratio).toFixed(0)}合1`;
        } else if (t.type === 'stock_dividend') {
          amountText = `送 ${t.shares} 股`;
        }
        return {
          ...t,
          uid: 't' + Date.now() + '_' + i,
          typeLabel: TYPE_LABELS[t.type] || t.type,
          amountText,
          feeText: t.fee > 0 ? `（手续费 ¥${t.fee.toFixed(2)}）` : '',
        };
      });
      this.setData({
        parsedTrades: trades,
        warnings: res.warnings || [],
        parsing: false,
      });
      if (trades.length === 0) {
        wx.showToast({ title: '未解析出交易', icon: 'none' });
      } else {
        wx.showToast({ title: `解析出 ${trades.length} 笔`, icon: 'success' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[voice] parse error:', err);
      const msg = err.errMsg && err.errMsg.indexOf('FUNCTION_NOT_FOUND') >= 0
        ? '云函数未部署，请先上传 parse_trades_by_text'
        : '解析失败，请稍后重试';
      wx.showModal({ title: '错误', content: msg, showCancel: false });
      this.setData({ parsing: false });
    }
  },

  /** 删除预览列表中的一项 */
  onRemoveTrade(e) {
    const idx = e.currentTarget.dataset.index;
    const list = this.data.parsedTrades.slice();
    list.splice(idx, 1);
    this.setData({ parsedTrades: list });
  },

  /** 打开编辑弹层 */
  onEditTrade(e) {
    const idx = e.currentTarget.dataset.index;
    const trade = this.data.parsedTrades[idx];
    if (!trade) return;
    const typeIndex = TYPE_KEYS.indexOf(trade.type);
    this.setData({
      editVisible: true,
      editIndex: idx,
      editTrade: { ...trade },
      editTypeIndex: typeIndex >= 0 ? typeIndex : 0,
    });
  },

  onEditTypeChange(e) {
    const typeIndex = parseInt(e.detail.value, 10);
    this.setData({
      editTypeIndex: typeIndex,
      editTrade: { ...this.data.editTrade, type: TYPE_KEYS[typeIndex], typeLabel: TYPE_NAME_LIST[typeIndex] },
    });
  },

  onEditField(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`editTrade.${field}`]: e.detail.value });
  },

  onCancelEdit() {
    this.setData({ editVisible: false, editIndex: -1, editTrade: null });
  },

  /** 保存编辑：校验并回写到 parsedTrades，重算展示字段 */
  onSaveEdit() {
    const t = this.data.editTrade;
    if (!t) return;
    const idx = this.data.editIndex;
    // 数值字段转换
    const shares = Number(t.shares) || 0;
    const price = Number(t.price) || 0;
    const fee = Number(t.fee) || 0;
    const ratio = Number(t.ratio) || 0;
    let amount = Number(t.amount);
    if (isNaN(amount)) amount = 0;
    // 买卖/打新中签缺金额时按份额×单价补全
    if ((t.type === 'buy' || t.type === 'sell' || t.type === 'ipo_win') && amount === 0 && shares > 0 && price > 0) {
      amount = shares * price;
    }
    const tradeDate = String(t.trade_date || '');
    if (tradeDate && !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      wx.showToast({ title: '日期格式应为 YYYY-MM-DD', icon: 'none' });
      return;
    }
    // 与 callParse 一致的展示口径：split/stock_dividend 无现金流，展示 ratio 或份额
    let amountText = amount.toFixed(2);
    if (t.type === 'split' && ratio > 0) {
      amountText = ratio > 1 ? `1拆${ratio}` : `${(1 / ratio).toFixed(0)}合1`;
    } else if (t.type === 'stock_dividend' && shares > 0) {
      amountText = `送 ${shares} 股`;
    }
    const updated = {
      ...t,
      shares,
      price,
      fee,
      ratio,
      amount: Number(amount.toFixed(2)),
      trade_date: tradeDate,
      typeLabel: TYPE_LABELS[t.type] || t.type,
      amountText,
      feeText: fee > 0 ? `（手续费 ¥${fee.toFixed(2)}）` : '',
    };
    const list = this.data.parsedTrades.slice();
    list[idx] = updated;
    this.setData({ parsedTrades: list, editVisible: false, editIndex: -1, editTrade: null });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  /** 确认导入：用解析后的 trades 走 mode=json 写入 */
  async onConfirmImport() {
    if (this.data.importing) return;       // 防止按钮被双击导致重复导入
    if (this.data.parsedTrades.length === 0) {
      wx.showToast({ title: '没有可导入的交易', icon: 'none' });
      return;
    }
    if (this.data.accountIndex < 0) {
      wx.showToast({ title: '请先选择账户', icon: 'none' });
      return;
    }
    const account_id = this.data.accounts[this.data.accountIndex]._id;

    wx.showModal({
      title: '确认导入',
      content: `将导入 ${this.data.parsedTrades.length} 笔交易到「${this.data.accountNames[this.data.accountIndex]}」账户，并自动同步持仓。是否继续？`,
      success: async (r) => {
        if (!r.confirm) return;
        // 立即锁定按钮，避免模态弹层关闭后用户再次点击造成重复提交
        this.setData({ importing: true });
        wx.showLoading({ title: '导入中...', mask: true });
        try {
          // 去掉预览用的展示字段，恢复纯 ParsedTrade 结构
          const cleanTrades = this.data.parsedTrades.map(t => ({
            type: t.type,
            product_name: t.product_name,
            product_code: t.product_code,
            product_type: t.product_type,
            exchange: t.exchange,
            shares: t.shares,
            price: t.price,
            fee: t.fee,
            ratio: t.ratio || 0,
            amount: t.amount,
            trade_date: t.trade_date,
            note: t.note,
          }));
          // 生成一次性 request_id：作为云函数幂等去重 key，避免双击/网络重试导致重复持仓
          const request_id = 'imp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
          const result = await wx.cloud.callFunction({
            name: 'parse_trades_by_text',
            data: {
              mode: 'json',
              json: cleanTrades,
              account_id,
              dry_run: false,
              request_id,
            },
            timeout: 60000,
          });
          wx.hideLoading();
          const res = result.result || {};
          if (res.success) {
            let content = res.message || `成功导入 ${res.imported || 0} 笔`;
            if (res.deduped) {
              content = '本次导入已存在，未重复写入（已自动跳过）';
            }
            // 明确区分「交易写入数」和「持仓应用数」，让用户知道持仓是否已同步
            if (!res.deduped && res.imported > 0) {
              const appliedCount = res.applied;
              if (typeof appliedCount === 'number') {
                if (appliedCount > 0) {
                  content = `✓ 已写入 ${res.imported} 笔交易，已更新 ${appliedCount} 个持仓`;
                } else {
                  content = `✓ 已写入 ${res.imported} 笔交易，但持仓未自动更新。请到持仓详情页点「重建」修复。`;
                }
              }
            }
            if (res.warnings && res.warnings.length > 0) {
              content += '\n\n注意事项：\n' + res.warnings.slice(0, 5).map(w => '• ' + w).join('\n');
            }
            wx.showModal({
              title: res.deduped ? '已跳过重复导入' : '导入完成',
              content: content,
              showCancel: false,
              success: () => {
                // 清空并返回
                this.setData({
                  parsedTrades: [],
                  warnings: [],
                  textInput: '',
                  jsonInput: '',
                  importing: false,
                });
                wx.navigateBack();
              },
            });
          } else {
            this.setData({ importing: false });
            wx.showModal({
              title: '导入失败',
              content: res.message || '请稍后重试',
              showCancel: false,
            });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[voice] import error:', err);
          this.setData({ importing: false });
          wx.showModal({ title: '导入失败', content: '请稍后重试', showCancel: false });
        }
      },
    });
  },

  /** 跳到 LLM 设置页 */
  onGoToLLMSettings() {
    wx.navigateTo({ url: '/pages/settings/llm/index' });
  },
});
