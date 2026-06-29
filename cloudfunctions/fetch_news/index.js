/**
 * 财经资讯抓取云函数
 * 定时触发: 每天 08:00 / 17:00
 *
 * 来源: 东方财富、新浪财经、36氪、华尔街见闻 RSS
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const http = require('./http');

const NEWS_SOURCES = [
  {
    name: '东方财富',
    url: 'https://rsshub.app/eastmoney/search?keyword=&type=news',
    parse: function (text) {
      // RSS 解析
      var items = [];
      var itemRegex = /<item>([\s\S]*?)<\/item>/g;
      var titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/;
      var linkRegex = /<link>(.*?)<\/link>/;
      var descRegex = /<description><!\[CDATA\[(.*?)\]\]><\/description>/;
      var pubDateRegex = /<pubDate>(.*?)<\/pubDate>/;

      var match;
      while ((match = itemRegex.exec(text)) !== null) {
        var item = match[1];
        var title = (titleRegex.exec(item) || [])[1] || '';
        var link = (linkRegex.exec(item) || [])[1] || '';
        var desc = (descRegex.exec(item) || [])[1] || '';
        var pubDate = (pubDateRegex.exec(item) || [])[1] || '';
        items.push({
          title: title,
          url: link,
          summary: desc.replace(/<[^>]+>/g, '').slice(0, 200),
          pubDate: pubDate,
        });
      }
      return items;
    }
  },
  {
    name: '36氪快讯',
    url: 'https://rsshub.app/36kr/motif',
    parse: function (text) {
      var items = [];
      var itemRegex = /<item>([\s\S]*?)<\/item>/g;
      var titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/;
      var linkRegex = /<link>(.*?)<\/link>/;
      var pubDateRegex = /<pubDate>(.*?)<\/pubDate>/;

      var match;
      while ((match = itemRegex.exec(text)) !== null) {
        var item = match[1];
        items.push({
          title: (titleRegex.exec(item) || [])[1] || '',
          url: (linkRegex.exec(item) || [])[1] || '',
          summary: '',
          pubDate: (pubDateRegex.exec(item) || [])[1] || '',
        });
      }
      return items;
    }
  }
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

    // 并行抓取所有源
    for (const source of NEWS_SOURCES) {
      try {
        const text = await http.getText(source.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const items = source.parse(text);
        items.forEach(item => {
          allNews.push({
            title: item.title,
            summary: item.summary || '',
            source: source.name,
            source_url: item.url,
            publish_time: item.pubDate ? new Date(item.pubDate) : new Date(),
            category: categorizeNews(item.title, item.summary),
            importance: calcImportance(item.title),
          });
        });
      } catch (err) {
        console.error(`[fetchNews] ${source.name} error:`, err);
      }
    }

    // 去重（相同标题只保留一条）
    const seen = new Set();
    const uniqueNews = allNews.filter(item => {
      const key = item.title.slice(0, 20);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 按重要性排序
    uniqueNews.sort((a, b) => b.importance - a.importance || new Date(b.publish_time) - new Date(a.publish_time));

    // 只保留前 80 条
    const saveNews = uniqueNews.slice(0, 80);

    // 清理旧数据（保留最近 100 条）
    const { total } = await db.collection('news_cache').count();
    if (total > 100) {
      const { data: old } = await db.collection('news_cache')
        .orderBy('publish_time', 'asc')
        .limit(total - 80)
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
    };
  } catch (err) {
    console.error('[fetch_news] error:', err);
    return { success: false, message: err.message, count: 0 };
  }
};
