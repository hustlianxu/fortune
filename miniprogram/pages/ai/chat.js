/**
 * AI 智能问答（独立对话页）
 */
Page({
  data: {
    messages: [],
    question: '',
    canSend: false,
  },

  onInputChange(e) {
    this.setData({ canSend: (e.detail.value || '').trim().length > 0 });
  },

  async onSend() {
    const question = this.data.question.trim();
    if (!question) return;

    // 添加用户消息
    const msgs = [...this.data.messages, { role: 'user', content: question }];
    this.setData({ messages: msgs, question: '', canSend: false });

    try {
      wx.showLoading({ title: '思考中...', mask: true });

      const res = await wx.cloud.callFunction({
        name: 'llm_gateway',
        data: {
          type: 'qa',
          provider: wx.getStorageSync('default_llm_provider') || 'deepseek',
          question,
        },
      });

      wx.hideLoading();

      const answer = res.result?.answer || '抱歉，暂时无法回答';
      this.setData({
        messages: [...msgs, { role: 'assistant', content: answer }],
      });
    } catch (err) {
      wx.hideLoading();
      this.setData({
        messages: [...msgs, { role: 'assistant', content: '网络错误，请稍后重试' }],
      });
    }
  },
});
