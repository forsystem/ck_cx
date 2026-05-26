#!/usr/bin/env node
// Codex Key Rotator
// 多中转站 / 多 API key 轮换：
// 1. 启动前按顺序预检 /v1/responses。
// 2. Codex 运行时通过本地代理访问上游。
// 3. 遇到 key 失效、余额不足、限流、部分上游故障时自动切换下一个 key。
// 4. 保持和原 Claude Code rotator 类似的命令：start/add/list/test/remove/toggle/help。
//
// 适用：OpenAI Codex CLI 新版 Responses API。
// 不适用：只支持 /v1/chat/completions 且完全不支持 /v1/responses 的上游。
// 如果上游只支持 chat/completions，新版 Codex CLI 本身也不能直接正常用，需要额外做协议转换。

const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const DEFAULT_PORT = 8766;
const DEFAULT_TEST_MODEL = 'gpt-5-5';
const FALLBACK_TEST_MODELS = [
  'gpt-5.2',
  'gpt-5.3-codex',
];

const CONFIG_FILE = process.env.CODEX_ROTATOR_CONFIG
  ? path.resolve(process.env.CODEX_ROTATOR_CONFIG)
  : path.join(__dirname, 'codex-keys.json');

const LEGACY_CONFIG_FILE = path.join(__dirname, 'keys.json');
const LOG_FILE = path.join(__dirname, 'codex-rotator.log');

const LOCAL_PROVIDER_ID = 'codex_rotator';
const LOCAL_PROVIDER_KEY_ENV = 'CODEX_ROTATOR_API_KEY';

const SWITCH_STATUS = new Set([401, 402, 403, 407, 429]);
const TRANSIENT_STATUS = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

const MODEL_ERROR_STATUS = new Set([400, 404, 405, 422]);

