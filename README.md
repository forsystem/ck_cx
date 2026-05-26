# Claude Code & Codex CLI Key Rotator

为 **Claude Code** (命令 `ck`) 和 **OpenAI Codex CLI** (命令 `cx`) 设计的 API key 轮换工具。两套命令完全隔离 —— 各自的配置文件、端口、日志互不影响。支持**多中转站**、**启动前预检**、**运行中自动切换**——任何一个 key 失效或额度耗尽时,CLI 完全无感知地切到下一个 key。会话结束后自动展示**本次缓存命中率**。

---

## 1. 它解决什么问题

Claude Code 通过 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 环境变量连接 API。这两个变量在进程启动后**无法被外部修改**,所以"一个 key 用完换下一个"传统上做不到——只能重启。

本工具用一个本地 HTTP 代理打破这个限制:

```
Claude Code  ─HTTP→  本地代理 (127.0.0.1:8765)  ─HTTP→  中转站 A/B/C ...
                          ↑
                     收到 401/402/403/429
                     自动换下一个 key 重发
```

Claude Code 始终只连本地代理,代理负责"用哪个 key"这件事。

---

## 2. 目录结构

```
C:\Users\HP\claude-key-rotator\
├── rotator.js            Claude 主程序(CLI + 代理)
├── ck.cmd / ck.ps1       Claude 启动器
├── keys.json             Claude key 配置(首次 ck add 后自动生成)
├── rotator.log           Claude 代理运行日志
│
├── codex-rotator.js      Codex 主程序(CLI + 代理)
├── cx.cmd / cx.ps1       Codex 启动器
├── codex-keys.json       Codex key 配置(首次 cx add 后自动生成)
└── codex-rotator.log     Codex 代理运行日志
```

> **两套程序完全独立**:`ck` 和 `cx` 端口不同(默认 8765 / 8766)、配置文件不同、日志不同。你可以同时启动两个会话,互不干扰。

依赖:**只有 Node.js ≥ 18**(用到内置 `fetch`)。零 npm 依赖。

---

## 3. 安装

工具已经放在 `C:\Users\HP\claude-key-rotator\`。让 `ck` 命令在任何目录都能用,把它加入 PATH:

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  $env:Path + ";C:\Users\HP\claude-key-rotator",
  "User"
)
```

**新开一个终端**(PATH 变更需要重启 shell 才生效)后,直接用 `ck` 即可。

---

## 4. 命令一览

### 4.1 `ck`(Claude Code)

| 命令 | 作用 |
|------|------|
| `ck` 或 `ck start` | 启动 Claude Code(按顺序测 key、起代理、跑 claude) |
| `ck add` | 交互式添加 key |
| `ck add <name> <url> <key>` | 一行命令添加 key |
| `ck list` / `ck ls` | 列出所有 key |
| `ck test` | 一次性测试所有 key 的可用性 |
| `ck remove [编号]` / `ck rm` | 删除一个 key |
| `ck toggle <编号>` | 启用 / 禁用一个 key(不删除) |
| `ck help` | 显示帮助 |

`ck` 后面的多余参数会**透传给 claude**,例如:

```powershell
ck --resume        # 等价于先起代理,再 claude --resume
ck -c "解释 main.go"
```

### 4.2 `cx`(Codex CLI)

| 命令 | 作用 |
|------|------|
| `cx` 或 `cx start` | 启动 Codex CLI |
| `cx add` | 交互式添加 codex key |
| `cx add <name> <url> <key>` | 一行命令添加 codex key |
| `cx list` / `cx ls` | 列出所有 codex key |
| `cx test` | 测试所有 codex key |
| `cx remove [编号]` / `cx rm` | 删除一个 codex key |
| `cx toggle <编号>` | 启用 / 禁用一个 codex key |
| `cx help` | 显示帮助 |

`cx` 操作的是 `codex-keys.json`,**不会影响 ck 的配置**;反之亦然。多余参数同样透传给 `codex`。

---

## 5. 典型工作流

### 5.1 第一次使用(ck 为例,cx 用法完全相同,把 `ck` 换成 `cx`)

