[中文](#中文) | [English](#english)

# codex2server

## 中文

## A2S 生态（同系列开源仓库）

A2S 按组件拆分为以下同系列仓库，所有者均为 `23J1633`。/ A2S is split into the following sibling repositories, all owned by `23J1633`.

| 仓库 / Repository | 作用 / Role | GitHub |
|---|---|---|
| A2Switch | Windows 桌面控制中心 / Windows desktop control center | [23J1633/A2Switch](https://www.github.com/23J1633/A2Switch) |
| cc2server | Claude Code 桥接器 / Claude Code bridge | [23J1633/cc2server](https://www.github.com/23J1633/cc2server) |
| codex2server | Codex 桥接器 / Codex bridge | [23J1633/codex2server](https://www.github.com/23J1633/codex2server) |
| dsh2server | DeepSeek Harness 插件 / DeepSeek Harness plugin | [23J1633/dsh2server](https://www.github.com/23J1633/dsh2server) |
| server-api | 中转服务与 Web 控制台 / relay server and Web console | [23J1633/server-api](https://www.github.com/23J1633/server-api) |
| a2s_app | Flutter Android 客户端 / Flutter Android client | [23J1633/a2s_app](https://www.github.com/23J1633/a2s_app) |
| scripts | 跨仓库验收脚本 / cross-repository acceptance scripts | [23J1633/scripts](https://www.github.com/23J1633/scripts) |
| ICON | A2S 品牌源图 / A2S brand source artwork | [23J1633/ICON](https://www.github.com/23J1633/ICON) |
| artifacts | 脱敏交付验证产物 / sanitized delivery evidence | [23J1633/artifacts](https://www.github.com/23J1633/artifacts) |

`codex2server` 把本机 OpenAI Codex 接入 A2S 服务器。它启动官方 `codex app-server --listen stdio://`，通过双向 JSON-RPC 调用 Codex，并把 thread/turn/item 事件转换为与 `dsh2server` 相同的会话与事件模型。

桥接器不抓取终端界面，也不解析 ANSI 文本；会话、审批、提问、模型列表和历史都来自 app-server 的结构化接口。

## 前置条件

- Node.js 22+；
- Codex CLI 已安装并完成登录；
- `codex --version` 与 `codex app-server --listen stdio://` 可由当前用户运行；
- 已有 A2S 共享配置，或允许桥接器创建初始配置。

Windows 说明：某些 npm 安装只提供 `codex.cmd`，但 `stdio://` 子进程在 Electron/Node 环境中通过 `.exe` 更稳定。A2Switch 与本桥接器会在 Windows 上把默认 `codex.cmd` 迁移为 `codex.exe`；如使用自定义安装，请在配置中填写实际可执行文件完整路径。

## 安装与诊断

```powershell
cd D:\Project\A2S\codex2server
npm install
node .\bin\codex2server.js doctor
```

`doctor` 会真实启动 app-server，完成 `initialize` / `initialized` 握手，再调用 `thread/list` 和 `model/list`。报告只显示 key 指纹，不泄露完整设备 key。

## 启动

```powershell
node .\bin\codex2server.js start
```

其他命令：

```powershell
node .\bin\codex2server.js config
node .\bin\codex2server.js status
node .\bin\codex2server.js --version
```

指定共享配置与 Codex 专用覆盖文件：

```powershell
node .\bin\codex2server.js start `
  --shared-config D:\config\a2s.json `
  --config D:\config\codex-bridge.json `
  --locale en-US
```

也可执行 `npm link` 后直接使用 `codex2server` 命令。

## 配置

共享配置由 A2Switch 维护，默认位于 `%APPDATA%\A2S\config.json`（Windows）。核心 Agent 段示例：

```json
{
  "device": {
    "id": "a2s-0123456789ab",
    "name": "workstation",
    "key": "a2sk_..."
  },
  "server": {
    "endpoints": ["https://example.com/a2s-api"],
    "transport": "auto"
  },
  "agents": {
    "codex": {
      "enabled": true,
      "autoStart": true,
      "locale": "system",
      "instanceId": "a2s-0123456789ab:codex",
      "executable": "codex.exe",
      "defaultCwd": "D:\\workspace"
    }
  }
}
```

专用字段可参考 [`config.example.json`](config.example.json)：

| 字段 | 默认 | 说明 |
|---|---|---|
| `executable` | `codex` / `codex.exe` | Codex 可执行文件 |
| `defaultCwd` | 启动目录 | 新 thread 默认目录 |
| `codexHome` | `null` | 可选 `CODEX_HOME` |
| `model` | `null` | 新会话默认模型 |
| `effort` | `null` | 推理强度；留空采用 Codex 默认 |
| `locale` | `system` | 插件语言：`system` / `zh-CN` / `en-US`；`system` 自动识别运行电脑的语言 |
| `approvalPolicy` | `on-request` | app-server 审批策略 |
| `permissionPreset` | `workspace-write` | A2S 权限预设 |
| `allowedCwdPrefixes` | `[defaultCwd]` | 文件浏览与新会话允许的路径前缀 |
| `codexRequestTimeoutMs` | `60000` | app-server JSON-RPC 超时 |
| `logLevel` | `info` | 日志级别 |

环境变量：

| 变量 | 说明 |
|---|---|
| `A2S_CONFIG_PATH` / `A2S_CONFIG_DIR` | 共享配置位置 |
| `A2S_ENDPOINTS` / `A2S_KEY` | 通用端点与 key 覆盖 |
| `CODEX2SERVER_ENDPOINT` / `CODEX2SERVER_KEY` | Codex 专用覆盖 |
| `CODEX_EXE` | Codex 可执行文件 |
| `CODEX_HOME` | Codex 数据目录 |

### 语言

推荐在 A2Switch 的“统一配置 → Codex → 插件语言”中切换。无 A2Switch 时可编辑 `agents.codex.locale`，或用 `--locale system|zh-CN|en-US` 临时覆盖。桥接器会把最终解析语言上报给 server-api，并用它生成插件侧状态说明；Codex 模型的原始回复不会被翻译或改写。

## app-server 生命周期

1. 启动 `codex app-server --listen stdio://`；
2. 发送带客户端信息和实验能力的 `initialize` 请求；
3. 发送 `initialized` 通知；
4. 读取现有 thread，并持续接收 turn/item 通知；
5. Codex 发起工具审批或 MCP elicitation 时，将 server request 转成 A2S 审批/问题事件；
6. 服务器应答后按对应 JSON-RPC 结果结构回给 Codex；
7. 桥接器退出时关闭 stdin 并终止仍未退出的 app-server。

历史优先从 Codex 的 append-only rollout JSONL 尾部按字节游标分页读取，序号在桥接器重启后仍保持稳定。刚创建的 thread 可能只有 `session_meta`、还没有 turn；当前 Codex app-server 还可能对 `thread/read(includeTurns)` 返回 `-32601 list_turns is not supported yet`。桥接器会把这两种情况识别为“空白且已到末页”，而不是创建失败，因此新会话可以立即显示并正常发送第一条提示词。

运行状态写入共享配置目录的 `runtime/codex.json`，供 A2Switch 使用。

## 统一方法

| 类别 | 方法 |
|---|---|
| 实例 | `instance.info`、`instance.health`、`instance.key` |
| 会话 | `session.list`、`session.create`、`session.get`、`session.prompt`、`session.interrupt`、`session.cancel` |
| 历史/检索 | `session.history`、`session.events`、`session.search` |
| 管理 | `session.rename`、`session.fork`、`session.archive` |
| 模型/权限 | `session.modelCatalog`、`session.selectModel`、`session.approvalPolicy`、`session.permission` |
| 交互 | `approval.respond`、`question.answer` |
| 目标 | `goal.get`、`goal.pause`、`goal.resume`、`goal.complete` |
| 工作区 | `workspace.list/create/rename/remove`、`workspace.fs.roots/list/read/mkdir` |
| 命令 | `command.run` |

Codex notification 会归一为 `turn/start`、`assistant/message`、`assistant/reasoning-delta`、`tool/call`、`tool/progress`、`tool/result`、`turn/end`、流式输出和状态事件。终端输出与思考摘要会增量到达控制台；错误结束保留稳定的 `{kind: "error", error: ...}` 结构，便于 Web 控制台正确区分完成、中断和失败。

## 权限映射

`thread/start.sandbox` 使用 Codex 对外枚举：

| A2S preset | `sandbox` | `approvalPolicy` |
|---|---|---|
| `read-only` | `read-only` | `on-request` |
| `workspace-write` | `workspace-write` | `on-request` |
| `full-access` | `danger-full-access` | `never` |

`turn/start.sandboxPolicy.type` 按 app-server schema 分别使用 `readOnly`、`workspaceWrite`、`dangerFullAccess`。两组字段命名不同，不能互换。

`allowedCwdPrefixes` 是桥接器自己的最后一道路径边界：新会话目录和 `workspace.fs.*` 请求解析为绝对路径后必须位于允许前缀内。

## 审批与问题

- shell/文件变更审批会生成唯一 interaction ID，并缓存原始 app-server request ID；
- `approval.respond` 接受允许、拒绝等控制台选择并解析原请求；
- app-server 的用户输入请求映射到 `question/request`；
- MCP elicitation 使用 `{ action, content }` 结果结构，与普通用户输入的 `{ answers }` 分开处理；
- 断开或退出时未决请求会失败，不会静默悬挂。

## 传输

与其他 A2S 桥接器一致：

- `auto` 优先 WebSocket并回退 HTTP 长轮询；
- `ws` 或 `http` 可强制指定载体；
- 支持多端点、心跳、指数退避重连、事件序号、有限补发缓冲和订阅快照；
- 同一个设备 key 与 `deviceId` 会被 server-api 和其他 Agent 实例聚合。

## 测试

```powershell
npm test
npm run check
npm run doctor
```

完整真实闭环：

```powershell
cd D:\Project\A2S
node .\scripts\full-loop-test.mjs
```

该测试会通过 server-api 创建真实 Codex thread、下发标记提示词、等待模型回复、检查统一历史事件并归档测试 thread。

单元测试还覆盖空白 thread 的 `list_turns` 兼容，以及仅含元数据的 rollout 不会错误上报 `hasMore`，防止控制台在新会话顶部显示不存在的更早历史。

## 协议升级

Codex app-server 会随 Codex CLI 演进。升级 CLI 后建议：

```powershell
codex app-server generate-json-schema --out <temporary-directory>
npm run doctor
npm test
```

实现依据应以 [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server) 和当前安装版本生成的 JSON Schema 为准。

## 目录结构

```text
codex2server/
├─ bin/codex2server.js       CLI 与 doctor
├─ index.js                  配置装配与应用工厂
├─ lib/codex-app-server.js   stdio JSON-RPC 客户端
├─ lib/codex-adapter.js      A2S 方法、事件、审批与文件适配
├─ lib/a2s/                  共享配置、协议和 relay 传输
└─ test/                     事件与统一配置测试
```

`package-lock.json` 固定当前安装图，建议 CI 使用 `npm ci`。当前生产依赖审计为 0 个已知漏洞。

## 许可证

MIT，见 `LICENSE`。OpenAI 与 Codex 是 OpenAI 的商标；本项目是独立的兼容桥接器。

---

## English

`codex2server` connects local OpenAI Codex to an A2S relay. It launches the official `codex app-server --listen stdio://`, communicates through bidirectional JSON-RPC, and converts thread/turn/item notifications into the shared A2S session and event model. It never scrapes terminal UI or parses ANSI text.

### Requirements and installation

- Node.js 22 or newer.
- An installed and authenticated `codex` CLI with `app-server` support.
- A registered A2S device key and server endpoint, normally maintained by A2Switch.

Use A2Switch's **Install/update all** action for normal installation. For development:

```powershell
npm install
node .\bin\codex2server.js doctor
node .\bin\codex2server.js start --shared-config "$env:APPDATA\A2S\config.json"
```

The diagnostic command checks Node, Codex discovery/version, app-server startup, shared configuration, endpoints, and server health without exposing full keys.

### Configuration

The default shared file is the A2Switch configuration; override it with `A2S_CONFIG_PATH`. CLI/environment settings may select endpoints, transport, locale, Codex executable, default working directory, reconnect behavior, and optional remote terminal support. Per-Agent locale accepts `system`, `zh-CN`, and `en-US`.

### App-server lifecycle and sessions

One managed app-server process multiplexes Codex threads. The bridge initializes the JSON-RPC connection, tracks server requests, reads thread and turn notifications, and restarts cleanly after process or transport failure. Existing threads remain native Codex threads and are listed/searched through app-server APIs rather than a duplicate transcript database.

### Unified methods

The adapter covers instance status, thread/session list/search/create/read/prompt/interrupt/rename/fork/archive, models, reasoning and permission settings, structured user questions, command/file approvals, goals/tasks, workspaces, restricted file access, event replay/subscription, and optional terminals. The negotiated catalog reflects the detected app-server schema so unavailable methods are not advertised.

A2S permission presets map to Codex sandbox and approval policies. Incoming app-server approval/question requests are forwarded as structured pending interactions and resolved back over JSON-RPC. Workspace path checks, payload limits, and disabled-by-default terminals preserve local boundaries.

### Transport and recovery

The relay client prefers WebSocket and automatically falls back to HTTP long polling for retryable network or upgrade failures. Fatal authentication/protocol errors do not loop indefinitely. Heartbeat, exponential backoff with jitter, runtime records, event watermarks, and replay keep long-running turns usable across temporary network loss.

### Tests

```powershell
npm test
npm run check
```

Tests cover JSON-RPC lifecycle, notifications, approvals/questions, unified configuration, protocol methods, transports, recovery, workspaces, files, and security constraints. `package-lock.json` pins the graph and CI should use `npm ci`.

### License

MIT. OpenAI and Codex are OpenAI trademarks. This project is an independent compatibility bridge and is not endorsed by OpenAI.
