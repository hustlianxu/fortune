/**
 * AI 模型设置页面
 */
const api = require('../../../utils/api');
const { LLM_PROVIDERS } = require('../../../utils/constants');

const CUSTOM_LABEL = '自定义...';

Page({
  data: {
    providers: [],
  },

  async onLoad(options) {
    const providers = LLM_PROVIDERS.map(p => {
      const pickerList = [...(p.models || []), CUSTOM_LABEL];
      return {
        ...p,
        enabled: false,
        api_key: '',
        model: p.defaultModel,
        base_url: p.baseURL || '',
        defaultBaseURL: p.baseURL || '',
        models: p.models || [],
        modelPickerList: pickerList,
        pickerIndex: 0,
        customModel: false,
        customModelValue: '',
      };
    });

    // 加载已保存的配置
    try {
      const config = await api.getLLMConfig();
      if (config && config.providers) {
        Object.entries(config.providers).forEach(([key, val]) => {
          const idx = providers.findIndex(p => p.key === key);
          if (idx < 0) return;

          const p = providers[idx];
          p.enabled = val.enabled || false;
          p.api_key = val.api_key ? '••••••••' : '';
          p.base_url = val.base_url || ''; // 留空以便 placeholder 显示默认地址

          const savedModel = val.model || p.defaultModel;
          const modelIdx = p.models.indexOf(savedModel);
          if (modelIdx >= 0) {
            p.pickerIndex = modelIdx;
            p.model = savedModel;
            p.customModel = false;
            p.customModelValue = '';
          } else {
            p.pickerIndex = p.models.length; // 选中 "自定义..."
            p.model = savedModel;
            p.customModel = true;
            p.customModelValue = savedModel;
          }
        });
      }
    } catch (err) {
      console.error('[LLM Settings] load error:', err);
    }

    this.setData({ providers });
  },

  onToggleProvider(e) {
    const key = e.currentTarget.dataset.key;
    const providers = this.data.providers.map(p => {
      if (p.key === key) return { ...p, enabled: !p.enabled };
      return p;
    });
    this.setData({ providers });
  },

  onKeyInput(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    const providers = this.data.providers.map(p => {
      if (p.key === key) return { ...p, api_key: value, _hasKey: !!value };
      return p;
    });
    this.setData({ providers });
  },

  onModelPicker(e) {
    const key = e.currentTarget.dataset.key;
    const pickerIndex = e.detail.value;
    const providers = this.data.providers.map(p => {
      if (p.key !== key) return p;

      const isCustom = pickerIndex >= p.models.length;
      const model = isCustom ? '' : p.models[pickerIndex];
      return {
        ...p,
        pickerIndex,
        model: isCustom ? p.customModelValue || '' : model,
        customModel: isCustom,
      };
    });
    this.setData({ providers });
  },

  onCustomModelInput(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    const providers = this.data.providers.map(p => {
      if (p.key === key) return { ...p, customModelValue: value, model: value };
      return p;
    });
    this.setData({ providers });
  },

  onBaseURLInput(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    const providers = this.data.providers.map(p => {
      if (p.key === key) return { ...p, base_url: value };
      return p;
    });
    this.setData({ providers });
  },

  async onSave() {
    const config = {};
    this.data.providers.forEach(p => {
      config[p.key] = {
        enabled: p.enabled,
        api_key: p.api_key || '',
        model: p.model || p.defaultModel,
        base_url: p.base_url || p.defaultBaseURL,
      };
    });

    wx.showLoading({ title: '保存中...', mask: true });
    try {
      // saveLLMConfig 内部会调用 encrypt_api_key 云函数，参数为 config 对象本身
      // 云函数会遍历 config 的每个 provider 进行加密存储
      const result = await api.saveLLMConfig(config);
      if (result && result.success) {
        wx.showToast({ title: '保存成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      } else {
        wx.showToast({ title: (result && result.message) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '网络错误', icon: 'none' });
    }
  },
});