```powershell
ck add
# 名称:        我的中转站A
# base_url:    https://api.relay-a.com
# key:         sk-xxxx...

ck add
# 名称:        备用中转站B
# base_url:    https://api.relay-b.com
# key:         sk-yyyy...

ck test       # 确认两个 key 都能联通
ck            # 启动!
```

### 5.2 同时跑 Claude Code 和 Codex CLI

打开两个终端窗口,**互不影响**:

```powershell
# 终端 A
ck                 # Claude Code,本地代理 8765
```

```powershell
# 终端 B
cx                 # Codex CLI,本地代理 8766
```

### 5.2 日常使用

```powershell
ck            # 一条命令搞定
```

输出大致是:

```
按顺序测试 key...
  [1/3] 我的中转站A ... OK
使用 "我的中转站A",启动本地代理...
代理监听 http://127.0.0.1:8765
启动 Claude Code...

(Claude Code 界面...)
```

中途如果 key 1 额度用完:

```
[rotator] key "我的中转站A" 失效 (429),自动切换
[rotator] 切换到 "备用中转站B"
```

(终端里会有这两行红色提示,Claude Code 本身不会出错、不会断会话。)

### 5.3 删 / 加 / 禁用

```powershell
ck list                     # 看一下当前都有哪些
ck remove 2                 # 删第 2 个
ck toggle 1                 # 暂时禁用第 1 个(以后启用就再 toggle 一次)
ck add "新中转站" https://api.new.com sk-zzz   # 一行加
```

---

## 6. 配置文件格式

### 6.1 `keys.json`(Claude)

`ck add` 自动管理这个文件,但有时你想直接编辑也可以。结构:

```json
{
  "port": 8765,
  "keys": [
    {
      "name": "我的中转站A",
      "base_url": "https://api.relay-a.com",
      "key": "sk-xxxxxxxxxxxx",
      "enabled": true
    },
    {
      "name": "备用",
      "base_url": "https://api.relay-b.com",
      "key": "sk-yyyyyyyyyyyy",
      "enabled": true,
      "test_model": "claude-3-5-haiku-20241022"
    }
  ]
}
```

字段说明:

| 字段 | 必填 | 说明 |
|------|------|------|
| `port` | 否 | 本地代理监听端口,默认 8765 |
| `keys[].name` | 否 | 备注名,显示用 |
| `keys[].base_url` | **是** | 中转站根地址,**不要带 `/v1`** |
| `keys[].key` | **是** | API key 本体 |
| `keys[].enabled` | 否 | 默认 true,设 false 跳过 |
| `keys[].test_model` | 否 | 测试模型,默认 `claude-haiku-4-5-20251001`,失败时 fallback 到 `claude-3-5-haiku-20241022` |

> **顺序很重要**:列表从上到下就是优先级。把"主力 key"放最前面,"备胎"靠后。

### 6.2 `codex-keys.json`(Codex)

结构相同,但 `base_url` **建议带 `/v1`**(符合 OpenAI 标准),默认端口 `8766`:

```json
{
  "port": 8766,
  "keys": [
    {
      "name": "right-codes",
      "base_url": "https://right.codes/codex/v1",
      "key": "sk-...",
      "enabled": true,
      "test_model": "gpt-5.2-low"
    }
  ]
}
```

字段说明:

| 字段 | 必填 | 说明 |
|------|------|------|
| `port` | 否 | 本地代理监听端口,默认 8766 |
| `keys[].base_url` | **是** | OpenAI 兼容根地址。带不带 `/v1` 都行——代理会智能去重 |
| `keys[].key` | **是** | OpenAI 风格 key(`sk-...`) |
| `keys[].test_model` | 否 | 默认尝试 `gpt-4o-mini`、失败时 fallback 到 `gpt-5-codex` / `gpt-5` / `o4-mini` 等,再失败 fallback 到 right.codes 等中转站的自定义别名(如 `gpt-5.2-low`)。建议给每个 key 显式指定它真正能用的模型,加速启动 |

> **Codex 中转站的"模型名"经常是中转站自己定义的别名**(如 `gpt-5.3-codex`、`gpt-5.4-mini`)而非 OpenAI 官方模型名。可以用 `curl -H "Authorization: Bearer <key>" <base_url>/models` 看支持哪些。

---

## 7. 工作原理

### 7.1 启动阶段