const sessionStats = {
  startTime: Date.now(),
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

// ---------- 通用工具 ----------

function nowIso() {
  return new Date().toISOString();
}

function logLine(msg) {
  const line = `[${nowIso()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {}
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return k.slice(0, 2) + '***';
  return k.slice(0, 6) + '...' + k.slice(-4);
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function trimRightSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

function safeJsonParse(bufOrText) {
  if (!bufOrText) return null;
  try {
    return JSON.parse(Buffer.isBuffer(bufOrText) ? bufOrText.toString('utf-8') : String(bufOrText));
  } catch {
    return null;
  }
}

function tomlString(s) {
  return JSON.stringify(String(s));
}

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(q, (a) => {
      rl.close();
      resolve(String(a || '').trim());
    });
  });
}

// ---------- 配置 ----------

function configPathForRead() {
  if (fs.existsSync(CONFIG_FILE)) return CONFIG_FILE;

  // 兼容你原来 Claude rotator 的 keys.json。
  // 但保存时仍写入 codex-keys.json，避免和 Claude 版混在一起。
  if (!process.env.CODEX_ROTATOR_CONFIG && fs.existsSync(LEGACY_CONFIG_FILE)) {
    return LEGACY_CONFIG_FILE;
  }

  return CONFIG_FILE;
}

function loadConfig() {
  const p = configPathForRead();

  if (!fs.existsSync(p)) {
    return {
      port: DEFAULT_PORT,
      keys: [],
    };
  }

  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));

    if (!Array.isArray(cfg.keys)) cfg.keys = [];
    if (!cfg.port) cfg.port = DEFAULT_PORT;

    cfg.keys = cfg.keys.map((k, i) => normalizeEntry(k, i));

    return cfg;
  } catch (e) {
    console.error(`配置文件解析失败: ${p}`);
    console.error(e.message);
    process.exit(1);
  }
}

function saveConfig(cfg) {
  const out = {
    port: Number(cfg.port || DEFAULT_PORT),
    keys: Array.isArray(cfg.keys) ? cfg.keys : [],
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2), 'utf-8');
}

function normalizeEntry(entry, index = 0) {
  const e = { ...(entry || {}) };

  if (!e.name) e.name = `key-${index + 1}`;
  if (typeof e.base_url === 'string') e.base_url = trimRightSlash(e.base_url.trim());
  if (typeof e.key === 'string') e.key = e.key.trim();
  if (!e.test_model) e.test_model = DEFAULT_TEST_MODEL;
  if (typeof e.enabled !== 'boolean') e.enabled = true;

  return e;
}

function validateEntry(entry) {
  if (!entry.base_url) return 'base_url 不能为空';
  if (!isHttpUrl(entry.base_url)) return 'base_url 必须以 http:// 或 https:// 开头';
  if (!entry.key) return 'key 不能为空';
  return '';
}

// ---------- URL 拼接 ----------

function buildEndpointUrl(baseUrl, endpointPath) {
  const base = trimRightSlash(baseUrl);
  const endpoint = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;

  // 如果用户误把 base_url 写成了 https://xxx/v1/responses，
  // 预检时就直接用它，避免拼成 /responses/responses。
  if (endpoint === '/responses' && /\/responses$/i.test(base)) {
    return base;
  }

  return base + endpoint;
}

function joinUpstreamUrl(baseUrl, incomingUrl) {
  const base = trimRightSlash(baseUrl);
  const incoming = new URL(incomingUrl || '/', 'http://rotator.local');

  let pathname = incoming.pathname || '/';

  // Codex 侧 provider base_url 通常设成 http://127.0.0.1:8766/v1，
  // 所以进入本地代理的路径大概率是 /v1/responses。
  //
  // 如果上游 base_url 也已经以 /v1 结尾，比如 https://right.codes/codex/v1，
  // 需要把本地请求里的 /v1 去掉，避免转发成 /v1/v1/responses。
  try {
    const b = new URL(base);
    const basePath = trimRightSlash(b.pathname || '');
    if (basePath.endsWith('/v1') && pathname.startsWith('/v1/')) {
      pathname = pathname.slice('/v1'.length);
    } else if (basePath.endsWith('/v1') && pathname === '/v1') {
      pathname = '/';
    }
  } catch {
    // validateEntry 已经检查 URL，这里只是兜底。
  }

  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  return base + pathname + incoming.search;
}

// ---------- 错误解析 ----------

function parseErrorBody(text) {
  if (!text) return '';

  const raw = text.toString();

  try {
    const j = JSON.parse(raw);

    const msg =
      j?.error?.message ??
      j?.error?.error?.message ??
      j?.message ??
      j?.detail ??
      j?.msg ??
      j?.error_description ??
      j?.error;

    if (typeof msg === 'string' && msg.trim()) {
      const type =
        j?.error?.type ??
        j?.error?.code ??
        j?.type ??
        j?.code ??
        j?.status;

      return type ? `${msg} (type=${type})` : msg;
    }

    if (typeof msg === 'object' && msg) {
      return JSON.stringify(msg).slice(0, 600);
    }
  } catch {}

  return raw.replace(/\s+/g, ' ').trim().slice(0, 600);
}

function formatNetworkError(e) {
  if (!e) return '未知错误';

  const code = e.code || e.cause?.code || e.errno || e.cause?.errno;
  const name = e.name || e.cause?.name;

  if (name === 'AbortError') {
    return '请求超时，可能是中转站卡死、网络不通或模型长时间无响应';
  }

  switch (code) {
    case 'ENOTFOUND':
      return `DNS 解析失败：base_url 域名不存在或无法解析（${code}）`;
    case 'ECONNREFUSED':
      return `连接被拒绝：服务器没有监听对应端口（${code}）`;
    case 'ECONNRESET':
      return `连接被重置：上游可能主动断开连接（${code}）`;
    case 'ETIMEDOUT':
      return `TCP 连接超时：网络不通或被防火墙阻断（${code}）`;
    case 'EAI_AGAIN':
      return `DNS 临时失败，稍后重试（${code}）`;
    case 'CERT_HAS_EXPIRED':
      return `上游 TLS 证书已过期（${code}）`;
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `上游 TLS 证书不被信任（${code}）`;
    case 'ERR_INVALID_URL':
      return 'base_url 不是合法 URL';
  }

  return e.message || String(e);
}

function looksLikeQuotaOrAuthProblem(text) {
  const s = String(text || '').toLowerCase();

  return [
    'insufficient_quota',
    'quota',
    'balance',
    'billing',
    'payment',
    'credit',
    'credits',
    '额度',
    '余额',
    '欠费',
    '无可用',
    'rate limit',
    'rate_limit',
    'too many requests',
    'unauthorized',
    'forbidden',
    'invalid api key',
    'invalid key',
    'api key',
    '令牌',
    'token',
  ].some((x) => s.includes(x));
}

function shouldSwitchOnResponse(status, text) {
  if (SWITCH_STATUS.has(status)) return true;
  if (TRANSIENT_STATUS.has(status)) return true;

  // 有些中转站会把余额不足、key 无效、渠道限流包装成 400/422。
  // 但普通 400 也可能是请求参数错误，所以只在错误文本明显是 key/额度/限流时切换。
  if ((status === 400 || status === 409 || status === 422) && looksLikeQuotaOrAuthProblem(text)) {
    return true;
  }

  return false;
}

// ---------- Responses API 预检 ----------

function buildResponsesPreflight(entry, model) {
  const url = buildEndpointUrl(entry.base_url, '/responses');

  return {
    url,
    model,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${entry.key}`,
      'x-api-key': entry.key,
    },
    body: {
      model,
      input: 'Say OK.',
      max_output_tokens: 16,
      stream: false,
    },
  };
}

