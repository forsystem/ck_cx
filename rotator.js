#!/usr/bin/env node
// Claude Code Key Rotator
// 多中转站 API key 轮换：启动前按顺序预检，使用过程中检测到 key 失效/额度耗尽时自动切换。
//claude-haiku-4-5-20251001
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { randomUUID } = require('crypto');

const CONFIG_FILE = path.join(__dirname, 'keys.json');
const LOG_FILE = path.join(__dirname, 'rotator.log');
const DEFAULT_PORT = 8765;
const TEST_MODEL_DEFAULT = 'claude-opus-4-7[1m]';
const TEST_MODEL_FALLBACK = 'claude-3-5-haiku-20241022';
const SWITCH_STATUS = new Set([401, 402, 403, 407, 429]);
const TRANSIENT_STATUS = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

const CLAUDE_CODE_BETAS = [
  'claude-code-20250219',
  'context-1m-2025-08-07',
  'interleaved-thinking-2025-05-14',
  'redact-thinking-2026-02-12',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'advisor-tool-2026-03-01',
  'effort-2025-11-24',
];


// ---------- 会话统计（仅本次 ck 运行期间累计） ----------
const sessionStats = {
  startTime: Date.now(),
  requests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
};

// ---------- 配置 ----------
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { port: DEFAULT_PORT, keys: [] };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (!Array.isArray(cfg.keys)) cfg.keys = [];
    if (!cfg.port) cfg.port = DEFAULT_PORT;
    return cfg;
  } catch (e) {
    console.error(`keys.json 解析失败: ${e.message}`);
    process.exit(1);
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return k.slice(0, 2) + '***';
  return k.slice(0, 6) + '...' + k.slice(-4);
}

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// ---------- 错误解析工具 ----------
// 把中转站返回的错误 body 解析成一段人话。中转站通常返回 JSON
// （Anthropic / OpenAI 兼容），都带 error.message 或 message 字段。
function parseErrorBody(text) {
  if (!text) return '';
  const raw = text.toString();
  try {
    const j = JSON.parse(raw);
    const msg = j?.error?.message
      ?? j?.error?.error?.message
      ?? j?.message
      ?? j?.detail
      ?? j?.msg
      ?? j?.error;
    if (typeof msg === 'string' && msg.trim()) {
      const type = j?.error?.type || j?.error?.code || j?.type || j?.code;
      return type ? `${msg} (type=${type})` : msg;
    }
  } catch {}
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// 把 fetch / Node 网络错误翻译成人能看懂的提示。
function formatNetworkError(e) {
  if (!e) return '未知错误';
  const code = e.code || e.cause?.code || e.errno || e.cause?.errno;
  const name = e.name || e.cause?.name;
  if (name === 'AbortError') return '请求超时（20 秒未返回，可能是中转站卡死或网络不通）';
  switch (code) {
    case 'ENOTFOUND':       return `DNS 解析失败 — base_url 域名不存在或无法解析（${code}）`;
    case 'ECONNREFUSED':    return `连接被拒绝 — 域名解析到的服务器没有监听该端口（${code}）`;
    case 'ECONNRESET':      return `连接被对端重置 — 中转站可能在 TLS/HTTP 握手阶段就拒绝了（${code}）`;
    case 'ETIMEDOUT':       return `TCP 连接超时 — 网络不通或被防火墙阻断（${code}）`;
    case 'EAI_AGAIN':       return `DNS 临时失败,稍后重试（${code}）`;
    case 'CERT_HAS_EXPIRED':           return `中转站 TLS 证书已过期（${code}）`;
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':  return `中转站 TLS 证书不被信任（${code}）`;
    case 'ERR_INVALID_URL': return `base_url 不是合法的 URL`;
  }
  return e.message || String(e);
}

// ---------- 测试单个 key ----------
function parseTestModel(modelStr) {
  const raw = String(modelStr || '').trim();
  const is1m = /\[1m\]$/i.test(raw);
  const model = is1m ? raw.replace(/\[1m\]$/i, '') : raw;

  return {
    rawModel: raw,
    model,
    claudeCodeLike: is1m,
  };
}

function buildClaudeCodePreflight(entry, modelStr) {
  const parsed = parseTestModel(modelStr);
  const sessionId = randomUUID();

  if (!parsed.claudeCodeLike) {
    return {
      url: entry.base_url.replace(/\/$/, '') + '/v1/messages',
      actualModel: parsed.model,
      body: {
        model: parsed.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      },
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': entry.key,
        'Authorization': `Bearer ${entry.key}`,
        'anthropic-version': '2023-06-01',
      },
    };
  }

  return {
    url: entry.base_url.replace(/\/$/, '') + '/v1/messages?beta=true',
    actualModel: parsed.model,
    body: {
      model: parsed.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.150.32b; cc_entrypoint=cli; cch=rotator;',
        },
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: 'ephemeral' },
        },
      ],
      metadata: {
        user_id: JSON.stringify({
          device_id: 'rotator-preflight',
          account_uuid: '',
          session_id: sessionId,
        }),
      },
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      context_management: {
        edits: [
          {
            type: 'clear_thinking_20251015',
            keep: 'all',
          },
        ],
      },
      output_config: {
        effort: 'high',
      },
      stream: true,
    },
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-cli/2.1.150 (external, cli)',
      'x-claude-code-session-id': sessionId,
      'x-stainless-arch': process.arch === 'x64' ? 'x64' : process.arch,
      'x-stainless-lang': 'js',
      'x-stainless-os': process.platform === 'win32' ? 'Windows' : process.platform,
      'x-stainless-package-version': '0.94.0',
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': process.version,
      'x-stainless-timeout': '600',
      'anthropic-beta': CLAUDE_CODE_BETAS.join(','),
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'x-api-key': entry.key,
      'Authorization': `Bearer ${entry.key}`,
      'x-app': 'cli',
    },
  };
}

