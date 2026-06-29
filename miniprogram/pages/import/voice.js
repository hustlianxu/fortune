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
  dividend: '分红',
  transfer_in: '转入',
  transfer_out: '转出',
  fee: '手续费',
  interest: '利息',
};

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
    sampleText: '3月15号买入1000股招商银行，36块5，手续费5块\n4月20号卖出500股招商银行，38块2\n5月10号买入2000股上证50ETF，2.85\n6月1号招行分红500块',
    sampleJson: '[\n  {\n    "type": "buy",\n    "product_name": "招商银行",\n    "product_code": "600036",\n    "shares": 1000,\n    "price": 36.50,\n    "fee": 5,\n    "amount": 36500,\n    "trade_date": "2025-03-15",\n    "note": ""\n  }\n]',
  },

  onLoad() {
    this.loadAccounts();
  },

  async loadAccounts() {
    try {
      const res = await db.collection('accounts').orderBy('sort_order', 'asc').get();
      const accounts = res.data || [];
      const accountNames = accounts.map(a => a.name || '未命名');
      this.setData({
        accounts,
        accountNames,
        accountIndex: accounts.length > 0 ? 0 : -1,
      });
    } catch (err) {
      console.error('[voice] load accounts error:', err);
    }
  },

  onTabChange(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  onAccountChange(e) {
    this.setData({ accountIndex: parseInt(e.detail.value, 10) });
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
      const trades = (res.trades || []).map(t => ({
        ...t,
        typeLabel: TYPE_LABELS[t.type] || t.type,
        amountText: t.amount.toFixed(2),
        feeText: t.fee > 0 ? `（手续费 ¥${t.fee.toFixed(2)}）` : '',
      }));
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

  /** 确认导入：用解析后的 trades 走 mode=json 写入 */
  async onConfirmImport() {
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
            amount: t.amount,
            trade_date: t.trade_date,
            note: t.note,
          }));
          const result = await wx.cloud.callFunction({
            name: 'parse_trades_by_text',
            data: {
              mode: 'json',
              json: cleanTrades,
              account_id,
              dry_run: false,
            },
          });
          wx.hideLoading();
          const res = result.result || {};
          if (res.success) {
            wx.showModal({
              title: '导入完成',
              content: res.message || `成功导入 ${res.imported || 0} 笔`,
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
