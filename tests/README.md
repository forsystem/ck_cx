# 测试

零依赖的 Node 测试，跑 `npm test` 即可。

## 文件

- `run.js` — 简易 runner，提供 `test(name, fn)` 和 `eq(a, b)`。
- `test-args.test.js` — `../test-args.js` 的纯函数单测。
- `e2e.test.js` — 启动 `rotator.js` / `codex-rotator.js` 子进程，配合本地 stub 上游，覆盖 `ck/cx test` 的真实命令行场景。
- `stub-server.js` — 模拟 `/v1/messages` 和 `/v1/responses`，可通过 `STUB_LOG` 把每次请求的 model、x-api-key 前缀写到文件，方便断言。

## 跑

```powershell
npm test                # 全部
npm run test:unit       # 只跑 parser 单测
npm run test:e2e        # 只跑端到端
npm run lint            # 全部 .js 文件做 node -c 语法检查
```

## 不消耗真实 key 额度

E2E 用 stub 上游，**不**打真实的 Claude / Codex 接口。子进程用 `CK_ROTATOR_CONFIG` / `CODEX_ROTATOR_CONFIG` 指向临时 fixture，从来不读你的真实 `keys.json` / `codex-keys.json`。

## 添加新测试

- 纯函数（解析器、工具函数）→ 加到 `test-args.test.js`，参考已有用例。
- 命令行行为（参数、错误码、输出格式）→ 加到 `e2e.test.js`，用 `runCk(args, env)` / `runCx(args, env)` 包装。
- 上游返回行为（401、回显 key、超时）→ 临时在测试里 `spawn` 一个小 stub，参考 `cx test ：upstream 回显 key 也不能泄露` 那一段。
