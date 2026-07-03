/**
 * save_ai_report
 * 保存 AI 分析报告到 analysis_reports 集合
 * 前端直接调用 LLM API 后，通过此云函数持久化结果
 *
 * 入参：
 *   type: string         分析类型（portfolio_health / pnl_analysis / rebalance_advice / risk_analysis）
 *   provider: string     模型提供商
 *   model: string        模型名称
 *   summary: string      摘要
 *   report_content: string  完整报告内容
 *   key_findings: string[]  关键发现列表
 *   risk_level: string   风险等级
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';

  try {
    const {
      type = 'portfolio_health',
      provider = '',
      model = '',
      summary = '',
      report_content = '',
      key_findings = [],
      risk_level = '',
    } = event;

    if (!report_content) {
      return { success: false, message: 'report_content 不能为空' };
    }

    const result = await db.collection('analysis_reports').add({
      data: {
        _openid: openid,
        type,
        provider,
        model,
        snapshot_date: new Date().toISOString().split('T')[0],
        summary,
        report_content,
        key_findings,
        risk_level,
        created_at: db.serverDate(),
      },
    });

    return {
      success: true,
      reportId: result._id,
      message: '报告已保存',
    };
  } catch (err) {
    console.error('[save_ai_report] error:', err);
    return { success: false, message: err.message || '保存失败' };
  }
};