1. 读 `keys.json`,从前往后扫描,对每个启用的 key 发一次 `max_tokens=1` 的 `hi` 请求(成本约 0.000003 美元)。
2. 第一个返回 200 的 key 被选为"当前 key"。
3. 在 `127.0.0.1:<port>` 启动 HTTP 代理。
4. 设置环境变量 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`,`ANTHROPIC_AUTH_TOKEN=rotator-managed`(占位符,代理会覆盖)。
5. spawn `claude` 子进程,stdio 直通终端。

### 7.2 运行阶段

代理对每个请求:

1. 复制 Claude Code 发来的 headers,**剔除** `host` / `content-length` / `authorization` / `x-api-key`(避免冲突)。
2. 注入当前 key 的 `x-api-key` 和 `Authorization: Bearer <key>`(同时给两种 header,兼容不同中转站)。
3. 拼接 `current.base_url + req.url`,转发请求体。
4. 收到响应:
   - **2xx / 3xx / 4xx(非切换状态码)/ 5xx**:直接流式回传给 Claude Code。
   - **401 / 402 / 403 / 407 / 429**:把当前 key 标记为本次会话失效,选下一个未失效的 key 重发**同一个请求**。
   - **网络错误**:同上,切换 + 重发。

### 7.3 触发切换的状态码

| 码 | 含义 | 触发切换? |
|----|------|-----------|
| 401 | 无效 / 过期 key | ✅ |
| 402 | Payment Required | ✅ |
| 403 | 禁止访问(常见于"账号余额不足") | ✅ |
| 407 | 代理认证失败 | ✅ |
| 429 | 限流 / 额度耗尽 | ✅ |
| 500-599 | 中转站服务器错误 | ❌(原样返回,Claude Code 自己有重试) |

### 7.4 已知边界

- **流式响应中途的失败无法重发**:`x-api-key` 错误在请求初始就返回,所以代理总能接住。但若中转站在 SSE 流中途突然返回错误事件,代理已经向客户端写了 200,无法回收。这种情况会直接返回错误给 Claude Code,你需要手动重试一次(代理会切换 key,所以下次重试用的是新 key)。
- **失效记录只在内存**:重启 `ck` 后重新测试所有 key(因为可能已经恢复,或者每天的额度已重置)。

### 7.5 Codex 代理(`cx`)的差异

和 Claude 代理基本一致,差异仅:

1. **环境变量**:设 `OPENAI_BASE_URL=http://127.0.0.1:8766/v1`、`OPENAI_API_KEY=rotator-managed`。
2. **Auth header**:只注入 `Authorization: Bearer <key>`(OpenAI 风格),不发 `x-api-key`。
3. **base_url 智能拼接**:`OPENAI_BASE_URL` 标准会带 `/v1`,而用户配置的 `base_url` 也可能带 `/v1`。代理检测重复并自动去掉,确保拼接出 `https://.../v1/chat/completions` 而不是 `.../v1/v1/...`。
4. **启动子进程**:`codex.cmd`(Windows)而非 `claude.cmd`。

### 7.6 本次会话缓存命中率

代理在转发响应时会"窥视"流量,累计 Anthropic 的 `cache_read_input_tokens`、`cache_creation_input_tokens`、`input_tokens`、`output_tokens`(或 Codex 的 `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens`)。当你退出 Claude Code / Codex CLI 时,代理会打印一份汇总:

```
====== 本次 Claude Code 会话统计 ======
时长:              1842 秒
请求数:            127
普通输入 token:    8,210
缓存写入 token:    34,500
缓存读取 token:    1,256,890
输出 token:        45,318
缓存命中率:        96.7%   (cache_read / 全部 input)
=======================================
```

字段含义:

- **普通输入 token**:这次请求里**没有命中缓存**、也**不是新写入缓存**的输入部分(走标准价)。
- **缓存写入 token**:这次请求里写进 cache 的新部分(走 1.25× 价,5min TTL)。下次重发同 prefix 时这部分就变成缓存读取。
- **缓存读取 token**:这次请求里命中了 cache 的部分(走 0.1× 价)。**这个数字越大越省钱。**
- **缓存命中率**:`缓存读取 / (普通输入 + 缓存写入 + 缓存读取)`。Claude Code 的典型会话会有 90%+ 命中率,因为 system prompt 和 tools 定义在每次请求里都重复。
- **请求数**:本次会话中你的客户端发了多少次实际请求(不包括 503 兜底)。

