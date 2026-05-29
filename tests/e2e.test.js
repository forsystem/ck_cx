// E2E tests: 启动 rotator.js / codex-rotator.js 子进程，
// 配合 stub-server 上游，覆盖范围、模型、错误用例。
//
// 必须先 require 同目录的 ./run（test()/eq() 来自它）。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const http = require('http');

const { test, eq } = require('./run');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const ROTATOR = path.join(ROOT, 'rotator.js');
const CODEX_ROTATOR = path.join(ROOT, 'codex-rotator.js');
const STUB = path.join(ROOT, 'tests', 'stub-server.js');

const FAKE_KEY = 'sk-FAKEKEYabcdefghijklmnopqrstuvwxyz0123456789FAKE';
const FAKE_KEY_PREFIX = 'sk-FAK';        // maskKey 应保留前 6 位
const FAKE_KEY_TAIL = 'FAKE';            // 和后 4 位

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rotator-e2e-'));
}

// 启动一次 stub server，所有测试共用。
async function startStub(mode = 'ok') {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE, [STUB, '0', mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    proc.stdout.on('data', (c) => {
      buf += c.toString('utf-8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          const info = JSON.parse(buf.slice(0, nl));
          if (info.ready) resolve({ port: info.port, proc });
        } catch (e) {
          reject(e);
        }
      }
    });
    proc.stderr.on('data', (c) => process.stderr.write('[stub stderr] ' + c));
    proc.on('error', reject);
    setTimeout(() => reject(new Error('stub start timeout')), 5000);
  });
}

function stopStub(s) {
  if (s && s.proc && !s.proc.killed) {
    try { s.proc.kill(); } catch {}
  }
}

function writeConfig(file, port, n, modeOverride) {
  const keys = [];
  for (let i = 0; i < n; i++) {
    keys.push({
      name: `stub-${i + 1}`,
      base_url: `http://127.0.0.1:${port}`,
      key: FAKE_KEY,
      enabled: true,
      test_model: 'claude-3-5-haiku-20241022',
    });
  }
  fs.writeFileSync(file, JSON.stringify({ port: 8765, keys }, null, 2), 'utf-8');
}

function writeCodexConfig(file, port, n) {
  const keys = [];
  for (let i = 0; i < n; i++) {
    keys.push({
      name: `stub-${i + 1}`,
      base_url: `http://127.0.0.1:${port}/v1`,
      key: FAKE_KEY,
      enabled: true,
      test_model: 'gpt-5.5',
    });
  }
  fs.writeFileSync(file, JSON.stringify({ port: 8766, keys }, null, 2), 'utf-8');
}

function runCk(args, env = {}) {
  const res = spawnSync(NODE, [ROTATOR, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 30000,
  });
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    combined: (res.stdout || '') + (res.stderr || ''),
  };
}

function runCx(args, env = {}) {
  const res = spawnSync(NODE, [CODEX_ROTATOR, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 30000,
  });
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    combined: (res.stdout || '') + (res.stderr || ''),
  };
}

function assertNoFullKey(output) {
  if (output.includes(FAKE_KEY)) {
    throw new Error('输出泄露了完整 API key！\n' + output);
  }
}

// ---------- 注：共用 stub + tmp config ----------

let stub;
let tmp;
let ckCfg;
let cxCfg;
let stubLog;

function readStubLog() {
  try {
    return fs.readFileSync(stubLog, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resetStubLog() {
  try { fs.writeFileSync(stubLog, '', 'utf-8'); } catch {}
}

async function startStubWithLog(logPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE, [STUB, '0', 'ok'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STUB_LOG: logPath },
    });
    let buf = '';
    proc.stdout.on('data', (c) => {
      buf += c.toString('utf-8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          const info = JSON.parse(buf.slice(0, nl));
          if (info.ready) resolve({ port: info.port, proc });
        } catch (e) {
          reject(e);
        }
      }
    });
    proc.stderr.on('data', (c) => process.stderr.write('[stub stderr] ' + c));
    proc.on('error', reject);
    setTimeout(() => reject(new Error('stub start timeout')), 5000);
  });
}