async function testKey(entry, model) {
  const req = buildClaudeCodePreflight(entry, model);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);

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
        actualModel: req.actualModel,
        claudeCodeLike: !!parseTestModel(model).claudeCodeLike,
        responseSample: text.slice(0, 600),
      };
    }

    return {
      ok: false,
      status: res.status,
      statusText: res.statusText || '',
      errorBody: parseErrorBody(text),
      rawBody: text.slice(0, 600),
      model,
      actualModel: req.actualModel,
      claudeCodeLike: !!parseTestModel(model).claudeCodeLike,
      transient: TRANSIENT_STATUS.has(res.status),
    };
  } catch (e) {
    clearTimeout(t);
    return {
      ok: false,
      networkError: formatNetworkError(e),
      model,
      actualModel: req.actualModel,
      claudeCodeLike: !!parseTestModel(model).claudeCodeLike,
      transient: true,
    };
  }
}

// 4xx 中,只有这些值得换 model 再试一次(模型名不对/不支持)。
// 401/402/403/407/429 等是 key 本身的问题,换 model 救不了。
const MODEL_ERROR_STATUS = new Set([400, 404, 422]);

async function testKeyWithFallback(entry) {
  const candidates = [];
  if (entry.test_model) candidates.push(entry.test_model);
  candidates.push(TEST_MODEL_DEFAULT, TEST_MODEL_FALLBACK);
  const models = [...new Set(candidates)];

  const tried = [];
  for (const m of models) {
    const r = await testKey(entry, m);
    tried.push(r);
    if (r.ok) return { ok: true, model: r.model, tried };

    if (r.networkError) {
      return { ok: false, transient: true, tried };
    }

    if (r.status && !MODEL_ERROR_STATUS.has(r.status)) {
      return { ok: false, transient: !!r.transient, tried };
    }
  }
  return { ok: false, transient: tried.some(r => r.transient), tried };
}

// ---------- 把测试结果格式化成人能看懂的多行报告 ----------
// 返回行数组,缩进由调用方负责拼。
function describeAttempt(r) {
  const modelLabel = r.actualModel && r.actualModel !== r.model
    ? `模型 ${r.model}（实际发送 ${r.actualModel}${r.claudeCodeLike ? '，Claude Code 预检' : ''}）`
    : `模型 ${r.model}${r.claudeCodeLike ? '（Claude Code 预检）' : ''}`;

  if (r.ok) return [`${modelLabel} → OK`];
  if (r.networkError) return [`${modelLabel} → 网络错误: ${r.networkError}`];

  const head = `${modelLabel} → HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}${r.transient ? '（暂时性错误）' : ''}`;
  return r.errorBody ? [head, `响应: ${r.errorBody}`] : [head];
}

