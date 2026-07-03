/**
 * 数据库初始化云函数
 * 一键创建所有集合和索引
 *
 * 使用方式：
 * 1. 部署此云函数
 * 2. 在微信开发者工具中调用：wx.cloud.callFunction({ name: 'init_db' })
 * 3. 或在云函数控制台直接测试运行
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 集合定义及索引配置
const COLLECTIONS = [
  {
    name: 'accounts',
    indexes: [
      { name: 'idx_openid', field: { _openid: 1 } },
      { name: 'idx_sort', field: { sort_order: 1 } },
    ],
  },
  {
    name: 'holdings',
    indexes: [
      { name: 'idx_openid', field: { _openid: 1 } },
      { name: 'idx_account', field: { account_id: 1 } },
      { name: 'idx_code', field: { product_code: 1 } },
      { name: 'idx_batch', field: { import_batch: 1 } },
    ],
  },
  {
    name: 'transactions',
    indexes: [
      { name: 'idx_openid', field: { _openid: 1 } },
      { name: 'idx_account', field: { account_id: 1 } },
      { name: 'idx_trade_date', field: { trade_date: -1 } },
    ],
  },
  {
    name: 'price_cache',
    indexes: [
      { name: 'idx_code_date', field: { product_code: 1, date: -1 } },
      { name: 'idx_date', field: { date: -1 } },
    ],
  },
  {
    name: 'import_history',
    indexes: [
      { name: 'idx_openid', field: { _openid: 1 } },
      { name: 'idx_created', field: { created_at: -1 } },
    ],
  },
  {
    name: 'llm_configs',
    indexes: [
      { name: 'idx_openid', field: { _openid: 1 } },
    ],
  },
  {
    name: 'analysis_reports',
    indexes: [
      { name: 'idx_openid', field: { _openid: 1 } },
      { name: 'idx_created', field: { created_at: -1 } },
      { name: 'idx_type', field: { type: 1, created_at: -1 } },
    ],
  },
  {
    name: 'analysis_tasks',
    indexes: [
      { name: 'idx_openid', field: { _openid: 1 } },
      { name: 'idx_status', field: { status: 1, created_at: -1 } },
    ],
  },
  {
    name: 'news_cache',
    indexes: [
      { name: 'idx_pub_time', field: { publish_time: -1 } },
      { name: 'idx_category', field: { category: 1, publish_time: -1 } },
      { name: 'idx_importance', field: { importance: -1, publish_time: -1 } },
    ],
  },
];

exports.main = async (event) => {
  const results = {
    success: [],
    skipped: [],
    errors: [],
  };

  for (const col of COLLECTIONS) {
    try {
      // 检查集合是否已存在
      const { total } = await db.collection(col.name).count();
      results.skipped.push({ name: col.name, message: `已存在 (${total} 条记录)` });
      console.log(`[跳过] ${col.name} 已存在`);
      continue;
    } catch (err) {
      // 集合不存在时 count() 会报错，此时创建
      if (err.errCode !== 'DATABASE_COLLECTION_NOT_EXIST' &&
          err.errCode !== -502005 &&
          !err.message?.includes('collection not exist')) {
        results.errors.push({ name: col.name, message: `检查失败: ${err.message}` });
        console.error(`[错误] ${col.name} 检查失败:`, err);
        continue;
      }
    }

    // 创建集合
    try {
      await db.createCollection(col.name);
      results.success.push({ name: col.name, message: '集合已创建' });
      console.log(`[创建] ${col.name} 集合已创建`);

      // 创建索引（等待集合就绪）
      await sleep(2000);
      if (col.indexes && col.indexes.length > 0) {
        for (const index of col.indexes) {
          try {
            await db.collection(col.name).createIndex({
              name: index.name,
              ...index.field,
            });
            console.log(`  [索引] ${index.name} 已创建`);
          } catch (idxErr) {
            console.warn(`  [索引跳过] ${index.name}: ${idxErr.message}`);
          }
        }
      }
    } catch (err) {
      if (err.message?.includes('already exists')) {
        results.skipped.push({ name: col.name, message: '已存在（创建时冲突）' });
      } else {
        results.errors.push({ name: col.name, message: `创建失败: ${err.message}` });
        console.error(`[错误] ${col.name} 创建失败:`, err);
      }
    }
  }

  return {
    success: true,
    message: `初始化完成: ${results.success.length} 创建, ${results.skipped.length} 已存在, ${results.errors.length} 错误`,
    details: results,
  };
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
