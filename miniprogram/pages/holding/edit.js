/**
 * 添加/编辑持仓页面
 * 支持产品代码自动补全名称，产品名称搜索建议
 */
const { PRODUCT_TYPES, PRODUCT_TYPE_TREE } = require('../../utils/constants');

Page({
  data: {
    isEdit: false,
    holdingId: '',
    accounts: [],
    accountNames: [],
    accountIndex: 0,
    typeIndex: 0,
    typeNames: [],
    exchangeIndex: 0,
    today: '',
    form: {
      account_id: '',
      product_code: '',
      product_name: '',
      product_type: 'stock',
      exchange: 'SH',
      shares: '',
      cost_price: '',
      buy_date: '',
      note: '',
      // 策略/跟投计划标签
      strategy: '',
      // 单基金费率覆盖（优先级 > 账户层级配置）
      management_fee_rate: '',
      custodian_fee_rate: '',
      advisory_fee_rate: '',
    },
    currentAccountType: '',  // 当前选中账户的类型，用于显示费率覆盖
    suggestions: [],      // 名称搜索建议列表
    codeSuggestions: [],  // 代码查询多匹配列表
    codeLookupHint: '',    // 代码查询提示
    _codeTimer: null,      // 代码输入防抖
    _nameTimer: null,      // 名称输入防抖
  },

  async onLoad(options) {
    // 初始化产品类型
    const typeNames = [];
    PRODUCT_TYPE_TREE.forEach(item => {
      if (item.children) {
        item.children.forEach(c => typeNames.push(`${item.label} - ${c.label}`));
      } else {
        typeNames.push(item.label);
      }
    });
    this.setData({
      typeNames,
      today: new Date().toISOString().split('T')[0],
    });

    // 加载账户列表
    await this.loadAccounts();

    if (options.id) {
      this.setData({ isEdit: true, holdingId: options.id });
      await this.loadHolding(options.id);
    }

    // 如果传入了 account_id 参数，自动选中
    if (options.account_id) {
      const idx = this.data.accounts.findIndex(a => a._id === options.account_id);
      if (idx >= 0) {
        this.setData({
          accountIndex: idx,
          'form.account_id': options.account_id,
        });
      }
    }
  },

  async loadAccounts() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('accounts').get();
      const accounts = res.data || [];
      const names = accounts.map(a => a.name);
      this.setData({ accounts, accountNames: names });
    } catch (err) {
      console.error('[Holding Edit] load accounts error:', err);
    }
  },

  async loadHolding(id) {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('holdings').doc(id).get();
      const h = res.data;
      if (!h) return;

      const accIdx = this.data.accounts.findIndex(a => a._id === h.account_id);
      const acc = this.data.accounts[accIdx] || {};
      this.setData({
        accountIndex: Math.max(0, accIdx),
        exchangeIndex: ['SH', 'SZ', 'HK', 'US'].indexOf(h.exchange) || 0,
        currentAccountType: acc.type || '',
        form: {
          account_id: h.account_id || '',
          product_code: h.product_code || '',
          product_name: h.product_name || '',
          product_type: h.product_type || 'stock',
          exchange: h.exchange || 'SH',
          shares: String(h.shares || ''),
          cost_price: String(h.cost_price || ''),
          buy_date: h.buy_date || '',
          note: h.note || '',
          strategy: h.strategy || '',
          management_fee_rate: h.management_fee_rate != null ? String(h.management_fee_rate) : '',
          custodian_fee_rate: h.custodian_fee_rate != null ? String(h.custodian_fee_rate) : '',
          advisory_fee_rate: h.advisory_fee_rate != null ? String(h.advisory_fee_rate) : '',
        },
      });
    } catch (err) {
      console.error('[Holding Edit] load error:', err);
    }
  },

  /**
   * 产品代码输入 → 防抖查询自动补全产品名
   */
  onCodeInput(e) {
    const code = e.detail.value;
    this.setData({ 'form.product_code': code, codeLookupHint: '', codeSuggestions: [] });

    if (this.data._codeTimer) clearTimeout(this.data._codeTimer);

    if (code.length < 4) return;

    this.data._codeTimer = setTimeout(async () => {
      try {
        const res = await wx.cloud.callFunction({
          name: 'lookup_product',
          data: { code },
        });
        const products = res.result?.products || [];
        if (products.length === 1) {
          const p = products[0];
          this.setData({
            'form.product_name': p.name || '',
            'form.product_type': p.type || this.data.form.product_type,
            'form.exchange': p.exchange || this.data.form.exchange,
            codeLookupHint: `找到: ${p.name} (${p.code})`,
          });
        } else if (products.length > 1) {
          this.setData({
            codeSuggestions: products,
            codeLookupHint: `找到 ${products.length} 个匹配，请选择：`,
          });
        } else {
          this.setData({ codeLookupHint: '未匹配到产品，请手动输入名称' });
        }
      } catch (err) {
        console.error('[onCodeInput] lookup error:', err);
      }
    }, 500);
  },

  /**
   * 产品名称输入 → 防抖搜索建议
   */
  onNameInput(e) {
    const name = e.detail.value;
    this.setData({ 'form.product_name': name });

    if (this.data._nameTimer) clearTimeout(this.data._nameTimer);

    if (name.length < 1) {
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

  /**
   * 选中搜索建议
   */
  onSelectSuggestion(e) {
    const ds = e.currentTarget.dataset;
    this.setData({
      'form.product_code': ds.code || '',
      'form.product_name': ds.name || '',
      'form.product_type': ds.type || 'stock',
      'form.exchange': ds.exchange || 'SH',
      suggestions: [],
      codeLookupHint: '',
    });
  },

  /**
   * 选中代码查询匹配项（多匹配时从下拉列表选择）
   */
  onCodeSuggestionClick(e) {
    const ds = e.currentTarget.dataset;
    this.setData({
      'form.product_code': ds.code || '',
      'form.product_name': ds.name || '',
      'form.product_type': ds.type || 'stock',
      'form.exchange': ds.exchange || 'SH',
      codeSuggestions: [],
      codeLookupHint: '',
    });
  },

  onAccountChange(e) {
    const idx = e.detail.value;
    const acc = this.data.accounts[idx] || {};
    this.setData({
      accountIndex: idx,
      'form.account_id': acc._id || '',
      currentAccountType: acc.type || '',
    });
  },

  onTypeChange(e) {
    const idx = e.detail.value;
    let key = 'stock';
    let counter = 0;
    for (const item of PRODUCT_TYPE_TREE) {
      if (item.children) {
        for (const child of item.children) {
          if (counter === idx) { key = child.key; break; }
          counter++;
        }
      } else {
        if (counter === idx) { key = item.key; break; }
        counter++;
      }
      if (key !== 'stock') break;
    }
    this.setData({ typeIndex: idx, 'form.product_type': key });
  },

  onExchangeChange(e) {
    const exchanges = ['SH', 'SZ', 'HK', 'US'];
    const idx = e.detail.value;
    this.setData({ exchangeIndex: idx, 'form.exchange': exchanges[idx] });
  },

  onDateChange(e) {
    this.setData({ 'form.buy_date': e.detail.value });
  },

  onSharesInput(e) {
    this.setData({ 'form.shares': e.detail.value });
  },

  onCostPriceInput(e) {
    this.setData({ 'form.cost_price': e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ 'form.note': e.detail.value });
  },

  onStrategyInput(e) {
    this.setData({ 'form.strategy': e.detail.value });
  },

  onMgmtFeeInput(e) {
    this.setData({ 'form.management_fee_rate': e.detail.value });
  },

  onCustodianFeeInput(e) {
    this.setData({ 'form.custodian_fee_rate': e.detail.value });
  },

  onAdvisoryFeeInput(e) {
    this.setData({ 'form.advisory_fee_rate': e.detail.value });
  },

  async onSave() {
    if (!this.data.form.account_id) {
      wx.showToast({ title: '请选择账户', icon: 'none' });
      return;
    }
    if (!this.data.form.product_code) {
      wx.showToast({ title: '请输入产品代码', icon: 'none' });
      return;
    }
    if (!this.data.form.shares || parseFloat(this.data.form.shares) <= 0) {
      wx.showToast({ title: '请输入有效份额', icon: 'none' });
      return;
    }
    if (!this.data.form.cost_price || parseFloat(this.data.form.cost_price) <= 0) {
      wx.showToast({ title: '请输入有效成本价', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });
    try {
      const db = wx.cloud.database();
      const shares = parseFloat(this.data.form.shares);
      const costPrice = parseFloat(this.data.form.cost_price);
      const costValue = shares * costPrice;

      const f = this.data.form;
      const data = {
        account_id: f.account_id,
        product_code: f.product_code,
        product_name: f.product_name || f.product_code,
        product_type: f.product_type,
        exchange: f.exchange,
        shares,
        cost_price: costPrice,
        current_price: costPrice,
        cost_value: costValue,
        market_value: costValue,
        pnl: 0,
        pnl_percent: 0,
        buy_date: f.buy_date,
        note: f.note,
        // 策略/跟投计划标签
        strategy: f.strategy || '',
        // 单基金费率覆盖（优先级高于账户层级配置）
        management_fee_rate: parseFloat(f.management_fee_rate) || 0,
        custodian_fee_rate: parseFloat(f.custodian_fee_rate) || 0,
        advisory_fee_rate: parseFloat(f.advisory_fee_rate) || 0,
        updated_at: db.serverDate(),
      };

      if (this.data.isEdit) {
        await db.collection('holdings').doc(this.data.holdingId).update({ data });
      } else {
        await db.collection('holdings').add({
          data: { ...data, created_at: db.serverDate() },
        });
      }

      wx.hideLoading();
      wx.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  typeLabel(type) {
    const t = PRODUCT_TYPES[type?.toUpperCase()];
    return t?.name || type || '股票';
  },
});