function printTestFailure(result, indent = '        ') {
  const tried = result.tried || [];
  if (tried.length === 0) {
    console.log(`${indent}(没有可尝试的模型)`);
    return;
  }
  if (tried.length === 1) {
    const lines = describeAttempt(tried[0]);
    lines.forEach((ln, i) => console.log(indent + (i === 0 ? '' : '     ') + ln));
    return;
  }
  // 多模型 fallback 的情况:列出所有尝试
  console.log(`${indent}所有模型都失败:`);
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

// ---------- 代理 ----------
function startProxy(cfg, startIndex) {
  const state = {
    idx: startIndex,
    deadKeys: new Set(), // 本次会话内已确认失效的 key 索引
  };

  function pickNext() {
    const n = cfg.keys.length;
    for (let step = 1; step <= n; step++) {
      const i = (state.idx + step) % n;
      if (cfg.keys[i].enabled !== false && !state.deadKeys.has(i)) {
        return i;
      }
    }
    return -1;
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    let attempt = 0;
    const maxAttempts = cfg.keys.length + 1;

    while (attempt < maxAttempts) {
      if (state.deadKeys.has(state.idx) || cfg.keys[state.idx].enabled === false) {
        const next = pickNext();
        if (next === -1) break;
        state.idx = next;
      }

      const entry = cfg.keys[state.idx];
      const upstream = entry.base_url.replace(/\/$/, '') + req.url;
      const isStream = body.length && body.includes('"stream":true');
      const tag = `${entry.name || maskKey(entry.key)}`;

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (['host', 'content-length', 'connection', 'x-api-key', 'authorization'].includes(lk)) continue;
        headers[k] = v;
      }
      headers['x-api-key'] = entry.key;
      headers['authorization'] = `Bearer ${entry.key}`;
      if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';

      let upstreamRes;
      try {
        upstreamRes = await fetch(upstream, {
          method: req.method,
          headers,
          body: body.length ? body : undefined,
          duplex: 'half',
        });
      } catch (e) {
        logLine(`[${tag}] 网络错误: ${e.message} → 切换`);
        state.deadKeys.add(state.idx);
        attempt++;
        const next = pickNext();
        if (next === -1) break;
        state.idx = next;
        continue;
      }

      // 触发切换的状态码：读完 body，标记 key 失效，换下一个
      if (SWITCH_STATUS.has(upstreamRes.status)) {
        const errText = await upstreamRes.text().catch(() => '');
        console.log(`\n[rotator] key "${tag}" 失效 (${upstreamRes.status})，自动切换`);
        logLine(`[${tag}] ${upstreamRes.status}: ${errText.slice(0, 200)}`);
        state.deadKeys.add(state.idx);
        attempt++;
        const next = pickNext();
        if (next === -1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'rotator_exhausted', message: '所有 key 均已失效或耗尽' } }));
          return;
        }
        console.log(`[rotator] 切换到 "${cfg.keys[next].name || maskKey(cfg.keys[next].key)}"`);
        state.idx = next;
        continue;
      }

      // 转发响应（含流式 SSE），同时 tap 数据流来累计 usage / 缓存命中
      const respHeaders = {};
      upstreamRes.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) {
          respHeaders[k] = v;
        }
      });
      res.writeHead(upstreamRes.status, respHeaders);

      if (upstreamRes.body) {
        const upstreamStream = Readable.fromWeb(upstreamRes.body);
        const isSSE = (respHeaders['content-type'] || '').toLowerCase().includes('event-stream');

        if (isSSE) {
          // Anthropic SSE：message_start 含完整 input/cache 数据，message_delta 含最终 output_tokens
          const cur = { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 };
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
                if (d.type === 'message_start' && d.message?.usage) {
                  cur.input = d.message.usage.input_tokens || 0;
                  cur.cacheRead = d.message.usage.cache_read_input_tokens || 0;
                  cur.cacheCreate = d.message.usage.cache_creation_input_tokens || 0;
                } else if (d.type === 'message_delta' && d.usage) {
                  cur.output = d.usage.output_tokens || cur.output;
                }
              } catch {}
            }
          });
          upstreamStream.on('end', () => {
            if (cur.input || cur.output || cur.cacheRead || cur.cacheCreate) {
              sessionStats.requests++;
              sessionStats.inputTokens += cur.input;
              sessionStats.cacheReadTokens += cur.cacheRead;
              sessionStats.cacheCreationTokens += cur.cacheCreate;
              sessionStats.outputTokens += cur.output;
            }
          });
          upstreamStream.pipe(res);
        } else {
          // 非流式：缓存完整 body 再解析 usage
          let body2 = Buffer.alloc(0);
          upstreamStream.on('data', (chunk) => {
            body2 = Buffer.concat([body2, chunk]);
          });
          upstreamStream.on('end', () => {
            try {
              const d = JSON.parse(body2.toString('utf-8'));
              if (d.usage) {
                sessionStats.requests++;
                sessionStats.inputTokens += d.usage.input_tokens || 0;
                sessionStats.cacheReadTokens += d.usage.cache_read_input_tokens || 0;
                sessionStats.cacheCreationTokens += d.usage.cache_creation_input_tokens || 0;
                sessionStats.outputTokens += d.usage.output_tokens || 0;
              }
            } catch {}
          });
          upstreamStream.pipe(res);
        }
      } else {
        res.end();
      }
      return;
    }

    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'rotator_exhausted', message: '所有 key 均已失效或耗尽' } }));
  });

  return new Promise((resolve, reject) => {
    const maxOffset = 20;
    let offset = 0;
    const tryListen = () => {
      const onError = (e) => {
        if (e.code === 'EADDRINUSE' && offset < maxOffset) {
          offset++;
          tryListen();
        } else {
          reject(e);
        }
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

// ---------- 启动 Claude Code ----------
async function cmdStart(extraArgs) {
  const cfg = loadConfig();
  if (cfg.keys.length === 0) {
    console.error('还没有任何 key，请先：ck add');
    process.exit(1);
  }

  console.log('按顺序测试 key...');
  let firstOk = -1;
  let firstOkModel = null;
  let firstTransient = -1;
  let firstTransientModel = null;

  for (let i = 0; i < cfg.keys.length; i++) {
    const k = cfg.keys[i];
    const label = `  [${i + 1}/${cfg.keys.length}] ${k.name || maskKey(k.key)}`;
    if (k.enabled === false) {
      console.log(`${label} — 已禁用，跳过`);
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
      firstTransientModel = k.test_model || TEST_MODEL_DEFAULT;
      console.log(`⚠ ${tag}（暂时性错误，先记为候选）`);
    } else {
      console.log(`✗ ${tag}`);
    }
    printTestFailure(r);
  }

  if (firstOk === -1 && firstTransient !== -1) {
    console.log(`\n⚠ 没有 key 完全通过预检，但 "${cfg.keys[firstTransient].name || maskKey(cfg.keys[firstTransient].key)}" 只是 5xx/网络类暂时性失败。`);
    console.log('  先启动 rotator；真实 Claude Code 请求会继续按运行时响应决定是否切换。\n');
    firstOk = firstTransient;
    firstOkModel = firstTransientModel;
  }

  if (firstOk === -1) {
    console.error('\n所有 key 测试都失败了，无法启动。请检查上方的诊断信息后修复 key 或 base_url。');
    process.exit(1);
  }

  console.log(`使用 "${cfg.keys[firstOk].name || maskKey(cfg.keys[firstOk].key)}"，启动本地代理...`);
  let server;
  try {
    server = await startProxy(cfg, firstOk);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${cfg.port} 到 ${cfg.port + 20} 都被占用，无法启动代理。`);
    } else {
      console.error(`启动代理失败: ${e.message}`);
    }
    process.exit(1);
  }

  const actualPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;
  if (actualPort !== cfg.port) {
    console.log(`代理监听 ${baseUrl}（默认端口 ${cfg.port} 被占用，自动改用 ${actualPort}）`);
  } else {
    console.log(`代理监听 ${baseUrl}`);
  }
  console.log('启动 Claude Code...\n');

  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'rotator-managed',
    ANTHROPIC_API_KEY: 'rotator-managed',
  };

  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const child = spawn(claudeCmd, extraArgs, {
    env,
    stdio: 'inherit',
    shell: true,
  });

  const shutdown = () => {
    try { server.close(); } catch {}
    if (!child.killed) child.kill();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  child.on('exit', (code) => {
    try { server.close(); } catch {}
    printSessionStats();
    process.exit(code ?? 0);
  });
  child.on('error', (e) => {
    console.error(`无法启动 claude: ${e.message}`);
    try { server.close(); } catch {}
    process.exit(1);
  });
}

// ---------- 会话统计输出 ----------
function printSessionStats() {
  if (sessionStats.requests === 0) return;
  const totalInput = sessionStats.inputTokens + sessionStats.cacheReadTokens + sessionStats.cacheCreationTokens;
  const hitRate = totalInput > 0 ? (sessionStats.cacheReadTokens / totalInput * 100).toFixed(1) : '0.0';
  const elapsedSec = Math.round((Date.now() - sessionStats.startTime) / 1000);
  const fmt = (n) => n.toLocaleString('en-US');
  console.log(`
====== 本次 Claude Code 会话统计 ======
时长:              ${elapsedSec} 秒
请求数:            ${sessionStats.requests}
普通输入 token:    ${fmt(sessionStats.inputTokens)}
缓存写入 token:    ${fmt(sessionStats.cacheCreationTokens)}
缓存读取 token:    ${fmt(sessionStats.cacheReadTokens)}
输出 token:        ${fmt(sessionStats.outputTokens)}
缓存命中率:        ${hitRate}%   (cache_read / 全部 input)
=======================================
`);
}

// ---------- 添加 / 删除 / 列表 / 测试 ----------
function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function cmdAdd(args) {
  const cfg = loadConfig();
  let name, base_url, key;

  if (args.length >= 3) {
    [name, base_url, key] = args;
  } else {
    name = await prompt('名称（自己起一个备注名）: ');
    base_url = await prompt('base_url（中转站地址，例如 https://api.xxx.com）: ');
    key = await prompt('key（sk-... 等）: ');
  }

  if (!base_url || !key) {
    console.error('base_url 和 key 不能为空');
    process.exit(1);
  }
  if (!/^https?:\/\//.test(base_url)) {
    console.error('base_url 必须以 http:// 或 https:// 开头');
    process.exit(1);
  }

  cfg.keys.push({
    name: name || `key-${cfg.keys.length + 1}`,
    base_url: base_url.replace(/\/$/, ''),
    key,
    enabled: true,
  });
  saveConfig(cfg);
  console.log(`已添加。当前共 ${cfg.keys.length} 个 key。`);
}

async function cmdRemove(args) {
  const cfg = loadConfig();
  if (cfg.keys.length === 0) { console.log('(空)'); return; }

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
  if (cfg.keys.length === 0) {
    console.log('(还没有添加任何 key)');
    return;
  }
  cfg.keys.forEach((k, i) => {
    const flag = k.enabled === false ? '[禁用]' : '      ';
    console.log(`${String(i + 1).padStart(2)}. ${flag} ${k.name}`);
    console.log(`     ${k.base_url}`);
    console.log(`     ${maskKey(k.key)}`);
  });
}

function cmdList() {
  listKeys(loadConfig());
}

async function cmdTest() {
  const cfg = loadConfig();
  if (cfg.keys.length === 0) { console.log('(空)'); return; }
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < cfg.keys.length; i++) {
    const k = cfg.keys[i];
    process.stdout.write(`[${i + 1}] ${k.name} ... `);
    if (k.enabled === false) { console.log('禁用，跳过'); continue; }
    const r = await testKeyWithFallback(k);
    if (r.ok) {
      console.log(`✓ OK  (model: ${r.model})`);
      okCount++;
    } else {
      const last = r.tried[r.tried.length - 1] || {};
      const tag = last.networkError
        ? '网络错误'
        : (last.status ? `HTTP ${last.status}` : '未知错误');
      console.log(`✗ ${tag}`);
      printTestFailure(r, '    ');
      failCount++;
    }
  }
  console.log(`\n合计: ${okCount} 可用 / ${failCount} 失败`);
}

async function cmdToggle(args) {
  const cfg = loadConfig();
  const idx = parseInt(args[0], 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= cfg.keys.length) {
    console.error('用法: ck toggle <编号>');
    process.exit(1);
  }
  cfg.keys[idx].enabled = cfg.keys[idx].enabled === false;
  saveConfig(cfg);
  console.log(`"${cfg.keys[idx].name}" 现在 ${cfg.keys[idx].enabled ? '启用' : '禁用'}`);
}

function cmdHelp() {
  console.log(`Claude Code Key Rotator

用法:
  ck                       启动 Claude Code（按顺序测试 key，用第一个可用的；运行中失效自动换下一个）
  ck start [...]           同上，多余参数透传给 claude
  ck add                   添加 key（交互）
  ck add <name> <url> <k>  添加 key（一行命令）
  ck list                  列出所有 key
  ck test                  测试所有 key
  ck remove [编号]         删除 key
  ck toggle <编号>         启用/禁用某个 key
  ck help                  本帮助

配置文件: ${CONFIG_FILE}
代理日志: ${LOG_FILE}
`);
}

// ---------- 入口 ----------
const [, , cmd, ...rest] = process.argv;
const handler = {
  add: cmdAdd,
  remove: cmdRemove, rm: cmdRemove,
  list: cmdList, ls: cmdList,
  test: cmdTest,
  toggle: cmdToggle,
  start: cmdStart,
  help: cmdHelp, '-h': cmdHelp, '--help': cmdHelp,
}[cmd || 'start'];

if (!handler) {
  console.error(`未知命令: ${cmd}`);
  cmdHelp();
  process.exit(1);
}

Promise.resolve(handler(rest)).catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});