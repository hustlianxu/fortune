/**
 * 轻量 Markdown 解析器（小程序专用）
 *
 * 设计目标：
 *   1. 把 AI 报告（含【小节】、表格、列表、加粗等）解析为结构化 blocks，
 *      用原生 view 渲染，从而：
 *        - 正确显示 markdown 表格（原生 view 表格，支持暗黑模式）
 *        - 字体颜色走 CSS 变量 var(--text-primary)，暗黑模式自动适配
 *   2. 不依赖第三方库，纯字符串解析，体积小、运行快
 *
 * 输出格式（blocks 数组）：
 *   { type: 'heading', level, inlines }
 *   { type: 'paragraph', inlines }
 *   { type: 'list', ordered, items: [ inlines, ... ] }
 *   { type: 'table', headers: [ inlines, ... ], rows: [ [inlines,...], ... ], aligns: ['left'|'center'|'right'] }
 *   { type: 'code', text }
 *   { type: 'blockquote', inlines }
 *   { type: 'hr' }
 *
 * inline 为 { text, bold, italic, code, color }
 *   color 仅用于【】中文小节标题这种语义着色，普通文本不传 color（走 var(--text-primary)）
 */

/**
 * 解析行内样式：**bold**、*italic*、`code`、【中文标题】
 * 返回 inlines 数组
 */
function parseInlines(text) {
  if (!text) return [];
  const inlines = [];
  // 用占位符依次匹配，避免嵌套正则冲突
  // 顺序：`code` → **bold** → *italic* → 【section】
  // 先把 inline code 抽出来
  const tokens = [];
  let remaining = text;
  const codeRe = /`([^`]+)`/;
  const boldRe = /\*\*([^*]+)\*\*/;
  const italicRe = /\*([^*]+)\*/;
  const sectionRe = /【([^】]+)】/;

  // 简化：用扫描方式逐段处理
  let buf = '';
  let i = 0;
  while (i < remaining.length) {
    // inline code
    if (remaining[i] === '`') {
      const end = remaining.indexOf('`', i + 1);
      if (end > i) {
        if (buf) { tokens.push({ text: buf, bold: false, italic: false, code: false }); buf = ''; }
        tokens.push({ text: remaining.slice(i + 1, end), bold: false, italic: false, code: true });
        i = end + 1;
        continue;
      }
    }
    // 【中文小节】
    if (remaining[i] === '【') {
      const end = remaining.indexOf('】', i + 1);
      if (end > i) {
        if (buf) { tokens.push({ text: buf, bold: false, italic: false, code: false }); buf = ''; }
        tokens.push({ text: remaining.slice(i, end + 1), bold: true, italic: false, code: false, color: 'primary' });
        i = end + 1;
        continue;
      }
    }
    // **bold**
    if (remaining[i] === '*' && remaining[i + 1] === '*') {
      const end = remaining.indexOf('**', i + 2);
      if (end > i + 1) {
        if (buf) { tokens.push({ text: buf, bold: false, italic: false, code: false }); buf = ''; }
        tokens.push({ text: remaining.slice(i + 2, end), bold: true, italic: false, code: false });
        i = end + 2;
        continue;
      }
    }
    // *italic*
    if (remaining[i] === '*') {
      const end = remaining.indexOf('*', i + 1);
      if (end > i) {
        if (buf) { tokens.push({ text: buf, bold: false, italic: false, code: false }); buf = ''; }
        tokens.push({ text: remaining.slice(i + 1, end), bold: false, italic: true, code: false });
        i = end + 1;
        continue;
      }
    }
    buf += remaining[i];
    i++;
  }
  if (buf) tokens.push({ text: buf, bold: false, italic: false, code: false });
  return tokens;
}

/**
 * 把一行文本拆成 inlines（对表格单元格也用）
 */
function inline(text) {
  return parseInlines(text);
}

/**
 * 主解析入口：把 markdown 文本转成 blocks 数组
 */
function parseMarkdown(md) {
  if (!md || typeof md !== 'string') return [];
  // 统一换行
  const text = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');

  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i];

    // 跳过空行
    if (/^\s*$/.test(line)) { i++; continue; }

    // 代码块 ```
    if (/^```/.test(line.trim())) {
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 ```
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    // 水平分割线
    if (/^\s*([-*_])\1\1[-*_\s]*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 标题 # / ## / ### ...
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, inlines: inline(headingMatch[2].trim()) });
      i++;
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行 |---|
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
      const splitRow = (r) => {
        let s = r.trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|')) s = s.slice(0, -1);
        return s.split('|').map(c => c.trim());
      };
      const headers = splitRow(line).map(inline);
      const alignLine = splitRow(lines[i + 1]);
      const aligns = alignLine.map(seg => {
        const left = seg.startsWith(':');
        const right = seg.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]).map(inline));
        i++;
      }
      blocks.push({ type: 'table', headers, rows, aligns });
      continue;
    }

    // 引用 >
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', inlines: inline(quoteLines.join(' ')) });
      continue;
    }

    // 无序列表 - / * / • / · / 数字.
    const ulMatch = line.match(/^\s*([-*•·])\s+(.*)$/);
    const olMatch = line.match(/^\s*(\d+)[.、)]\s+(.*)$/);
    if (ulMatch) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*•·])\s+(.*)$/);
        if (!m) break;
        items.push(inline(m[2]));
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }
    if (olMatch) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(\d+)[.、)]\s+(.*)$/);
        if (!m) break;
        items.push(inline(m[2]));
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // 普通段落（连续非空非特殊行合并）
    const paraLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) break;
      if (/^(#{1,6})\s+/.test(l)) break;
      if (/^```/.test(l.trim())) break;
      if (/^\s*([-*•·])\s+/.test(l)) break;
      if (/^\s*(\d+)[.、)]\s+/.test(l)) break;
      if (/^\s*>\s?/.test(l)) break;
      if (l.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) break;
      paraLines.push(l);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: 'paragraph', inlines: inline(paraLines.join(' ')) });
    }
  }

  return blocks;
}

module.exports = {
  parseMarkdown,
  parseInlines,
};
