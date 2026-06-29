/**
 * 便携 HTTP 请求工具（基于 Node 内置 http/https 模块）
 * 兼容 Node.js 12/16/18，避免依赖 fetch / node-fetch
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      method: options.method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: options.headers || {},
      timeout: options.timeout || 15000,
    };

    const req = lib.request(reqOptions, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          text: () => Promise.resolve(text),
          json: () => {
            try { return Promise.resolve(JSON.parse(text)); }
            catch (e) { return Promise.reject(new Error(`JSON parse failed: ${e.message}`)); }
          },
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });

    if (options.body) {
      const bodyStr = typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
      if (!reqOptions.headers['Content-Type'] && !reqOptions.headers['content-type']) {
        reqOptions.headers['Content-Type'] = 'application/json';
      }
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      req.write(bodyStr);
    }
    req.end();
  });
}

async function getText(url, options = {}) {
  const res = await request(url, options);
  return res.text();
}

async function getJSON(url, options = {}) {
  const res = await request(url, options);
  return res.json();
}

module.exports = {
  request,
  getText,
  getJSON,
};