test('setup: 启动 stub 和写 fixture', async () => {
  tmp = tmpDir();
  stubLog = path.join(tmp, 'stub.log');
  stub = await startStubWithLog(stubLog);
  ckCfg = path.join(tmp, 'keys.json');
  cxCfg = path.join(tmp, 'codex-keys.json');
  writeConfig(ckCfg, stub.port, 4);
  writeCodexConfig(cxCfg, stub.port, 4);
  eq(typeof stub.port === 'number', true);
});

// ---------- ck test 场景 ----------

test('ck test 1-4 ：默认模型，全部通过', () => {
  const r = runCk(['test', '1-4'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
  if (!/合计: 4 可用/.test(r.combined)) {
    throw new Error('期望 4 全部 OK\n' + r.combined);
  }
});

test('ck test（无参数）：与旧版行为一致 → 测全部', () => {
  resetStubLog();
  const r = runCk(['test'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
  if (!/合计: 4 可用 \/ 0 失败/.test(r.combined)) {
    throw new Error('期望测全部 4 个\n' + r.combined);
  }
});

test('ck test 1-4 "claude-opus-4-7" ：带引号模型', () => {
  const r = runCk(['test', '1-4', '"claude-opus-4-7"'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
  if (!/使用统一测试模型: claude-opus-4-7/.test(r.combined)) {
    throw new Error('期望显示统一模型\n' + r.combined);
  }
});

test('ck test 1-4 claude-opus-4-7 ：不带引号模型', () => {
  const r = runCk(['test', '1-4', 'claude-opus-4-7'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
  if (!/使用统一测试模型: claude-opus-4-7/.test(r.combined)) {
    throw new Error('期望显示统一模型\n' + r.combined);
  }
});

test('ck test 2 ：单 key', () => {
  const r = runCk(['test', '2'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
  if (!/\[2\] stub-2 \.\.\./.test(r.combined)) {
    throw new Error('期望只跑第 2 个\n' + r.combined);
  }
  if (/\[1\] stub-1/.test(r.combined)) {
    throw new Error('不该跑第 1 个\n' + r.combined);
  }
});

test('ck test 4-1 ：非法范围', () => {
  const r = runCk(['test', '4-1'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
  if (!/非法范围/.test(r.combined)) {
    throw new Error('期望提示非法范围\n' + r.combined);
  }
  if (r.code === 0) throw new Error('应非零退出码');
});

test('ck test 1-99 ：超出范围', () => {
  const r = runCk(['test', '1-99'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
  if (!/超出/.test(r.combined)) {
    throw new Error('期望超出范围提示\n' + r.combined);
  }
  if (r.code === 0) throw new Error('应非零退出码');
});

test('ck test （空 keys）：友好错误', () => {
  const emptyCfg = path.join(tmp, 'empty.json');
  fs.writeFileSync(emptyCfg, JSON.stringify({ port: 8765, keys: [] }, null, 2));
  const r = runCk(['test'], { CK_ROTATOR_CONFIG: emptyCfg });
  if (!/还没有任何 key/.test(r.combined)) {
    throw new Error('期望空 key 提示\n' + r.combined);
  }
  if (r.code === 0) throw new Error('应非零退出码');
});

test('ck test garbage ：参数错误', () => {
  const r = runCk(['test', 'gpt-5.5'], { CK_ROTATOR_CONFIG: ckCfg });
  if (!/无法解析范围/.test(r.combined)) {
    throw new Error('期望无法解析提示\n' + r.combined);
  }
  if (r.code === 0) throw new Error('应非零退出码');
});

test('ck list ：mask key 不泄露', () => {
  const r = runCk(['list'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
});

// ---------- cx test 场景 ----------

test('cx test 1-4 ：默认模型，全部通过', () => {
  const r = runCx(['test', '1-4'], { CODEX_ROTATOR_CONFIG: cxCfg });
  assertNoFullKey(r.combined);
  if (!/合计: 4 可用/.test(r.combined)) {
    throw new Error('期望 4 全部 OK\n' + r.combined);
  }
});

test('cx test 1-4 "claude-opus-4-7" ：带引号模型', () => {
  const r = runCx(['test', '1-4', '"claude-opus-4-7"'], { CODEX_ROTATOR_CONFIG: cxCfg });
  assertNoFullKey(r.combined);
  if (!/使用统一测试模型: claude-opus-4-7/.test(r.combined)) {
    throw new Error('期望显示统一模型\n' + r.combined);
  }
});

test('cx test 1-4 claude-opus-4-7 ：不带引号模型', () => {
  const r = runCx(['test', '1-4', 'claude-opus-4-7'], { CODEX_ROTATOR_CONFIG: cxCfg });
  assertNoFullKey(r.combined);
  if (!/使用统一测试模型: claude-opus-4-7/.test(r.combined)) {
    throw new Error('期望显示统一模型\n' + r.combined);
  }
});

test('cx test 2 ：单 key', () => {
  const r = runCx(['test', '2'], { CODEX_ROTATOR_CONFIG: cxCfg });
  assertNoFullKey(r.combined);
  if (!/\[2\] stub-2 \.\.\./.test(r.combined)) {
    throw new Error('期望只跑第 2 个\n' + r.combined);
  }
});

test('cx test 4-1 ：非法范围', () => {
  const r = runCx(['test', '4-1'], { CODEX_ROTATOR_CONFIG: cxCfg });
  if (!/非法范围/.test(r.combined)) {
    throw new Error('期望提示非法范围\n' + r.combined);
  }
  if (r.code === 0) throw new Error('应非零退出码');
});

test('cx test 1-99 ：超出范围', () => {
  const r = runCx(['test', '1-99'], { CODEX_ROTATOR_CONFIG: cxCfg });
  if (!/超出/.test(r.combined)) {
    throw new Error('期望超出范围提示\n' + r.combined);
  }
  if (r.code === 0) throw new Error('应非零退出码');
});

test('cx test （空 keys）：友好错误', () => {
  const emptyCfg = path.join(tmp, 'cx-empty.json');
  fs.writeFileSync(emptyCfg, JSON.stringify({ port: 8766, keys: [] }, null, 2));
  const r = runCx(['test'], { CODEX_ROTATOR_CONFIG: emptyCfg });
  if (!/还没有任何 key/.test(r.combined)) {
    throw new Error('期望空 key 提示\n' + r.combined);
  }
  if (r.code === 0) throw new Error('应非零退出码');
});

test('cx test garbage ：参数错误', () => {
  const r = runCx(['test', 'gpt-5.5'], { CODEX_ROTATOR_CONFIG: cxCfg });
  if (!/无法解析范围/.test(r.combined)) {
    throw new Error('期望无法解析提示\n' + r.combined);
  }
});

test('cx list ：mask key 不泄露', () => {
  const r = runCx(['list'], { CODEX_ROTATOR_CONFIG: cxCfg });
  assertNoFullKey(r.combined);
});

// ---------- teardown ----------

test('cx test: 模型确实转发到 upstream 的 body.model', () => {
  resetStubLog();
  const r = runCx(['test', '1-4', 'gpt-5.5'], { CODEX_ROTATOR_CONFIG: cxCfg });
  assertNoFullKey(r.combined);
  const log = readStubLog();
  if (log.length !== 4) throw new Error(`期望 4 次请求，实际 ${log.length}\n${JSON.stringify(log)}`);
  for (const row of log) {
    if (row.model !== 'gpt-5.5') {
      throw new Error(`期望 model=gpt-5.5，实际 ${row.model}`);
    }
  }
});

test('cx test: 不传模型 → 各 key 用自己的 test_model', () => {
  resetStubLog();
  const r = runCx(['test', '1-4'], { CODEX_ROTATOR_CONFIG: cxCfg });
  assertNoFullKey(r.combined);
  const log = readStubLog();
  if (log.length !== 4) throw new Error(`期望 4 次请求，实际 ${log.length}`);
  for (const row of log) {
    if (row.model !== 'gpt-5.5') {
      throw new Error(`fixture 里 test_model=gpt-5.5，期望同名，实际 ${row.model}`);
    }
  }
});

test('cx test 2-3 ：只测中间两个', () => {
  resetStubLog();
  const r = runCx(['test', '2-3', 'foo-model'], { CODEX_ROTATOR_CONFIG: cxCfg });
  assertNoFullKey(r.combined);
  const log = readStubLog();
  if (log.length !== 2) throw new Error(`期望 2 次请求，实际 ${log.length}`);
});

test('ck test: 模型确实转发到 upstream 的 body.model', () => {
  resetStubLog();
  const r = runCk(['test', '1-4', 'gpt-5.5'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
  const log = readStubLog();
  if (log.length !== 4) throw new Error(`期望 4 次请求，实际 ${log.length}\n${JSON.stringify(log)}`);
  for (const row of log) {
    if (row.model !== 'gpt-5.5') {
      throw new Error(`期望 model=gpt-5.5，实际 ${row.model}`);
    }
  }
});

test('ck test 1-4: 不传模型 → 用每个 key 的 test_model', () => {
  resetStubLog();
  const r = runCk(['test', '1-4'], { CK_ROTATOR_CONFIG: ckCfg });
  assertNoFullKey(r.combined);
  const log = readStubLog();
  // stub 总是返回 OK，所以第一个候选模型（即 fixture 的 test_model）就成功了，
  // 不会再走 fallback。期望 4 次请求且全部用 test_model。
  if (log.length !== 4) throw new Error(`期望恰好 4 次请求，实际 ${log.length}\n${JSON.stringify(log)}`);
  for (const row of log) {
    if (row.model !== 'claude-3-5-haiku-20241022') {
      throw new Error(`期望全部用 fixture 的 test_model，实际有 ${row.model}`);
    }
  }
});

test('ck test 3-3 == ck test 3 ：等价行为', () => {
  resetStubLog();
  runCk(['test', '3-3', 'm'], { CK_ROTATOR_CONFIG: ckCfg });
  const a = readStubLog().length;
  resetStubLog();
  runCk(['test', '3', 'm'], { CK_ROTATOR_CONFIG: ckCfg });
  const b = readStubLog().length;
  eq(a, b);
});

// ---------- 失败路径：401 ----------

test('ck test 1-4 ：upstream 返 401 + 在 body 里回显 key → 输出不能包含完整 key', async () => {
  // 起一个会回显 key 的 stub
  const STUB_PORT = 0;
  const stubFile = path.join(__dirname, 'echo-key-stub-tmp.js');
  fs.writeFileSync(stubFile, `
    const http = require('http');
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const apiKey = req.headers['x-api-key'] || '';
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid key: ' + apiKey, type: 'invalid_key' } }));
      });
    });
    s.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port: s.address().port })));
  `);
  const echoStub = await new Promise((resolve, reject) => {
    const p = spawn(NODE, [stubFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try { const info = JSON.parse(buf.slice(0, nl)); if (info.ready) resolve({ proc: p, port: info.port }); }
        catch (e) { reject(e); }
      }
    });
    p.on('error', reject);
    setTimeout(() => reject(new Error('echo stub timeout')), 3000);
  });
  try {
    const cfgPath = path.join(tmp, 'echo-keys.json');
    writeConfig(cfgPath, echoStub.port, 2);
    const r = runCk(['test', '1-2', 'gpt-5.5'], { CK_ROTATOR_CONFIG: cfgPath });
    assertNoFullKey(r.combined);
    // 应该看到 key 被打码后的版本（前 6 + 后 4）
    if (!/sk-FAK.*FAKE/.test(r.combined)) {
      throw new Error('期望显示打码后的 key 标识\n' + r.combined);
    }
  } finally {
    try { echoStub.proc.kill(); } catch {}
    try { fs.unlinkSync(stubFile); } catch {}
  }
});

test('ck test 1-4 ：upstream 全返 401 → 全部失败、退出码非零、不泄露 key', async () => {
  // 起一个 fail-key 模式的 stub
  const failStub = await startStub('fail-key');
  try {
    const cfgPath = path.join(tmp, 'fail-keys.json');
    writeConfig(cfgPath, failStub.port, 4);
    const r = runCk(['test', '1-4', 'gpt-5.5'], { CK_ROTATOR_CONFIG: cfgPath });
    assertNoFullKey(r.combined);
    if (!/合计: 0 可用 \/ 4 失败/.test(r.combined)) {
      throw new Error(`期望 4 个全部失败\n${r.combined}`);
    }
    if (r.code === 0) throw new Error('应非零退出码');
    if (!/HTTP 401/.test(r.combined)) {
      throw new Error('期望显示 HTTP 401\n' + r.combined);
    }
  } finally {
    stopStub(failStub);
  }
});

test('cx test 1-4 ：upstream 全返 401 → 全部失败、退出码非零、不泄露 key', async () => {
  const failStub = await startStub('fail-key');
  try {
    const cfgPath = path.join(tmp, 'cx-fail-keys.json');
    writeCodexConfig(cfgPath, failStub.port, 4);
    const r = runCx(['test', '1-4', 'gpt-5.5'], { CODEX_ROTATOR_CONFIG: cfgPath });
    assertNoFullKey(r.combined);
    if (!/合计: 0 可用 \/ 4 失败/.test(r.combined)) {
      throw new Error(`期望 4 个全部失败\n${r.combined}`);
    }
    if (r.code === 0) throw new Error('应非零退出码');
  } finally {
    stopStub(failStub);
  }
});

test('cx test ：upstream 回显 key 也不能泄露', async () => {
  const stubFile = path.join(__dirname, 'cx-echo-key-stub-tmp.js');
  fs.writeFileSync(stubFile, `
    const http = require('http');
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const apiKey = req.headers['x-api-key'] || req.headers['authorization'] || '';
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'leaked: ' + apiKey, type: 'invalid_key' } }));
      });
    });
    s.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port: s.address().port })));
  `);
  const echoStub = await new Promise((resolve, reject) => {
    const p = spawn(NODE, [stubFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try { const info = JSON.parse(buf.slice(0, nl)); if (info.ready) resolve({ proc: p, port: info.port }); }
        catch (e) { reject(e); }
      }
    });
    p.on('error', reject);
    setTimeout(() => reject(new Error('cx echo stub timeout')), 3000);
  });
  try {
    const cfgPath = path.join(tmp, 'cx-echo-keys.json');
    writeCodexConfig(cfgPath, echoStub.port, 2);
    const r = runCx(['test', '1-2', 'gpt-5.5'], { CODEX_ROTATOR_CONFIG: cfgPath });
    assertNoFullKey(r.combined);
  } finally {
    try { echoStub.proc.kill(); } catch {}
    try { fs.unlinkSync(stubFile); } catch {}
  }
});

// ---------- 禁用 key 在范围内 ----------

test('ck test 1-4 ：禁用的 key 跳过，不影响其他 key', () => {
  const cfgWithDisabled = path.join(tmp, 'with-disabled.json');
  const cfg = JSON.parse(fs.readFileSync(ckCfg, 'utf-8'));
  cfg.keys[1].enabled = false;
  fs.writeFileSync(cfgWithDisabled, JSON.stringify(cfg, null, 2));
  resetStubLog();
  const r = runCk(['test', '1-4', 'gpt-5.5'], { CK_ROTATOR_CONFIG: cfgWithDisabled });
  assertNoFullKey(r.combined);
  if (!/禁用，跳过/.test(r.combined)) {
    throw new Error('期望第 2 个显示禁用跳过\n' + r.combined);
  }
  if (!/合计: 3 可用 \/ 0 失败 \/ 1 跳过/.test(r.combined)) {
    throw new Error('合计应该是 3/0/1\n' + r.combined);
  }
  const log = readStubLog();
  if (log.length !== 3) throw new Error(`禁用的 key 不应发请求，期望 3 次实际 ${log.length}`);
});

test('cx test 1-4 ：禁用的 key 跳过', () => {
  const cfgWithDisabled = path.join(tmp, 'cx-with-disabled.json');
  const cfg = JSON.parse(fs.readFileSync(cxCfg, 'utf-8'));
  cfg.keys[2].enabled = false;
  fs.writeFileSync(cfgWithDisabled, JSON.stringify(cfg, null, 2));
  resetStubLog();
  const r = runCx(['test', '1-4', 'gpt-5.5'], { CODEX_ROTATOR_CONFIG: cfgWithDisabled });
  assertNoFullKey(r.combined);
  if (!/合计: 3 可用 \/ 0 失败 \/ 1 跳过/.test(r.combined)) {
    throw new Error('合计应该是 3/0/1\n' + r.combined);
  }
});

// ---------- 配置健壮性 ----------

test('ck test ：配置文件是无效 JSON → 友好报错', () => {
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ not json', 'utf-8');
  const r = runCk(['test', '1-4'], { CK_ROTATOR_CONFIG: bad });
  if (!/解析失败/.test(r.combined)) {
    throw new Error('期望解析失败提示\n' + r.combined);
  }
  if (r.code === 0) throw new Error('应非零退出码');
});

test('cx test ：配置文件是无效 JSON → 友好报错', () => {
  const bad = path.join(tmp, 'cx-bad.json');
  fs.writeFileSync(bad, '{ not json', 'utf-8');
  const r = runCx(['test', '1-4'], { CODEX_ROTATOR_CONFIG: bad });
  if (!/解析失败/.test(r.combined)) {
    throw new Error('期望解析失败提示\n' + r.combined);
  }
  if (r.code === 0) throw new Error('应非零退出码');
});

test('ck test ：缺 base_url 不会让进程崩溃', () => {
  const cfgFile = path.join(tmp, 'no-baseurl.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    port: 8765,
    keys: [
      { name: 'no-url', key: 'sk-FAKEKEY1234567890' },
      { name: 'no-key', base_url: 'https://api.example.com' },
    ],
  }), 'utf-8');
  const r = runCk(['test', '1-2'], { CK_ROTATOR_CONFIG: cfgFile });
  if (!/base_url 不能为空/.test(r.combined)) {
    throw new Error('期望 base_url 校验提示\n' + r.combined);
  }
  if (!/key 不能为空/.test(r.combined)) {
    throw new Error('期望 key 校验提示\n' + r.combined);
  }
  if (/TypeError/.test(r.combined)) {
    throw new Error('不能抛 TypeError\n' + r.combined);
  }
});

test('cx test ：缺 key 字段不会让进程崩溃', () => {
  const cfgFile = path.join(tmp, 'cx-no-key.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    port: 8766,
    keys: [
      { name: 'a', base_url: 'http://127.0.0.1:1' },
    ],
  }), 'utf-8');
  const r = runCx(['test', '1'], { CODEX_ROTATOR_CONFIG: cfgFile });
  if (!/key 不能为空/.test(r.combined)) {
    throw new Error('期望 key 校验提示\n' + r.combined);
  }
  if (/TypeError/.test(r.combined)) {
    throw new Error('不能抛 TypeError\n' + r.combined);
  }
});

// ---------- UTF-8 BOM (Windows 编辑器常见) ----------

test('ck list ：带 UTF-8 BOM 的 keys.json 能正常解析', () => {
  const cfgFile = path.join(tmp, 'bom.json');
  const json = JSON.stringify({
    port: 8765,
    keys: [{ name: 'bom-key', base_url: 'http://127.0.0.1:1', key: 'sk-FAKEBOMabcdefgh', enabled: true }],
  });
  // Write BOM + JSON
  fs.writeFileSync(cfgFile, '﻿' + json, 'utf-8');
  const r = runCk(['list'], { CK_ROTATOR_CONFIG: cfgFile });
  if (!/bom-key/.test(r.combined)) {
    throw new Error('期望 list 能读到 BOM 后的 key\n' + r.combined);
  }
  if (/解析失败/.test(r.combined)) {
    throw new Error('不应解析失败\n' + r.combined);
  }
});

test('cx list ：带 UTF-8 BOM 的 codex-keys.json 能正常解析', () => {
  const cfgFile = path.join(tmp, 'cx-bom.json');
  const json = JSON.stringify({
    port: 8766,
    keys: [{ name: 'cx-bom', base_url: 'http://127.0.0.1:1', key: 'sk-FAKEBOMcxabcdefg', enabled: true }],
  });
  fs.writeFileSync(cfgFile, '﻿' + json, 'utf-8');
  const r = runCx(['list'], { CODEX_ROTATOR_CONFIG: cfgFile });
  if (!/cx-bom/.test(r.combined)) {
    throw new Error('期望 list 能读到 BOM 后的 key\n' + r.combined);
  }
  if (/解析失败/.test(r.combined)) {
    throw new Error('不应解析失败\n' + r.combined);
  }
});

// ---------- 配置数组里的 null/异常条目 ----------

test('ck test ：keys 数组里有 null 条目不会让进程崩溃', () => {
  const cfgFile = path.join(tmp, 'null-entry.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    port: 8765,
    keys: [
      null,
      { name: 'ok-key', base_url: 'http://127.0.0.1:1', key: 'sk-FAKEnullguard12345' },
    ],
  }), 'utf-8');
  const r = runCk(['test', '1-2'], { CK_ROTATOR_CONFIG: cfgFile });
  if (/TypeError/.test(r.combined)) {
    throw new Error('不能抛 TypeError\n' + r.combined);
  }
  if (!/\(空条目\)/.test(r.combined)) {
    throw new Error('期望对 null 条目显示 (空条目)\n' + r.combined);
  }
});

test('ck test ：配置根节点是 boolean 时友好报错', () => {
  const cfgFile = path.join(tmp, 'root-bool.json');
  fs.writeFileSync(cfgFile, 'true', 'utf-8');
  const r = runCk(['test'], { CK_ROTATOR_CONFIG: cfgFile });
  if (/TypeError/.test(r.combined)) {
    throw new Error('不能抛 TypeError\n' + r.combined);
  }
  if (!/根节点必须是 JSON object/.test(r.combined)) {
    throw new Error('期望根节点类型提示\n' + r.combined);
  }
});

test('cx test ：配置根节点是 array 时友好报错', () => {
  const cfgFile = path.join(tmp, 'cx-root-array.json');
  fs.writeFileSync(cfgFile, '[]', 'utf-8');
  const r = runCx(['test'], { CODEX_ROTATOR_CONFIG: cfgFile });
  if (/TypeError/.test(r.combined)) {
    throw new Error('不能抛 TypeError\n' + r.combined);
  }
  if (!/根节点必须是 JSON object/.test(r.combined)) {
    throw new Error('期望根节点类型提示\n' + r.combined);
  }
});

// ---------- test --help ----------

test('ck test --help ：退出码 0，输出含 1-4', () => {
  const r = runCk(['test', '--help']);
  if (r.code !== 0) throw new Error(`期望退出码 0，实际 ${r.code}`);
  if (!/1-4/.test(r.combined)) throw new Error('期望帮助里有 1-4 示例\n' + r.combined);
});

test('cx test -h ：退出码 0，输出含 1-4', () => {
  const r = runCx(['test', '-h']);
  if (r.code !== 0) throw new Error(`期望退出码 0，实际 ${r.code}`);
  if (!/1-4/.test(r.combined)) throw new Error('期望帮助里有 1-4 示例\n' + r.combined);
});

test('teardown', () => {
  stopStub(stub);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
