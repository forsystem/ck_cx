// Stub upstream server for E2E tests.
// 模拟 Claude (/v1/messages) 和 Codex (/v1/responses) 返回 200 OK。
// 可通过 env STUB_MODE 改变行为：
//   'ok'        所有请求返回 200
//   'fail-key'  返回 401（让 rotator 切下一个 key）
//   'echo-key'  在响应里回显收到的 x-api-key（仅用于断言泄露——禁止生产用）
//
// 启动：node tests/stub-server.js [port] [mode]
// 退出：发 SIGTERM 或父进程结束。
//
// 测试支持：每次请求把 model + 计数写到 STUB_LOG（如果设置）。

'use strict';

const http = require('http');
const fs = require('fs');

const port = Number(process.argv[2] || 0);
const mode = process.argv[3] || process.env.STUB_MODE || 'ok';
const logFile = process.env.STUB_LOG || '';

function appendLog(obj) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify(obj) + '\n', 'utf-8');
  } catch {}
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const model = parsed.model || '';

    appendLog({
      url: req.url,
      method: req.method,
      model,
      x_api_key_prefix: String(req.headers['x-api-key'] || '').slice(0, 8),
    });

    if (mode === 'fail-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub: invalid key', type: 'invalid_key' } }));
      return;
    }

    if (req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        _stub_received_model: model,
      }));
      return;
    }

    if (req.url.includes('/responses')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_stub',
        object: 'response',
        model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        _stub_received_model: model,
      }));
      return;
    }

    res.writeHead(404).end();
  });
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  // 打印 JSON 一行，方便父进程解析端口。
  console.log(JSON.stringify({ ready: true, port: addr.port, mode }));
});

const shutdown = () => { try { server.close(); } catch {} process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