async function testKey(entry, model, timeoutMs = 60000) {
  const req = buildResponsesPreflight(entry, model);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });

    clearTimeout(t);

    const text = await res.text().catch(() => '');

    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        model,
        responseSample: text.slice(0, 600),
      };
    }

    return {
      ok: false,
      status: res.status,
      statusText: res.statusText || '',
      errorBody: parseErrorBody(text),
      rawBody: text.slice(0, 1000),
      model,
      responsesUnsupported: res.status === 404 || res.status === 405,
      transient: TRANSIENT_STATUS.has(res.status),
      shouldSwitch: shouldSwitchOnResponse(res.status, text),
    };
  } catch (e) {
    clearTimeout(t);

    return {
      ok: false,
      networkError: formatNetworkError(e),
      model,
      transient: true,
      shouldSwitch: true,
    };
  }
}

async function testKeyWithFallback(entry) {
  const candidates = unique([
    entry.test_model || DEFAULT_TEST_MODEL,
  ]);

  const tried = [];

  for (const model of candidates) {
    const r = await testKey(entry, model);
    tried.push(r);

    if (r.ok) {
      return {
        ok: true,
        model: r.model,
        tried,
      };
    }

    if (r.networkError) {
      return {
        ok: false,
        transient: true,
        tried,
      };
    }

    // 认证、余额、限流、服务端故障：换模型通常没意义，直接结束。
    if (r.shouldSwitch && !MODEL_ERROR_STATUS.has(r.status)) {
      return {
        ok: false,
        transient: !!r.transient,
        tried,
      };
    }

    // /responses 不存在或方法不允许，说明这个上游不适合新版 Codex。
    if (r.responsesUnsupported) {
      return {
        ok: false,
        responsesUnsupported: true,
        tried,
      };
    }

    // 只有模型名错误/不支持这一类，才继续换 fallback model 测。
    if (r.status && !MODEL_ERROR_STATUS.has(r.status)) {
      return {
        ok: false,
        transient: !!r.transient,
        tried,
      };
    }
  }

  return {
    ok: false,
    transient: tried.some((r) => r.transient),
    responsesUnsupported: tried.some((r) => r.responsesUnsupported),
    tried,
  };
}

function describeAttempt(r) {
  if (r.ok) return [`模型 ${r.model} → OK`];

  if (r.networkError) {
    return [`模型 ${r.model} → 网络错误：${r.networkError}`];
  }

  const flags = [];
  if (r.transient) flags.push('暂时性错误');
  if (r.responsesUnsupported) flags.push('上游可能不支持 /v1/responses');

  const head = `模型 ${r.model} → HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}${flags.length ? `（${flags.join('，')}）` : ''}`;

  return r.errorBody ? [head, `响应：${r.errorBody}`] : [head];
}

function printTestFailure(result, indent = '        ') {
  const tried = result.tried || [];

  if (tried.length === 0) {
    console.log(`${indent}(没有可尝试的模型)`);
    return;
  }

  if (tried.length === 1) {
    const lines = describeAttempt(tried[0]);
    lines.forEach((ln, i) => {
      console.log(indent + (i === 0 ? '' : '     ') + ln);
    });
    return;
  }

  console.log(`${indent}所有模型都失败：`);
  tried.forEach((r, i) => {
    const isLast = i === tried.length - 1;
    const head = isLast ? '└─ ' : '├─ ';
    const cont = isLast ? '   ' : '│  ';
    const lines = describeAttempt(r);

    lines.forEach((ln, j) => {
      console.log(indent + '  ' + (j === 0 ? head : cont) + (j === 0 ? '' : '   ') + ln);
    });
  });
}

// ---------- usage 统计 ----------

