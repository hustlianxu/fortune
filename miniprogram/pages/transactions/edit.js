/**
 * 添加/编辑交易流水
 * 支持选择账户、交易类型、产品代码自动补全、金额自动计算
 */
const { TRANSACTION_TYPES } = require('../../utils/constants');

const db = wx.cloud.database();

Page({
  data: {
    isEdit: false,
    transactionId: '',
    accounts: [],
    accountNames: [],
    accountIndex: 0,
    typeNames: [],
    typeKeys: [],
    typeIndex: 0,
    today: '',
    form: {
      account_id: '',
      type: 'buy',
      product_code: '',
      product_name: '',
      shares: '',
      price: '',
      amount: '',
      trade_date: '',
      note: '',
    },
    suggestions: [],        // 产品名搜索建议
    _nameTimer: null,
  },

  async onLoad(options) {
    // 初始化交易类型 picker
    const typeNames = TRANSACTION_TYPES.map(t => t.name);
    const typeKeys = TRANSACTION_TYPES.map(t => t.key);
    const today = new Date().toISOString().split('T')[0];

    this.setData({
      typeNames,
      typeKeys,
      today,
      'form.trade_date': today,
    });

    await this.loadAccounts();

    // 编辑模式：加载已有记录
    if (options.id) {
      this.setData({ isEdit: true, transactionId: options.id });
      await this.loadTransaction(options.id);
    } else {
      // 新增模式：从 url 带入预填字段（来自持仓详情的「记一笔」）
      const patch = {};
      if (options.account_id) {
        const idx = this.data.accounts.findIndex(a => a._id === options.account_id);
        if (idx >= 0) {
          patch.accountIndex = idx;
          patch['form.account_id'] = options.account_id;
        }
      }
      if (options.product_code) patch['form.product_code'] = decodeURIComponent(options.product_code);
      if (options.product_name) patch['form.product_name'] = decodeURIComponent(options.product_name);
      // 从持仓详情进入时，默认选中「买入」
      if (options.from === 'holding' && options.product_code) {
        const buyIdx = typeKeys.indexOf('buy');
        if (buyIdx >= 0) {
          patch.typeIndex = buyIdx;
          patch['form.type'] = 'buy';
        }
      }
      if (Object.keys(patch).length) this.setData(patch);
    }
  },

  async loadAccounts() {
    try {
      const res = await db.collection('accounts').orderBy('sort_order', 'asc').get();
      const accounts = res.data || [];
      const accountNames = accounts.map(a => a.name || '未命名');
      this.setData({ accounts, accountNames });
      // 默认选中第一个账户（仅新增模式且未指定账户时）
      if (!this.data.isEdit && !this.data.form.account_id && accounts.length > 0) {
        this.setData({
          accountIndex: 0,
          'form.account_id': accounts[0]._id,
        });
      }
    } catch (err) {
      console.error('[Transaction Edit] load accounts error:', err);
    }
  },

  async loadTransaction(id) {
    try {
      const res = await db.collection('transactions').doc(id).get();
      const t = res.data;
      if (!t) return;
      const accIdx = this.data.accounts.findIndex(a => a._id === t.account_id);
      const typeIdx = this.data.typeKeys.indexOf(t.type);
      this.setData({
        accountIndex: Math.max(0, accIdx),
        typeIndex: Math.max(0, typeIdx),
        form: {
          account_id: t.account_id || '',
          type: t.type || 'buy',
          product_code: t.product_code || '',
          product_name: t.product_name || '',
          shares: t.shares != null ? String(t.shares) : '',
          price: t.price != null ? String(t.price) : '',
          amount: t.amount != null ? String(t.amount) : '',
          trade_date: t.trade_date || '',
          note: t.note || '',
        },
      });
    } catch (err) {
      console.error('[Transaction Edit] load error:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onAccountChange(e) {
    const idx = parseInt(e.detail.value, 10);
    this.setData({
      accountIndex: idx,
      'form.account_id': this.data.accounts[idx]?._id || '',
    });
  },

  onTypeChange(e) {
    const idx = parseInt(e.detail.value, 10);
    this.setData({
      typeIndex: idx,
      'form.type': this.data.typeKeys[idx] || 'buy',
    });
  },

  onCodeInput(e) {
    const code = e.detail.value;
    this.setData({ 'form.product_code': code });
  },

  /**
   * 产品名称输入 → 防抖搜索建议
   */
  onNameInput(e) {
    const name = e.detail.value;
    this.setData({ 'form.product_name': name });

    if (this.data._nameTimer) clearTimeout(this.data._nameTimer);
    if (!name || name.length < 1) {
      this.setData({ suggestions: [] });
      return;
    }
    this.data._nameTimer = setTimeout(async () => {
      try {
        const res = await wx.cloud.callFunction({
          name: 'lookup_product',
          data: { name },
        });
        const products = res.result?.products || [];
        this.setData({ suggestions: products.slice(0, 6) });
      } catch (err) {
        console.error('[onNameInput] search error:', err);
      }
    }, 300);
  },

  onSelectSuggestion(e) {
    const ds = e.currentTarget.dataset;
    this.setData({
      'form.product_code': ds.code || '',
      'form.product_name': ds.name || '',
      suggestions: [],
    });
  },

  onSharesInput(e) {
    const v = e.detail.value;
    this.setData({ 'form.shares': v });
    this.recomputeAmount();
  },

  onPriceInput(e) {
    const v = e.detail.value;
    this.setData({ 'form.price': v });
    this.recomputeAmount();
  },

  onAmountInput(e) {
    this.setData({ 'form.amount': e.detail.value });
  },

  /**
   * 当 shares/price 都有效时，自动计算 amount = shares * price
   */
  recomputeAmount() {
    const shares = parseFloat(this.data.form.shares);
    const price = parseFloat(this.data.form.price);
    if (!isNaN(shares) && !isNaN(price)) {
      const amount = (shares * price).toFixed(2);
      this.setData({ 'form.amount': amount });
    }
  },

  onDateChange(e) {
    this.setData({ 'form.trade_date': e.detail.value });
  },

  async onSave() {
    const { form, isEdit, transactionId } = this.data;
    if (!form.account_id) {
      wx.showToast({ title: '请选择账户', icon: 'none' });
      return;
    }
    if (!form.trade_date) {
      wx.showToast({ title: '请选择交易日期', icon: 'none' });
      return;
    }

    // 转入/转出/手续费/利息 允许只有金额；买入/卖出/分红建议填写产品+份额
    const type = form.type;
    const isTrade = (type === 'buy' || type === 'sell');
    if (isTrade && !form.product_code) {
      wx.showToast({ title: '请输入产品代码', icon: 'none' });
      return;
    }

    const amount = parseFloat(form.amount);
    if (isNaN(amount) || amount <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' });
      return;
    }

    const shares = form.shares ? parseFloat(form.shares) : 0;
    const price = form.price ? parseFloat(form.price) : 0;

    wx.showLoading({ title: '保存中...' });
    try {
      const data = {
        account_id: form.account_id,
        type,
        product_code: form.product_code || '',
        product_name: form.product_name || '',
        shares,
        price,
        amount,
        trade_date: form.trade_date,
        note: form.note || '',
        updated_at: db.serverDate(),
      };

      let newTxnId = '';
      if (isEdit) {
        await db.collection('transactions').doc(transactionId).update({ data });
        newTxnId = transactionId;
      } else {
        const addRes = await db.collection('transactions').add({
          data: { ...data, created_at: db.serverDate(), applied_holding: false },
        });
        newTxnId = addRes._id;
      }

      wx.hideLoading();

      // 新增的买卖交易自动应用到持仓（加权平均成本）；编辑/非买卖不自动应用
      if (!isEdit && (type === 'buy' || type === 'sell')) {
        try {
          const applyRes = await wx.cloud.callFunction({
            name: 'apply_transaction',
            data: { transaction_id: newTxnId },
          });
          if (applyRes.result && applyRes.result.success) {
            wx.showToast({ title: '已记录并同步持仓', icon: 'success' });
          } else {
            wx.showToast({ title: '已记录', icon: 'success' });
          }
        } catch (applyErr) {
          console.warn('[Transaction Edit] apply failed:', applyErr);
          wx.showToast({ title: '已记录（持仓同步失败）', icon: 'none' });
        }
      } else {
        wx.showToast({ title: '保存成功', icon: 'success' });
      }
      setTimeout(() => wx.navigateBack(), 900);
    } catch (err) {
      console.error('[Transaction Edit] save error:', err);
      wx.hideLoading();
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  async onDelete() {
    if (!this.data.isEdit) return;
    const res = await new Promise(resolve => {
      wx.showModal({
        title: '删除确认',
        content: '确定要删除这条交易记录吗？',
        success: r => resolve(r.confirm),
      });
    });
    if (!res) return;

    wx.showLoading({ title: '删除中...' });
    try {
      await db.collection('transactions').doc(this.data.transactionId).remove();
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (err) {
      console.error('[Transaction Edit] delete error:', err);
      wx.hideLoading();
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },
});
