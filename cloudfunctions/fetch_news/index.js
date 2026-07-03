/**
 * 财经资讯抓取云函数
 * 定时触发: 每天 08:00 / 17:00
 *
 * 来源策略（按优先级，前一个失败再尝试后一个）：
 *   1. 新浪财经 RSS（直连，稳定性高于 rsshub）
 *   2. 东方财富快讯 JSON 接口（直连，结构稳定）
 *   3. RSSHub（fallback，需公网可达且实例可用）
 *
 * 失败容错：单个来源失败不影响整体抓取，只在 errors 数组里记录。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const http = require('./http');

/**
 * 解析 RSS <item> 节点（兼容 CDATA 与裸文本两种格式）
 */
function parseRssItems(text) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(text)) !== null) {
    const item = match[1];
    const pickNode = (tag) => {
      // 优先 CDATA
      const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(item);
      if (cdata) return cdata[1];
      const plain = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(item);
      return plain ? plain[1] : '';
    };
    items.push({
      title: pickNode('title').trim(),
      link: pickNode('link').trim(),
      description: pickNode('description').trim(),
      pubDate: pickNode('pubDate').trim(),
    });
  }
  return items;
}

const NEWS_SOURCES = [
  // 1) 新浪财经 RSS - 直连官方源，比 rsshub 稳定
  {
    name: '新浪财经',
    url: 'https://feed.mix.sina.com.cn/api/relay/finance/rss.xml',
    parse: function (text) {
      const items = parseRssItems(text);
      return items.map(it => ({
        title: it.title,
        url: it.link,
        summary: it.description.replace(/<[^>]+>/g, '').slice(0, 200),
        pubDate: it.pubDate,
      }));
    },
  },
  // 2) 东方财富 RSS - 官方直连
  {
    name: '东方财富',
    url: 'https://np-cnbond.eastmoney.com/rss/News.aspx?type=2',
    parse: function (text) {
      const items = parseRssItems(text);
      return items.map(it => ({
        title: it.title,
        url: it.link,
        summary: it.description.replace(/<[^>]+>/g, '').slice(0, 200),
        pubDate: it.pubDate,
      }));
    },
  },
  // 3) RSSHub fallback（公共实例可能不稳定）
  {
    name: '36氪快讯',
    url: 'https://rsshub.app/36kr/motif',
    parse: function (text) {
      const items = parseRssItems(text);
      return items.map(it => ({
        title: it.title,
        url: it.link,
        summary: '',
        pubDate: it.pubDate,
      }));
    },
  },
];

/**
 * 智能分类 - 基于标题和内容关键词
 */
function categorizeNews(title, summary) {
  const text = `${title} ${summary}`;

  if (/沪指|深成指|创业板|大盘|A股|股市|收涨|收跌|成交额|涨停|跌停|牛市|熊市|行情/.test(text)) return 'market';
  if (/行业|板块|半导体|新能源|光伏|汽车|医药|消费|金融|地产|科技|芯片|AI|人工智能/.test(text)) return 'industry';
  if (/公司|财报|上市|融资|收购|减持|增持|股份|股价|涨超|跌超/.test(text)) return 'company';
  if (/央行|政策|监管|降息|降准|利率|LPR|证监会|国务院|发改委|财政部/.test(text)) return 'policy';
  if (/美股|港股|欧洲|美联储|加息|全球|国际|贸易|关税/.test(text)) return 'global';

  return 'market';
}

/**
 * 计算重要性分数
 */
function calcImportance(title) {
  let score = 0;
  if (/重大|重磅|突发|紧急|重要|紧急|最新/.test(title)) score += 2;
  if (/央行|政策|降息|降准|国务院/.test(title)) score += 2;
  if (/涨停|跌停|大涨|大跌/.test(title)) score += 1;
  if (/公司|行业|板块|市场/.test(title)) score += 1;
  return Math.min(score + 1, 5);
}

exports.main = async (event) => {
  try {
    const allNews = [];
    const sourceErrors = [];

    // 串行抓取各源（避免并发被限流，单源失败立刻切到下一个）
    for (const source of NEWS_SOURCES) {
      try {
        const text = await http.getText(source.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 12000,
        });
        const items = source.parse(text);
        if (!items || items.length === 0) {
          sourceErrors.push({ source: source.name, error: '抓取到 0 条' });
          continue;
        }
        items.forEach(item => {
          allNews.push({
            title: item.title || '',
            summary: item.summary || '',
            source: source.name,
            source_url: item.url,
            publish_time: item.pubDate ? new Date(item.pubDate) : new Date(),
            category: categorizeNews(item.title, item.summary),
            importance: calcImportance(item.title),
          });
        });
      } catch (err) {
        console.error(`[fetchNews] ${source.name} error:`, err && err.message);
        sourceErrors.push({ source: source.name, error: err && err.message });
      }
    }

    // 全部来源都失败 → 返回 false，前端可显示明确错误
    if (allNews.length === 0) {
      return {
        success: false,
        message: `所有资讯源抓取失败：${sourceErrors.map(e => `${e.source}(${e.error})`).join('; ')}`,
        count: 0,
        sourceErrors,
      };
    }

    // 去重（相同标题只保留一条，按重要性优先）
    const seen = new Set();
    const uniqueNews = allNews.filter(item => {
      if (!item.title) return false;
      const key = item.title.slice(0, 20);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 按重要性排序，再按时间倒序
    uniqueNews.sort((a, b) =>
      b.importance - a.importance || new Date(b.publish_time) - new Date(a.publish_time)
    );

    // 只保留前 80 条
    const saveNews = uniqueNews.slice(0, 80);

    // 清理旧数据（保留最近 100 条）
    const { total } = await db.collection('news_cache').count();
    if (total > 100) {
      const { data: old } = await db.collection('news_cache')
        .orderBy('publish_time', 'asc')
        .limit(Math.max(0, total - 80))
        .get();
      const deletePromises = old.map(item => db.collection('news_cache').doc(item._id).remove());
      await Promise.all(deletePromises);
    }

    // 写入新的资讯
    const insertPromises = saveNews.map(item =>
      db.collection('news_cache').add({
        data: {
          title: item.title,
          summary: item.summary,
          source: item.source,
          source_url: item.source_url,
          publish_time: item.publish_time,
          category: item.category,
          importance: item.importance,
          fetched_at: db.serverDate(),
          created_at: db.serverDate(),
        },
      }).catch(() => {})
    );
    await Promise.all(insertPromises);

    return {
      success: true,
      count: saveNews.length,
      sources: NEWS_SOURCES.map(s => s.name),
      sourceErrors,
    };
  } catch (err) {
    console.error('[fetch_news] error:', err);
    return { success: false, message: err.message, count: 0 };
  }
};