function recordUsage(usage) {
  if (!usage || typeof usage !== 'object') return;

  const input = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const output = Number(usage.output_tokens || usage.completion_tokens || 0);
  const total = Number(usage.total_tokens || input + output || 0);

  const cached =
    Number(usage.input_tokens_details?.cached_tokens || 0) ||
    Number(usage.prompt_tokens_details?.cached_tokens || 0) ||
    Number(usage.cache_read_input_tokens || 0);

  const reasoning =
    Number(usage.output_tokens_details?.reasoning_tokens || 0) ||
    Number(usage.completion_tokens_details?.reasoning_tokens || 0) ||
    0;

  if (input || output || total || cached || reasoning) {
    sessionStats.requests++;
    sessionStats.inputTokens += input;
    sessionStats.cachedInputTokens += cached;
    sessionStats.outputTokens += output;
    sessionStats.reasoningOutputTokens += reasoning;
    sessionStats.totalTokens += total;
  }
}

function maybeRecordUsageFromObject(d) {
  if (!d || typeof d !== 'object') return;

  if (d.usage) recordUsage(d.usage);
  if (d.response?.usage) recordUsage(d.response.usage);
}

function printSessionStats() {
  if (sessionStats.requests === 0) return;

  const elapsedSec = Math.round((Date.now() - sessionStats.startTime) / 1000);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');

  const totalInputForCache = sessionStats.inputTokens || 0;
  const hitRate = totalInputForCache > 0
    ? (sessionStats.cachedInputTokens / totalInputForCache * 100).toFixed(1)
    : '0.0';

  console.log(`
====== 本次 Codex 会话统计 ======
时长:                ${elapsedSec} 秒
请求数:              ${sessionStats.requests}
输入 tokens:         ${fmt(sessionStats.inputTokens)}
缓存命中 tokens:     ${fmt(sessionStats.cachedInputTokens)}
输出 tokens:         ${fmt(sessionStats.outputTokens)}
推理输出 tokens:     ${fmt(sessionStats.reasoningOutputTokens)}
总 tokens:           ${fmt(sessionStats.totalTokens)}
缓存命中率:          ${hitRate}%
================================
`);
}

// ---------- 代理 ----------

