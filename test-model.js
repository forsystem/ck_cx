#!/usr/bin/env node
// test-model.js
// 读当前目录 keys.json,对指定模型用 5 种不同请求姿势分别测试,
// 找出中转站到底接受哪种写法。每次测试完整打印请求 + 响应。
//
// 用法:
//   node test-model.js                              # 用默认模型 'claude-opus-4-7[1m]'
//   node test-model.js claude-opus-4-8[1m]          # 显式指定模型
//   node test-model.js claude-opus-4-8[1m] -v E     # 只跑姿势 E
//   node test-model.js -v A,E                       # 只跑 A 和 E
//   node test-model.js --stop-on-success            # 第一个通过的姿势就停
//   node test-model.js --max-tokens 256 -m "你好"   # 自定义参数

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(process.cwd(), 'keys.json');
const DEFAULT_MODEL = 'claude-opus-4-7[1m]';

// ---------- 命令行 ----------
const argv = process.argv.slice(2);
let modelArg = null;
let variantsArg = null;
let userMsg = 'reply with just "ok"';
let maxTokens = 64;
let stopOnSuccess = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--variant' || a === '-v') variantsArg = argv[++i];
  else if (a === '--message' || a === '-m') userMsg = argv[++i];
  else if (a === '--max-tokens') maxTokens = parseInt(argv[++i], 10);
  else if (a === '--stop-on-success') stopOnSuccess = true;
  else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  else if (a.startsWith('-')) { console.error(`未知选项: ${a}`); process.exit(1); }
  else if (!modelArg) modelArg = a;
  else { console.error(`多余参数: ${a}`); process.exit(1); }
}

function printHelp() {
  console.log(`用法: node test-model.js [选项] [模型]

测试当前目录 keys.json 中每个 key 对指定模型的 5 种请求姿势,
找出中转站接受哪种写法。每次测试都完整打印请求和响应。

参数:
  模型              要测的模型字符串,默认 '${DEFAULT_MODEL}'

选项:
  -v, --variant <字母>      只跑指定姿势,逗号分隔,如 -v A,C,E
  -m, --message <文本>      自定义 user 消息
  --max-tokens <N>          自定义 max_tokens (默认 64)
  --stop-on-success         遇到第一个通过的姿势就停
  -h, --help                显示帮助

五种姿势:
  A: 模型名原样 + 无 beta + 最简单请求 (类似你 rotator 当前的测法)
  B: 模型名原样 + 1M context beta + 简单请求
  C: 剥掉 [1m] + 1M context beta + 简单请求 (Anthropic 官方姿势)
  D: 剥掉 [1m] + 无 beta + 简单请求
  E: 模型名原样 + 多 beta + 完整 Claude Code 模拟 (stream/system/...) ← 最像真实的
`);
}

// ---------- 工具 ----------
function maskKey(k) {
  if (!k) return '';
  return k.length <= 12 ? k.slice(0, 2) + '***' : k.slice(0, 6) + '...' + k.slice(-4);
}
function color(s, c) {
  const codes = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90, bold: 1 };
  return process.stdout.isTTY ? `\x1b[${codes[c] || 0}m${s}\x1b[0m` : s;
}
function pretty(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
function stripBracket1m(name) {
  return name.replace(/\[1m\]$/i, '');
}

// ---------- 5 种姿势 ----------
const VARIANTS = [
  {
    id: 'A',
    desc: '模型名原样 + 无 beta + 最简请求 (近似你 rotator 现在的姿势)',
    transformModel: (m) => m,
    beta: null,
    bodyKind: 'simple',
  },
  {
    id: 'B',
    desc: '模型名原样 + 1M beta + 最简请求',
    transformModel: (m) => m,
    beta: 'context-1m-2025-08-07',
    bodyKind: 'simple',
  },
  {
    id: 'C',
    desc: '剥 [1m] + 1M beta + 最简请求 (Anthropic 官方姿势)',
    transformModel: stripBracket1m,
    beta: 'context-1m-2025-08-07',
    bodyKind: 'simple',
  },
  {
    id: 'D',
    desc: '剥 [1m] + 无 beta + 最简请求',
    transformModel: stripBracket1m,
    beta: null,
    bodyKind: 'simple',
  },
  {
    id: 'E',
    desc: '模型名原样 + 多 beta + Claude Code 风格完整流式请求',
    transformModel: (m) => m,
    beta: 'context-1m-2025-08-07,prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14',
    bodyKind: 'cc-like',
  },
];

// ---------- 加载配置 ----------
if (!fs.existsSync(CONFIG_FILE)) {
  console.error(color(`✗ 找不到 ${CONFIG_FILE}`, 'red'));
  console.error(`  请在包含 keys.json 的目录下运行。`);
  process.exit(1);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); }
catch (e) { console.error(color(`✗ JSON 解析失败: ${e.message}`, 'red')); process.exit(1); }
if (!Array.isArray(cfg.keys) || cfg.keys.length === 0) {
  console.error(color(`✗ keys.json 里没有 key`, 'red'));
  process.exit(1);
}

const targetModel = modelArg || DEFAULT_MODEL;
const filterIds = variantsArg ? variantsArg.split(/[,\s]+/).map(s => s.toUpperCase()) : null;
const runVariants = filterIds ? VARIANTS.filter(v => filterIds.includes(v.id)) : VARIANTS;
if (filterIds && runVariants.length === 0) {
  console.error(color(`✗ 没有匹配的姿势:${variantsArg}`, 'red'));
  process.exit(1);
}

