#!/usr/bin/env node
'use strict';

/**
 * capture-claude-code.js
 *
 * 作用：
 *   1. 读取当前目录 keys.json 里的 base_url 和 key
 *   2. 启动一个本地 Anthropic 兼容代理
 *   3. 让 Claude Code 请求这个本地代理
 *   4. 程序会打印 Claude Code 真实发来的 headers/body
 *   5. 再把请求转发到你的中转站
 *   6. 同时打印中转站返回的 status/headers/body
 *
 * 用法：
 *   node capture-claude-code.js
 *
 * PowerShell 示例：
 *   $env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
 *   $env:ANTHROPIC_API_KEY="dummy"
 *   claude
 *
 * 如果你原来用的是 ANTHROPIC_AUTH_TOKEN，也可以：
 *   $env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
 *   $env:ANTHROPIC_AUTH_TOKEN="dummy"
 *   claude
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(process.cwd(), 'keys.json');
const LISTEN_HOST = process.env.CAPTURE_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.CAPTURE_PORT || 8787);
const LOG_DIR = path.join(process.cwd(), 'claude-capture-logs');

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
    '-',
    String(d.getMilliseconds()).padStart(3, '0'),
  ].join('');
}

function maskSecret(v) {
  if (!v) return v;
  const s = String(v);
  if (s.length <= 16) return s.slice(0, 4) + '***';
  return s.slice(0, 8) + '...' + s.slice(-6);
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (
      lk === 'authorization' ||
      lk === 'x-api-key' ||
      lk === 'api-key' ||
      lk.includes('token') ||
      lk.includes('secret')
    ) {
      out[k] = Array.isArray(v) ? v.map(maskSecret) : maskSecret(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function prettyBody(buf, contentType = '') {
  if (!buf || buf.length === 0) return '';
  const text = buf.toString('utf8');

  if (
    contentType.includes('application/json') ||
    text.trim().startsWith('{') ||
    text.trim().startsWith('[')
  ) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  return text;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`找不到 ${CONFIG_FILE}`);
    process.exit(1);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error(`keys.json 解析失败: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(cfg.keys) || cfg.keys.length === 0) {
    console.error('keys.json 里没有 keys 数组或 keys 为空');
    process.exit(1);
  }

  const entry = cfg.keys.find(k => k.enabled !== false) || cfg.keys[0];

  if (!entry.base_url || !entry.key) {
    console.error('keys.json 的 key 配置必须包含 base_url 和 key');
    process.exit(1);
  }

  return {
    name: entry.name || '(unnamed)',
    baseUrl: String(entry.base_url).replace(/\/$/, ''),
    key: entry.key,
  };
}

function buildUpstreamHeaders(incomingHeaders, key) {
  const headers = { ...incomingHeaders };

  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['accept-encoding'];

  headers['x-api-key'] = key;
  headers['authorization'] = `Bearer ${key}`;

  if (!headers['anthropic-version']) {
    headers['anthropic-version'] = '2023-06-01';
  }

  return headers;
}

async function forwardRequest({ req, body, target }) {
  const upstreamUrl = target.baseUrl + req.url;

  const headers = buildUpstreamHeaders(req.headers, target.key);

  const res = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });

  return res;
}

function writeLogFile(content) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `capture-${nowStamp()}.log`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function appendSection(lines, title, value) {
  lines.push('');
  lines.push(`========== ${title} ==========`);
  lines.push(value || '');
}

async function handle(req, res, target) {
  const started = Date.now();
  const reqBody = await readRequestBody(req);

  const logLines = [];

  logLines.push(`Time: ${new Date().toISOString()}`);
  logLines.push(`Target: ${target.name}`);
  logLines.push(`Upstream base_url: ${target.baseUrl}`);
  logLines.push(`Request: ${req.method} ${req.url}`);

  appendSection(
    logLines,
    'Incoming Headers From Claude Code',
    JSON.stringify(sanitizeHeaders(req.headers), null, 2)
  );

  appendSection(
    logLines,
    'Incoming Body From Claude Code',
    prettyBody(reqBody, req.headers['content-type'] || '')
  );

  console.log('\n' + '='.repeat(90));
  console.log(`[Claude Code → local proxy] ${req.method} ${req.url}`);
  console.log('--- Incoming headers ---');
  console.log(JSON.stringify(sanitizeHeaders(req.headers), null, 2));
  console.log('--- Incoming body ---');
  console.log(prettyBody(reqBody, req.headers['content-type'] || '') || '(empty)');

  let upstreamRes;
  try {
    upstreamRes = await forwardRequest({ req, body: reqBody, target });
  } catch (e) {
    const msg = `转发到上游失败: ${e.stack || e.message}`;
    appendSection(logLines, 'Forward Error', msg);
    const logFile = writeLogFile(logLines.join('\n'));

    console.error(msg);
    console.error(`日志已保存: ${logFile}`);

    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'proxy_forward_error',
        message: e.message,
      },
    }, null, 2));
    return;
  }

  const responseHeaders = {};
  upstreamRes.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });

  console.log('\n[upstream → local proxy]');
  console.log(`HTTP ${upstreamRes.status} ${upstreamRes.statusText}`);
  console.log('--- Upstream response headers ---');
  console.log(JSON.stringify(sanitizeHeaders(responseHeaders), null, 2));

  appendSection(
    logLines,
    'Upstream Response Status',
    `HTTP ${upstreamRes.status} ${upstreamRes.statusText}`
  );

  appendSection(
    logLines,
    'Upstream Response Headers',
    JSON.stringify(sanitizeHeaders(responseHeaders), null, 2)
  );

  res.statusCode = upstreamRes.status;

  for (const [k, v] of Object.entries(responseHeaders)) {
    const lk = k.toLowerCase();
    if (
      lk === 'content-encoding' ||
      lk === 'content-length' ||
      lk === 'transfer-encoding' ||
      lk === 'connection'
    ) {
      continue;
    }
    res.setHeader(k, v);
  }

  const chunks = [];
  const reader = upstreamRes.body?.getReader();

  if (!reader) {
    res.end();
    appendSection(logLines, 'Upstream Response Body', '(empty)');
    const logFile = writeLogFile(logLines.join('\n'));
    console.log(`日志已保存: ${logFile}`);
    return;
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const buf = Buffer.from(value);
    chunks.push(buf);
    res.write(buf);
  }

  res.end();

  const resBody = Buffer.concat(chunks);
  const resContentType = responseHeaders['content-type'] || '';

  console.log('--- Upstream response body ---');
  console.log(prettyBody(resBody, resContentType) || '(empty)');

  appendSection(
    logLines,
    'Upstream Response Body',
    prettyBody(resBody, resContentType)
  );

  appendSection(
    logLines,
    'Elapsed',
    `${Date.now() - started}ms`
  );

  const logFile = writeLogFile(logLines.join('\n'));
  console.log(`\n日志已保存: ${logFile}`);
}

const target = loadConfig();

const server = http.createServer((req, res) => {
  handle(req, res, target).catch(e => {
    console.error('未捕获错误:', e.stack || e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'local_proxy_error',
        message: e.message,
      },
    }, null, 2));
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Claude Code 请求捕获代理已启动: http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`转发目标: ${target.name} -> ${target.baseUrl}`);
  console.log('');
  console.log('PowerShell 示例：');
  console.log(`  $env:ANTHROPIC_BASE_URL="http://${LISTEN_HOST}:${LISTEN_PORT}"`);
  console.log('  $env:ANTHROPIC_API_KEY="dummy"');
  console.log('  claude');
  console.log('');
  console.log('然后在 Claude Code 里发一句 hi，本程序会打印真实请求和真实响应。');
});