function startProxy(cfg, startIndex) {
  const state = {
    idx: startIndex,
    deadKeys: new Set(),
  };

  function pickNext() {
    const n = cfg.keys.length;

    for (let step = 1; step <= n; step++) {
      const i = (state.idx + step) % n;
      const k = cfg.keys[i];

      if (k && k.enabled !== false && !state.deadKeys.has(i)) {
        return i;
      }
    }

    return -1;
  }

  function currentEntry() {
    return cfg.keys[state.idx];
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    if (req.url === '/__rotator/health') {
      const k = currentEntry();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        current: k ? k.name : null,
        dead: [...state.deadKeys],
      }));
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    let attempt = 0;
    const maxAttempts = Math.max(1, cfg.keys.length);

    while (attempt < maxAttempts) {
      if (state.deadKeys.has(state.idx) || cfg.keys[state.idx]?.enabled === false) {
        const next = pickNext();
        if (next === -1) break;
        state.idx = next;
      }

      const entry = cfg.keys[state.idx];
      if (!entry) break;

      const tag = entry.name || maskKey(entry.key);
      const upstream = joinUpstreamUrl(entry.base_url, req.url);

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();

        if ([
          'host',
          'content-length',
          'connection',
          'authorization',
          'x-api-key',
          'openai-organization',
          'openai-project',
        ].includes(lk)) {
          continue;
        }

        headers[k] = v;
      }

      headers['Authorization'] = `Bearer ${entry.key}`;
      headers['x-api-key'] = entry.key;

      if (!headers['Accept'] && !headers['accept']) {
        headers['Accept'] = 'application/json';
      }

      let upstreamRes;

      try {
        upstreamRes = await fetch(upstream, {
          method: req.method,
          headers,
          body: body.length ? body : undefined,
          duplex: 'half',
        });
      } catch (e) {
        const msg = formatNetworkError(e);

        console.log(`\n[rotator] "${tag}" 网络错误，自动切换：${msg}`);
        logLine(`[${tag}] network_error: ${msg}`);

        state.deadKeys.add(state.idx);
        attempt++;

        const next = pickNext();
        if (next === -1) break;

        console.log(`[rotator] 切换到 "${cfg.keys[next].name || maskKey(cfg.keys[next].key)}"`);
        state.idx = next;
        continue;
      }

      if (shouldSwitchOnResponse(upstreamRes.status, '')) {
        const errText = await upstreamRes.text().catch(() => '');
        if (shouldSwitchOnResponse(upstreamRes.status, errText)) {
          console.log(`\n[rotator] key "${tag}" 可能失效或上游不可用（HTTP ${upstreamRes.status}），自动切换`);
          const parsed = parseErrorBody(errText);
          if (parsed) console.log(`[rotator] 响应：${parsed}`);

          logLine(`[${tag}] ${upstreamRes.status}: ${errText.slice(0, 500)}`);

          state.deadKeys.add(state.idx);
          attempt++;

          const next = pickNext();
          if (next === -1) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                type: 'rotator_exhausted',
                message: '所有 key 均已失效、耗尽或上游暂时不可用',
              },
            }));
            return;
          }

          console.log(`[rotator] 切换到 "${cfg.keys[next].name || maskKey(cfg.keys[next].key)}"`);
          state.idx = next;
          continue;
        }

        // 状态码看起来像可切换，但 body 不像 key/额度问题，按原响应返回。
        const respHeaders = {};
        upstreamRes.headers.forEach((v, k) => {
          if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) {
            respHeaders[k] = v;
          }
        });

        res.writeHead(upstreamRes.status, respHeaders);
        res.end(errText);
        return;
      }

      const respHeaders = {};
      upstreamRes.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) {
          respHeaders[k] = v;
        }
      });

      res.writeHead(upstreamRes.status, respHeaders);

      if (!upstreamRes.body) {
        res.end();
        return;
      }

      const upstreamStream = Readable.fromWeb(upstreamRes.body);
      const contentType = String(respHeaders['content-type'] || respHeaders['Content-Type'] || '').toLowerCase();
      const isSSE = contentType.includes('event-stream');

      if (isSSE) {
        let buf = '';

        upstreamStream.on('data', (chunk) => {
          buf += chunk.toString('utf-8');

          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);

            if (!line.startsWith('data:')) continue;

            const json = line.slice(line[5] === ' ' ? 6 : 5).trim();
            if (!json || json === '[DONE]') continue;

            try {
              const d = JSON.parse(json);
              maybeRecordUsageFromObject(d);
            } catch {}
          }
        });

        upstreamStream.on('error', (e) => {
          logLine(`[${tag}] stream_error: ${e.message || e}`);
        });

        upstreamStream.pipe(res);
      } else {
        const parts = [];

        upstreamStream.on('data', (chunk) => {
          parts.push(Buffer.from(chunk));
        });

        upstreamStream.on('end', () => {
          const full = Buffer.concat(parts);

          try {
            const d = JSON.parse(full.toString('utf-8'));
            maybeRecordUsageFromObject(d);
          } catch {}

          res.end(full);
        });

        upstreamStream.on('error', (e) => {
          logLine(`[${tag}] response_stream_error: ${e.message || e}`);
          try {
            res.end();
          } catch {}
        });
      }

      return;
    }

    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'rotator_exhausted',
        message: '所有 key 均已失效、耗尽或不可用',
      },
    }));
  });

  return new Promise((resolve, reject) => {
    const maxOffset = 20;
    let offset = 0;

    const tryListen = () => {
      const onError = (e) => {
        server.removeListener('error', onError);

        if (e.code === 'EADDRINUSE' && offset < maxOffset) {
          offset++;
          tryListen();
          return;
        }

        reject(e);
      };

      server.once('error', onError);

      server.listen(cfg.port + offset, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(server);
      });
    };

    tryListen();
  });
}

// ---------- Codex 启动 ----------

function hasModelOverride(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);

    if (a === '-m' || a === '--model') return true;
    if (a.startsWith('--model=')) return true;

    if (a === '-c' || a === '--config') {
      const next = String(args[i + 1] || '').trim();
      if (next === 'model' || next.startsWith('model=')) return true;
      if (next.startsWith('model_provider=')) {
        // 用户自己指定 provider 时，最好不再强行注入 model。
        return true;
      }
    }

    if (a.startsWith('-c') && a.includes('model=')) return true;
    if (a.startsWith('--config') && a.includes('model=')) return true;
  }

  return false;
}