// ---------- 单次测试 ----------
async function runOne(entry, variant) {
  const modelToSend = variant.transformModel(targetModel);
  const baseUrl = (entry.base_url || '').replace(/\/$/, '');
  const url = baseUrl + '/v1/messages';

  const headers = {
    'Content-Type': 'application/json',
    'Accept': variant.bodyKind === 'cc-like' ? 'text/event-stream' : 'application/json',
    'x-api-key': entry.key,
    'Authorization': `Bearer ${entry.key}`,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'User-Agent': 'claude-cli/2.0.0 (external, cli)',
  };
  if (variant.beta) headers['anthropic-beta'] = variant.beta;

  let body;
  if (variant.bodyKind === 'simple') {
    body = {
      model: modelToSend,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: userMsg }],
    };
  } else {
    body = {
      model: modelToSend,
      max_tokens: Math.max(maxTokens, 256),
      stream: true,
      system: [{
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: userMsg }],
      metadata: { user_id: `test_${Date.now()}` },
      temperature: 1,
    };
  }

  console.log(color('─'.repeat(74), 'gray'));
  console.log(color(`  姿势 ${variant.id}`, 'bold'), color(`— ${variant.desc}`, 'gray'));
  console.log(`  POST ${url}`);
  console.log(`  model: ${color(JSON.stringify(modelToSend), 'cyan')}`);
  if (variant.beta) console.log(`  anthropic-beta: ${color(variant.beta, 'cyan')}`);
  console.log(color('  ── Body ──', 'gray'));
  const bodyStr = JSON.stringify(body, null, 2);
  bodyStr.split('\n').forEach(l => console.log(color('  ' + l, 'gray')));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const code = e.code || e.cause?.code || e.name;
    console.log(color(`  ✗ 网络错误: ${e.message}${code ? ' [' + code + ']' : ''}`, 'red'));
    return { ok: false, variant: variant.id, modelSent: modelToSend, error: code || 'network' };
  }
  clearTimeout(timer);
  const elapsed = Date.now() - t0;

  const statusTag = res.ok ? color(`HTTP ${res.status}`, 'green') : color(`HTTP ${res.status}`, 'red');
  console.log(`  ← ${statusTag} ${res.statusText || ''} (${elapsed}ms)`);

  let text = '';
  if (body.stream && res.ok) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } else {
    text = await res.text();
  }

  console.log(color('  ── Response Body ──', res.ok ? 'green' : 'red'));
  const display = text.length > 3000
    ? text.slice(0, 3000) + `\n... (已截断,共 ${text.length} 字节)`
    : text;
  const formatted = (body.stream && res.ok) ? display : pretty(display);
  formatted.split('\n').forEach(l => console.log('  ' + l));

  return { ok: res.ok, status: res.status, variant: variant.id, modelSent: modelToSend };
}

// ---------- 主流程 ----------
(async () => {
  console.log();
  console.log(color('Claude Code 风格 API 多姿势测试', 'bold'));
  console.log(`配置文件: ${CONFIG_FILE}`);
  console.log(`目标模型: ${color(targetModel, 'cyan')}`);
  console.log(`姿势:     ${runVariants.map(v => v.id).join(', ')}`);
  console.log(`Key 数:   ${cfg.keys.length}`);
  console.log();

  const summary = [];
  for (let i = 0; i < cfg.keys.length; i++) {
    const entry = cfg.keys[i];
    console.log(color('═'.repeat(74), 'cyan'));
    console.log(color(`[Key ${i + 1}/${cfg.keys.length}] ${entry.name || '(未命名)'} ${maskKey(entry.key)}`, 'bold'));
    console.log(`  base_url: ${entry.base_url}`);
    if (entry.enabled === false) console.log(color(`  ⚠ keys.json 里已禁用,仍会测试`, 'yellow'));
    console.log();

    const results = [];
    for (const v of runVariants) {
      const r = await runOne(entry, v);
      results.push(r);
      console.log();
      if (r.ok && stopOnSuccess) break;
    }
    summary.push({ entry, results });
  }

  console.log(color('═'.repeat(74), 'bold'));
  console.log(color('★ 总结', 'bold'));
  for (const { entry, results } of summary) {
    console.log();
    console.log(color(`  ${entry.name || '(未命名)'}`, 'bold'));
    for (const r of results) {
      const mark = r.ok ? color('✓', 'green') : color('✗', 'red');
      const tail = r.status ? `HTTP ${r.status}` : (r.error || '?');
      console.log(`    ${mark} 姿势 ${r.variant}  ${tail.padEnd(12)}  model=${JSON.stringify(r.modelSent)}`);
    }
    const okOnes = results.filter(r => r.ok).map(r => r.variant);
    if (okOnes.length > 0) {
      console.log(color(`    → 能通的姿势: ${okOnes.join(', ')}`, 'green'));
    } else {
      console.log(color(`    → 全部失败 — 看上面具体错误信息`, 'red'));
    }
  }
  console.log();
})().catch(e => {
  console.error(color('未捕获异常:', 'red'), e.stack || e.message);
  process.exit(1);
});