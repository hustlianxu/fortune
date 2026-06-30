/**
 * API Key 加密存储云函数
 * AES-256-CBC 加密后存入数据库
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const AES_KEY = process.env.AES_KEY || 'your-default-32-char-aes-key-string!';
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(AES_KEY), iv);
  let encrypted = cipher.update(text, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('base64') + ':' + encrypted.toString('base64');
}

exports.main = async (event) => {
  const { config = {} } = event;
  const wxContext = cloud.getWXContext();

  try {
    // 加密每个启用的 provider 的 api_key
    const encryptedConfig = {};
    for (const [key, value] of Object.entries(config)) {
      if (value.enabled && value.api_key && !value.api_key.startsWith('••')) {
        encryptedConfig[key] = {
          ...value,
          api_key: encrypt(value.api_key),
        };
      } else {
        // 保留原有配置（未修改的 Key 保持不变）
        encryptedConfig[key] = value;
      }
    }

    // 检查是否已存在配置（按 openid 隔离）
    const openid = wxContext.OPENID || '';
    const existingQuery = openid ? { _openid: openid } : {};
    const { data: existing } = await db.collection('llm_configs').where(existingQuery).get();

    if (existing.length > 0) {
      // 更新已有配置
      const existingConfig = existing[0].providers || {};

      // 合并 - 保留未变化的 key
      for (const [key, value] of Object.entries(config)) {
        if (!value.enabled || !value.api_key) continue;
        if (value.api_key && value.api_key.startsWith('••')) {
          // 用户没有修改 key，保留旧的
          encryptedConfig[key] = {
            ...value,
            api_key: existingConfig[key]?.api_key || '',
          };
        }
      }

      await db.collection('llm_configs').doc(existing[0]._id).update({
        data: {
          providers: encryptedConfig,
          updated_at: db.serverDate(),
        },
      });
    } else {
      // 新增配置
      await db.collection('llm_configs').add({
        data: {
          _openid: openid,
          providers: encryptedConfig,
          default_provider: 'deepseek',
          created_at: db.serverDate(),
          updated_at: db.serverDate(),
        },
      });
    }

    return { success: true };
  } catch (err) {
    console.error('[encrypt_api_key] error:', err);
    return {
      success: false,
      message: err.message,
    };
  }
};