function buildCodexArgs(localBaseUrlWithV1, model, extraArgs) {
  const args = [];

  args.push('-c', `model_provider=${tomlString(LOCAL_PROVIDER_ID)}`);
  args.push('-c', `model_providers.${LOCAL_PROVIDER_ID}.name=${tomlString('Codex Rotator')}`);
  args.push('-c', `model_providers.${LOCAL_PROVIDER_ID}.base_url=${tomlString(localBaseUrlWithV1)}`);
  args.push('-c', `model_providers.${LOCAL_PROVIDER_ID}.env_key=${tomlString(LOCAL_PROVIDER_KEY_ENV)}`);
  args.push('-c', `model_providers.${LOCAL_PROVIDER_ID}.wire_api=${tomlString('responses')}`);
  args.push('-c', `model_providers.${LOCAL_PROVIDER_ID}.requires_openai_auth=false`);

  // 让 rotator 自己处理重试和切换，避免 Codex 对同一个失败 key 重试多次。
  args.push('-c', `model_providers.${LOCAL_PROVIDER_ID}.request_max_retries=0`);
  args.push('-c', `model_providers.${LOCAL_PROVIDER_ID}.stream_max_retries=0`);
  args.push('-c', `model_providers.${LOCAL_PROVIDER_ID}.stream_idle_timeout_ms=600000`);

  if (model && !hasModelOverride(extraArgs)) {
    args.push('-c', `model=${tomlString(model)}`);
  }

  return [...args, ...extraArgs];
}