> **限制**:Codex 的 usage 统计要求客户端在请求中发了 `stream_options.include_usage: true`(Codex CLI 默认会发);如果中转站把这个字段删掉,统计可能为 0。无统计时只会显示一行提示。

---

## 8. 常见问题

### Q: 端口 8765 被占用怎么办?

改 `keys.json` 里的 `"port": 8765` 为别的端口,例如 `18765`。`cx` 同理,改 `codex-keys.json` 的 `"port": 8766`。

### Q: 我想自己看代理发了什么请求?

看 `rotator.log`(ck)或 `codex-rotator.log`(cx),每行带时间戳。

### Q: Claude Code / Codex 报错 `503 rotator_exhausted`?

所有 key 都已失效或耗尽。`ck test` 或 `cx test` 看一下当前状态;给账户充值或新加 key 后再次启动即可。

### Q: 测试 key 时报 `400 ... 未配置模型 ...`?

中转站不支持默认的测试模型。`cx` 的 fallback 链已经覆盖了主流别名(`gpt-4o-mini` → `gpt-5-codex` → `gpt-5.2-low` → ...),通常能自动找到能用的。如果都不行:

```powershell
# 查中转站到底支持哪些模型
curl -H "Authorization: Bearer <你的key>" https://your-relay.com/v1/models
```

然后在 `codex-keys.json` / `keys.json` 给该 key 加 `"test_model": "<它支持的名字>"`。

### Q: cx 启动后 Codex CLI 用什么模型?

代理**不改 model 字段**,只换 key。Codex CLI 自己用什么模型就走什么模型,中转站收到后该映射映射、该拒绝拒绝。`test_model` 只是预检阶段用,跟实际会话用的模型无关。

### Q: 我想暂时停用某个 key 但不想删?

`ck toggle <编号>` 或 `cx toggle <编号>`。

### Q: 怎么把 base_url 改了?

直接编辑 `keys.json` / `codex-keys.json` 改 `base_url` 字段,或者删了重新 add。

### Q: 是不是每次启动都会消耗几个 token 来测试?

是的。每个 key 大约 5 个 input + 1 个 output token,几乎可以忽略(haiku 4.5 大约 0.000003 美元)。但如果你某个 key **充值额度恰好在阈值附近**,被预检消耗可能让 Claude Code 启动后立刻触发切换——这是设计权衡,优先保证启动后稳定。

### Q: 代理会破坏上游的 prompt cache 吗?

**不会。**代理是字节透传 —— `cache_control` 标记和所有内容原样转发,上游收到的请求和直连时**字节级一致**。只要不发生 key 切换,缓存命中率和直连完全一样。一旦切到另一个 key(尤其是跨中转站),那一次必然 cache miss,之后在新 key 上重建。所以**把最稳定、额度最足的 key 放第一**对缓存最友好。

### Q: ck 和 cx 能同时跑吗?

可以。两个程序端口、配置、日志全部独立(8765 vs 8766;keys.json vs codex-keys.json),不会互相干扰。打开两个终端窗口分别 `ck` 和 `cx` 即可。

### Q: ck 退出后代理也退了吗?

是的。Claude Code / Codex CLI 子进程退出时,主进程会 `server.close()` 然后跟着退出。Ctrl+C 也走同一条路径。退出时会打印本次会话的 token / 缓存命中率统计。

---

## 9. 安全提示

⚠️ **`keys.json` 里是明文 API key**:

- 不要把这个目录提交到 git
- 不要截图或屏幕共享时露出
- 别人能读到你 home 目录就能读到你的 key——这工具不做加密,因为加密后启动时还是要在内存里解密给代理用,只是延后了风险

如果你的某个 key 泄露:立刻去中转站后台 revoke,然后 `ck remove` 删掉,`ck add` 加新的。

---

## 10. 卸载

```powershell
Remove-Item -Recurse -Force C:\Users\HP\claude-key-rotator
```

如果加过 PATH,从环境变量里把那一段删掉即可。
