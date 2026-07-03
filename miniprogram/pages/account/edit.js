/**
 * 添加/编辑账户页面
 */
const { ACCOUNT_PLATFORMS } = require('../../utils/constants');

Page({
  data: {
    isEdit: false,
    accountId: '',
    form: {
      name: '',
      type: 'stock',
      platform: '',
      cash_balance: '',
      note: '',
      // 证券账户专属字段
      customer_no: '',
      broker_password: '',
      // 基金账户专属字段
      fund_account_name: '',
      fund_password: '',
      // ═══ 证券账户费率（沪市） ═══
      sh_stock_rate: '',
      sh_stock_min: '',
      sh_etf_rate: '',
      sh_etf_min: '',
      sh_lof_rate: '',
      sh_lof_min: '',
      // ═══ 证券账户费率（深市） ═══
      sz_stock_rate: '',
      sz_stock_min: '',
      sz_etf_rate: '',
      sz_etf_min: '',
      sz_lof_rate: '',
      sz_lof_min: '',
      // ═══ 其他费用 ═══
      transfer_fee_rate: '0.00001', // 过户费率（万0.1 = 0.00001）
      stamp_duty_rate: '0.0005',    // 印花税率（万5 = 0.0005，仅卖出）
      // ═══ 基金平台费率 ═══
      subscription_fee_rate: '',     // 申购费率
      subscription_fee_min: '0',     // 申购最低收费
      redemption_fee_rate: '',       // 赎回费率
      redemption_fee_min: '0',       // 赎回最低收费
      management_fee_rate: '',       // 管理费（年化）
      custodian_fee_rate: '',        // 托管费（年化）
      advisory_fee_rate: '',         // 投顾费（年化，可选）
    },
    typeIndex: 0,
    typeOptions: [],
    platformIndex: 0,
    platformOptions: [],
  },

  onLoad(options) {
    // 初始化类型选择器
    const types = ACCOUNT_PLATFORMS.map(p => p.name);
    this.setData({ typeOptions: types });

    // 如果有 id 则为编辑模式
    if (options.id) {
      this.setData({ isEdit: true, accountId: options.id });
      this.loadAccount(options.id);
    }

    // 默认选中第一个类型的平台
    this.updatePlatforms(0);
  },

  async loadAccount(id) {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('accounts').doc(id).get();
      const account = res.data;
      if (!account) return;

      const typeIdx = ACCOUNT_PLATFORMS.findIndex(p => p.key === account.type);
      this.setData({
        typeIndex: Math.max(0, typeIdx),
        form: {
          name: account.name || '',
          type: account.type || 'stock',
          platform: account.platform || '',
          cash_balance: String(account.cash_balance || ''),
          note: account.note || '',
          customer_no: account.customer_no || '',
          broker_password: account.broker_password || '',
          fund_account_name: account.fund_account_name || '',
          fund_password: account.fund_password || '',
          // 证券费率（沪市）
          sh_stock_rate: account.sh_stock_rate != null ? String(account.sh_stock_rate) : '',
          sh_stock_min: account.sh_stock_min != null ? String(account.sh_stock_min) : '',
          sh_etf_rate: account.sh_etf_rate != null ? String(account.sh_etf_rate) : '',
          sh_etf_min: account.sh_etf_min != null ? String(account.sh_etf_min) : '',
          sh_lof_rate: account.sh_lof_rate != null ? String(account.sh_lof_rate) : '',
          sh_lof_min: account.sh_lof_min != null ? String(account.sh_lof_min) : '',
          // 证券费率（深市）
          sz_stock_rate: account.sz_stock_rate != null ? String(account.sz_stock_rate) : '',
          sz_stock_min: account.sz_stock_min != null ? String(account.sz_stock_min) : '',
          sz_etf_rate: account.sz_etf_rate != null ? String(account.sz_etf_rate) : '',
          sz_etf_min: account.sz_etf_min != null ? String(account.sz_etf_min) : '',
          sz_lof_rate: account.sz_lof_rate != null ? String(account.sz_lof_rate) : '',
          sz_lof_min: account.sz_lof_min != null ? String(account.sz_lof_min) : '',
          // 其他费用
          transfer_fee_rate: account.transfer_fee_rate != null ? String(account.transfer_fee_rate) : '0.00001',
          stamp_duty_rate: account.stamp_duty_rate != null ? String(account.stamp_duty_rate) : '0.0005',
          // 基金费率
          subscription_fee_rate: account.subscription_fee_rate != null ? String(account.subscription_fee_rate) : '',
          subscription_fee_min: account.subscription_fee_min != null ? String(account.subscription_fee_min) : '0',
          redemption_fee_rate: account.redemption_fee_rate != null ? String(account.redemption_fee_rate) : '',
          redemption_fee_min: account.redemption_fee_min != null ? String(account.redemption_fee_min) : '0',
          management_fee_rate: account.management_fee_rate != null ? String(account.management_fee_rate) : '',
          custodian_fee_rate: account.custodian_fee_rate != null ? String(account.custodian_fee_rate) : '',
          advisory_fee_rate: account.advisory_fee_rate != null ? String(account.advisory_fee_rate) : '',
        },
      });
      this.updatePlatforms(typeIdx, account.platform);
    } catch (err) {
      console.error('[Account Edit] load error:', err);
    }
  },

  updatePlatforms(typeIndex, selectedPlatform = '') {
    const type = ACCOUNT_PLATFORMS[typeIndex];
    const platforms = type?.platforms || [];
    const opts = platforms.map(p => p.name);
    const idx = platforms.findIndex(p => p.key === selectedPlatform);
    this.setData({
      platformOptions: opts,
      platformIndex: Math.max(0, idx),
      'form.type': type?.key || 'custom',
      'form.platform': selectedPlatform || platforms[0]?.key || '',
    });
  },

  onTypeChange(e) {
    const idx = e.detail.value;
    this.setData({ typeIndex: idx });
    this.updatePlatforms(idx);
  },

  onPlatformChange(e) {
    const idx = e.detail.value;
    const type = ACCOUNT_PLATFORMS[this.data.typeIndex];
    const platforms = type?.platforms || [];
    this.setData({
      platformIndex: idx,
      'form.platform': platforms[idx]?.key || '',
    });
  },

  onNameInput(e) {
    this.setData({ 'form.name': e.detail.value });
  },

  onCashBalanceInput(e) {
    this.setData({ 'form.cash_balance': e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ 'form.note': e.detail.value });
  },

  onCustomerNoInput(e) {
    this.setData({ 'form.customer_no': e.detail.value });
  },

  onBrokerPasswordInput(e) {
    this.setData({ 'form.broker_password': e.detail.value });
  },

  onFundAccountNameInput(e) {
    this.setData({ 'form.fund_account_name': e.detail.value });
  },

  onFundPasswordInput(e) {
    this.setData({ 'form.fund_password': e.detail.value });
  },

  // ═══ 佣金表格通用输入 （通过 data-key 确定字段名） ═══
  onFeeInput(e) {
    const key = e.currentTarget.dataset.key;
    if (key) {
      this.setData({ ['form.' + key]: e.detail.value });
    }
  },

  onTransferFeeRateInput(e) {
    this.setData({ 'form.transfer_fee_rate': e.detail.value });
  },

  onStampDutyRateInput(e) {
    this.setData({ 'form.stamp_duty_rate': e.detail.value });
  },

  // ═══ 基金费率输入 ═══
  onSubscriptionFeeRateInput(e) {
    this.setData({ 'form.subscription_fee_rate': e.detail.value });
  },

  onSubscriptionFeeMinInput(e) {
    this.setData({ 'form.subscription_fee_min': e.detail.value });
  },

  onRedemptionFeeRateInput(e) {
    this.setData({ 'form.redemption_fee_rate': e.detail.value });
  },

  onRedemptionFeeMinInput(e) {
    this.setData({ 'form.redemption_fee_min': e.detail.value });
  },

  onManagementFeeRateInput(e) {
    this.setData({ 'form.management_fee_rate': e.detail.value });
  },

  onCustodianFeeRateInput(e) {
    this.setData({ 'form.custodian_fee_rate': e.detail.value });
  },

  onAdvisoryFeeRateInput(e) {
    this.setData({ 'form.advisory_fee_rate': e.detail.value });
  },

  async onSave() {
    if (!this.data.form.name) {
      wx.showToast({ title: '请输入账户名称', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });
    try {
      const db = wx.cloud.database();
      const f = this.data.form;
      const data = {
        name: f.name,
        type: f.type,
        platform: f.platform,
        cash_balance: parseFloat(f.cash_balance) || 0,
        note: f.note,
        // 账户类型专属字段
        customer_no: f.customer_no || '',
        broker_password: f.broker_password || '',
        fund_account_name: f.fund_account_name || '',
        fund_password: f.fund_password || '',
        // ═══ 证券账户费率（沪市） ═══
        sh_stock_rate: parseFloat(f.sh_stock_rate) || 0,
        sh_stock_min: parseFloat(f.sh_stock_min) || 0,
        sh_etf_rate: parseFloat(f.sh_etf_rate) || 0,
        sh_etf_min: parseFloat(f.sh_etf_min) || 0,
        sh_lof_rate: parseFloat(f.sh_lof_rate) || 0,
        sh_lof_min: parseFloat(f.sh_lof_min) || 0,
        // ═══ 证券账户费率（深市） ═══
        sz_stock_rate: parseFloat(f.sz_stock_rate) || 0,
        sz_stock_min: parseFloat(f.sz_stock_min) || 0,
        sz_etf_rate: parseFloat(f.sz_etf_rate) || 0,
        sz_etf_min: parseFloat(f.sz_etf_min) || 0,
        sz_lof_rate: parseFloat(f.sz_lof_rate) || 0,
        sz_lof_min: parseFloat(f.sz_lof_min) || 0,
        // ═══ 其他费用 ═══
        transfer_fee_rate: parseFloat(f.transfer_fee_rate) || 0,
        stamp_duty_rate: parseFloat(f.stamp_duty_rate) || 0,
        // ═══ 基金平台费率 ═══
        subscription_fee_rate: parseFloat(f.subscription_fee_rate) || 0,
        subscription_fee_min: parseFloat(f.subscription_fee_min) || 0,
        redemption_fee_rate: parseFloat(f.redemption_fee_rate) || 0,
        redemption_fee_min: parseFloat(f.redemption_fee_min) || 0,
        management_fee_rate: parseFloat(f.management_fee_rate) || 0,
        custodian_fee_rate: parseFloat(f.custodian_fee_rate) || 0,
        advisory_fee_rate: parseFloat(f.advisory_fee_rate) || 0,
        updated_at: db.serverDate(),
      };

      if (this.data.isEdit) {
        await db.collection('accounts').doc(this.data.accountId).update({ data });
      } else {
        await db.collection('accounts').add({
          data: {
            ...data,
            sort_order: 0,
            created_at: db.serverDate(),
          },
        });
      }

      wx.hideLoading();
      wx.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (err) {
      console.error('[Account Save] error:', err);
      wx.hideLoading();
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  async onDelete() {
    wx.showModal({
      title: '确认删除',
      content: '删除账户会同时删除该账户下所有持仓记录，确认？',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '删除中...' });
          try {
            const db = wx.cloud.database();
            // 分页删除该账户下全部持仓（客户端单次 get 上限 20，避免留下孤儿持仓）
            // 删除后记录会上移，故始终从 skip=0 拉取，直到取不到数据为止
            const PAGE_SIZE = 20;
            let safety = 0;
            while (safety < 500) {
              const { data: batch } = await db.collection('holdings')
                .where({ account_id: this.data.accountId })
                .limit(PAGE_SIZE)
                .get();
              if (batch.length === 0) break;
              await Promise.all(batch.map(h => db.collection('holdings').doc(h._id).remove()));
              if (batch.length < PAGE_SIZE) break;
              safety++;
            }

            // 删除账户
            await db.collection('accounts').doc(this.data.accountId).remove();

            wx.hideLoading();
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 1000);
          } catch (err) {
            wx.hideLoading();
            wx.showToast({ title: '删除失败', icon: 'none' });
          }
        }
      },
    });
  },
});