async function cmdStart(extraArgs) {
  const skipTestIndex = extraArgs.indexOf('--no-test');
  const skipTest = skipTestIndex >= 0;
  if (skipTest) extraArgs.splice(skipTestIndex, 1);

  const cfg = loadConfig();

  if (!Array.isArray(cfg.keys) || cfg.keys.length === 0) {
    console.error('还没有任何 key，请先运行：cx add');
    process.exit(1);
  }

  let firstOk = -1;
  let firstOkModel = null;
  let firstTransient = -1;
  let firstTransientModel = null;

  if (!skipTest) {
    console.log('按顺序测试 key（Responses API /v1/responses）...');

    for (let i = 0; i < cfg.keys.length; i++) {
      const k = cfg.keys[i];
      const label = `  [${i + 1}/${cfg.keys.length}] ${k.name || maskKey(k.key)}`;

      if (k.enabled === false) {
        console.log(`${label} — 已禁用，跳过`);
        continue;
      }

      const invalid = validateEntry(k);
      if (invalid) {
        console.log(`${label} — 配置无效：${invalid}`);
        continue;
      }

      process.stdout.write(`${label} ... `);

      const r = await testKeyWithFallback(k);

      if (r.ok) {
        console.log(`✓ OK  (model: ${r.model})`);
        firstOk = i;
        firstOkModel = r.model;
        break;
      }

      const last = r.tried[r.tried.length - 1] || {};
      const tag = last.networkError
        ? '网络错误'
        : (last.status ? `HTTP ${last.status}` : '未知错误');

      if (r.transient && firstTransient === -1) {
        firstTransient = i;
        firstTransientModel = k.test_model || DEFAULT_TEST_MODEL;
        console.log(`⚠ ${tag}（暂时性错误，先记为候选）`);
      } else {
        console.log(`✗ ${tag}`);
      }

      printTestFailure(r);
    }

    if (firstOk === -1 && firstTransient !== -1) {
      console.log(`\n⚠ 没有 key 完全通过预检，但 "${cfg.keys[firstTransient].name || maskKey(cfg.keys[firstTransient].key)}" 只是暂时性失败。`);
      console.log('  先启动 rotator；真实 Codex 请求会继续按运行时响应决定是否切换。\n');

      firstOk = firstTransient;
      firstOkModel = firstTransientModel;
    }

    if (firstOk === -1) {
      console.error('\n所有 key 测试都失败了，无法启动。');
      console.error('请重点检查：');
      console.error('  1. base_url 是否应该以 /v1 结尾；');
      console.error('  2. 上游是否支持 /v1/responses；');
      console.error('  3. key 是否有效、余额是否足够；');
      console.error('  4. test_model 是否是该上游真实支持的 Codex/Responses 模型。');
      process.exit(1);
    }
  } else {
    for (let i = 0; i < cfg.keys.length; i++) {
      const k = cfg.keys[i];
      if (k.enabled !== false && !validateEntry(k)) {
        firstOk = i;
        firstOkModel = k.test_model || DEFAULT_TEST_MODEL;
        break;
      }
    }

    if (firstOk === -1) {
      console.error('没有可用 key。');
      process.exit(1);
    }

    console.log(`跳过预检，使用 "${cfg.keys[firstOk].name || maskKey(cfg.keys[firstOk].key)}" 启动。`);
  }

  console.log(`使用 "${cfg.keys[firstOk].name || maskKey(cfg.keys[firstOk].key)}"，启动本地代理...`);

  let server;
  try {
    server = await startProxy(cfg, firstOk);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${cfg.port} 到 ${cfg.port + 20} 都被占用，无法启动代理。`);
    } else {
      console.error(`启动代理失败：${e.message}`);
    }
    process.exit(1);
  }

  const actualPort = server.address().port;
  const localRoot = `http://127.0.0.1:${actualPort}`;
  const localBaseUrlWithV1 = `${localRoot}/v1`;

  if (actualPort !== cfg.port) {
    console.log(`代理监听 ${localRoot}（默认端口 ${cfg.port} 被占用，自动改用 ${actualPort}）`);
  } else {
    console.log(`代理监听 ${localRoot}`);
  }

  console.log(`Codex provider base_url = ${localBaseUrlWithV1}`);
  console.log('启动 Codex...\n');

  const env = {
    ...process.env,
    [LOCAL_PROVIDER_KEY_ENV]: 'rotator-managed',
  };

  const codexArgs = buildCodexArgs(localBaseUrlWithV1, firstOkModel, extraArgs);
  const codexCmd = process.platform === 'win32' ? 'codex.cmd' : 'codex';

  const child = spawn(codexCmd, codexArgs, {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const shutdown = () => {
    try {
      server.close();
    } catch {}

    if (!child.killed) {
      try {
        child.kill();
      } catch {}
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  child.on('exit', (code) => {
    try {
      server.close();
    } catch {}

    printSessionStats();
    process.exit(code ?? 0);
  });

  child.on('error', (e) => {
    console.error(`无法启动 codex：${e.message}`);
    console.error('请确认已经安装 Codex CLI，例如：npm install -g @openai/codex');

    try {
      server.close();
    } catch {}

    process.exit(1);
  });
}

// ---------- 命令：add / remove / list / test / toggle ----------

async function cmdAdd(args) {
  const cfg = loadConfig();

  let name;
  let base_url;
  let key;
  let test_model;

  if (args.length >= 3) {
    [name, base_url, key, test_model] = args;
  } else {
    name = await prompt('名称（自己起一个备注名）: ');
    base_url = await prompt('base_url（例如 https://api.xxx.com/v1）: ');
    key = await prompt('key（sk-...）: ');
    test_model = await prompt(`测试模型（默认 ${DEFAULT_TEST_MODEL}）: `);
  }

  const entry = normalizeEntry({
    name: name || `key-${cfg.keys.length + 1}`,
    base_url,
    key,
    enabled: true,
    test_model: test_model || DEFAULT_TEST_MODEL,
  }, cfg.keys.length);

  const invalid = validateEntry(entry);
  if (invalid) {
    console.error(invalid);
    process.exit(1);
  }

  cfg.keys.push(entry);
  saveConfig(cfg);

  console.log(`已添加。当前共 ${cfg.keys.length} 个 key。`);
  console.log(`配置文件：${CONFIG_FILE}`);
}

async function cmdRemove(args) {
  const cfg = loadConfig();

  if (!cfg.keys.length) {
    console.log('(空)');
    return;
  }

  let idx;

  if (args[0]) {
    idx = parseInt(args[0], 10) - 1;
  } else {
    listKeys(cfg);
    const ans = await prompt('删除哪个？输入编号: ');
    idx = parseInt(ans, 10) - 1;
  }

  if (isNaN(idx) || idx < 0 || idx >= cfg.keys.length) {
    console.error('无效编号');
    process.exit(1);
  }

  const removed = cfg.keys.splice(idx, 1)[0];
  saveConfig(cfg);

  console.log(`已删除 "${removed.name}"`);
}

function listKeys(cfg) {
  if (!cfg.keys.length) {
    console.log('(还没有添加任何 key)');
    return;
  }

  cfg.keys.forEach((k, i) => {
    const flag = k.enabled === false ? '[禁用]' : '      ';
    console.log(`${String(i + 1).padStart(2)}. ${flag} ${k.name}`);
    console.log(`     base_url:   ${k.base_url}`);
    console.log(`     key:        ${maskKey(k.key)}`);
    console.log(`     test_model: ${k.test_model || DEFAULT_TEST_MODEL}`);
  });
}

function cmdList() {
  const cfg = loadConfig();
  listKeys(cfg);
}

async function cmdTest() {
  const cfg = loadConfig();

  if (!cfg.keys.length) {
    console.log('(空)');
    return;
  }

  let okCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < cfg.keys.length; i++) {
    const k = cfg.keys[i];

    process.stdout.write(`[${i + 1}] ${k.name || maskKey(k.key)} ... `);

    if (k.enabled === false) {
      console.log('禁用，跳过');
      skippedCount++;
      continue;
    }

    const invalid = validateEntry(k);
    if (invalid) {
      console.log(`配置无效：${invalid}`);
      failCount++;
      continue;
    }

    const r = await testKeyWithFallback(k);

    if (r.ok) {
      console.log(`✓ OK  (model: ${r.model})`);
      okCount++;
      continue;
    }

    const last = r.tried[r.tried.length - 1] || {};
    const tag = last.networkError
      ? '网络错误'
      : (last.status ? `HTTP ${last.status}` : '未知错误');

    console.log(`✗ ${tag}`);
    printTestFailure(r, '    ');
    failCount++;
  }

  console.log(`\n合计: ${okCount} 可用 / ${failCount} 失败 / ${skippedCount} 跳过`);
}

async function cmdToggle(args) {
  const cfg = loadConfig();

  const idx = parseInt(args[0], 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= cfg.keys.length) {
    console.error('用法: cx toggle <编号>');
    process.exit(1);
  }

  cfg.keys[idx].enabled = cfg.keys[idx].enabled === false;
  saveConfig(cfg);

  console.log(`"${cfg.keys[idx].name}" 现在 ${cfg.keys[idx].enabled ? '启用' : '禁用'}`);
}

async function cmdSetModel(args) {
  const cfg = loadConfig();

  const idx = parseInt(args[0], 10) - 1;
  const model = args[1];

  if (isNaN(idx) || idx < 0 || idx >= cfg.keys.length || !model) {
    console.error('用法: cx model <编号> <模型名>');
    process.exit(1);
  }

  cfg.keys[idx].test_model = model;
  saveConfig(cfg);

  console.log(`"${cfg.keys[idx].name}" 的 test_model 已改为 ${model}`);
}

function cmdHelp() {
  console.log(`Codex Key Rotator

用法:
  cx
  node codex-rotator.js
      启动 Codex（按顺序测试 key，用第一个可用的；运行中失效自动换下一个）

  cx start [...]
  node codex-rotator.js start [...]
      同上，多余参数透传给 codex

  cx start --no-test [...]
      跳过预检，直接用第一个启用的 key 启动

  cx add
  node codex-rotator.js add
      交互式添加 key

  cx add <name> <base_url> <key> [test_model]
  node codex-rotator.js add right-codes https://right.codes/codex/v1 sk-xxx gpt-5.3-low
      一行命令添加 key

  cx list
      列出所有 key

  cx test
      测试所有 key 的 /v1/responses 可用性

  cx remove [编号]
      删除 key

  cx toggle <编号>
      启用/禁用某个 key

  cx model <编号> <模型名>
      修改某个 key 的 test_model

  cx help
      显示帮助

配置文件:
  ${CONFIG_FILE}

兼容读取:
  如果 ${CONFIG_FILE} 不存在，但 ${LEGACY_CONFIG_FILE} 存在，会读取旧 keys.json。
  保存时仍写入 ${CONFIG_FILE}。

代理日志:
  ${LOG_FILE}

注意:
  1. Codex 新版自定义 provider 走 Responses API，所以你的上游必须支持 /v1/responses。
  2. base_url 建议写到 /v1，例如 https://api.xxx.com/v1。
  3. 如果你的上游 base_url 已经是 https://xxx/codex/v1，也可以直接填。
  4. 本脚本只监听 127.0.0.1，不会暴露到局域网。
`);
}

// ---------- 入口 ----------

const [, , cmd, ...rest] = process.argv;

const handler = {
  add: cmdAdd,
  remove: cmdRemove,
  rm: cmdRemove,
  list: cmdList,
  ls: cmdList,
  test: cmdTest,
  toggle: cmdToggle,
  model: cmdSetModel,
  start: cmdStart,
  help: cmdHelp,
  '-h': cmdHelp,
  '--help': cmdHelp,
}[cmd || 'start'];

if (!handler) {
  console.error(`未知命令: ${cmd}`);
  cmdHelp();
  process.exit(1);
}

Promise.resolve(handler(rest)).catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exit(1);
});