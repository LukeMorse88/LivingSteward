# Living Steward

> 生活主管 = 本机电脑管家。**云端监督脑只拆目标、派任务、收状态位；本地执行脑带着插件手脚在你机器上干活；任何本地细节不出本机。**

内核只有 3 个文件（`core/kernel.mjs`、`core/loop.mjs`、`core/llm.mjs`），其余一切皆插件（everything is a plugin）。

---

## 一、它解决什么

大部分「AI 助手」把整台机器交出去：文件内容、命令输出、聊天记录全走云端。
Living Steward 反过来切一刀——**规划上云，执行留地**：

```
        你的一句话目标
              │
     ┌────────▼─────────┐
     │ 左栏 · 云端监督脑 │  DeepSeek，联网
     │ ask_user         │  只能拆目标 / 派子任务 / 收状态位
     │ dispatch         │  看不到本地文件、看不到工具输出
     └────────┬─────────┘
              │ 只下行「该做什么」，只上行「成功 / 失败」
     ┌────────▼─────────┐
     │ 右栏 · 本地执行脑 │  Qwen（llama-server，本机 Vulkan/CPU）
     │ shell / fs / 子Agent / MCP / 智库 …
     └────────┬─────────┘
              │
          你的文件系统（限工作区）
```

结果只留在右栏面板；左栏永远只收到一个状态位。

## 二、安全模型

| 机制 | 行为 |
|---|---|
| **上行只传状态位** | 左栏永远拿不到文件内容、命令输出、路径细节 |
| **L3 隐私否决** | 命中 密码 / 身份证 / 银行卡 / 病历 / 诊断 / 余额 / 工资 / 验证码 / 私钥 → 任何审批模式下直接拒绝 |
| **工作区闸门** | 写文件只允许在工作区内；工作区外一律拒绝，只读也不放行写 |
| **分模式授权** | `plan` 只读规划 → `suggest` 每步弹卡 → `auto-edit` 工作区内放行 → `full-auto` 全自动 |
| **审计留痕** | 每步工具调用落 `audit.jsonl`，`/audit` 查看审计尾 |
| **渲染进程隔离** | `contextIsolation` 开启，界面只加载本地页面，不载入任何远程网页 |

> 便携版为兼容企业 EDR 关闭了 Chromium 沙箱（配合 `--no-sandbox`），渲染进程只加载本地界面，不接触远程内容。

## 三、仓库结构与「什么不入库」

本仓库只放**应用源码**（约 1.35 MB）。便携包里的运行时大件刻意排除：

```
main.cjs          Electron 主进程：拉起双脑、IPC、审批闸门、密钥加载
core/
├─ kernel.mjs     内核：插件装载、工具注册、云/地双视图、闸门与审计
├─ loop.mjs       单轮对话主循环
└─ llm.mjs        LLM 客户端封装
gui/              渲染层：index.html / app.js / preload.cjs / style.css / vendor
plugins/          9 个插件（见下）
data/             会话 rollout / 配置 / 审计（仅保留目录占位）
docs/             使用手册（便携包说明书，已脱敏）
```

**不入库**（见 `.gitignore`）：

| 排除项 | 原因 |
|---|---|
| `brains/*.gguf`（Qwen3-8B ≈ 4.8 GB、Qwen3.5-2B ≈ 1.2 GB） | 超 GitHub 100 MB 单文件硬限；模型可从模型站重新获取 |
| `brains/`、`*.dll`、`*.exe` | llama.cpp 二进制与 Electron 主程序，属构建产物 |
| `deepseek.key`、`*.key` | **API 密钥，私密凭证，绝不入库** |
| `data/*`、`audit.jsonl`、`whitelist.json` | 会话记录、审计尾、本机路径 |
| `node_modules/` | 由 `npm install` 还原（唯一运行依赖：`marked`） |

想跑起来需要一个完整便携包（Electron 运行时 + `brains/` + 模型），本仓库是**源码**，不是可执行产物。

## 四、插件契约

一个插件 = 一个目录：

```
plugins/<名字>/
├─ plugin.json   { name, version, description, main, scope }
└─ index.mjs     export function setup(ctx) { … }
```

`ctx` 提供：

```
registerTool(tool)        给执行脑加手脚
registerCommand(cmd)      加 /斜杠命令
registerSkill(skill)      加技能
registerHook(event, fn)   挂钩子
registerService(name, s)  注册常驻服务
```

改完 `plugin_reload` 热重载，无需重启；`/restart` 重启整个应用。

`scope: 'cloud'` 的插件才会出现在**云脑**的工具视图里——内核强制云视图只允许监督通道插件，目前就是 `core-supervision`（`ask_user` / `dispatch`）。

### 内置插件

| 插件 | 作用 |
|---|---|
| `core-supervision` | 🔒 `scope: cloud` — 云脑唯一手脚：`ask_user` / `dispatch` |
| `core-shell` | PowerShell 执行：返回 exit code + 耗时 + 截断标记 |
| `core-fs` | 文件读 / 写 / 列 / 回滚，覆盖前自动快照 |
| `core-agent` | 子 Agent 委派：独立上下文，只收结论；`/review` 审查本轮 |
| `core-mcp` | MCP stdio 客户端：服务器工具动态注册为 `mcp__<server>__<tool>` |
| `core-session` | 会话 rollout：`/compact` `/new` `/fork` `/resume` `/sessions` |
| `core-control` | 控制面：`/help` `/mode` `/plan` `/ws` `/audit` `/stop` `/restart` |
| `think-tank` | 智库：`note` / `recall` / `deliberate` |
| `self-dev` | 自我开发：`self_list` / `self_read` / `self_write` / `plugin_reload` |

## 五、常用命令

| 命令 | 作用 |
|---|---|
| `/help` | 命令总览 |
| `/mode <模式>` · `/plan` | 切审批模式 / 进只读规划 |
| `/ws list·add·use·rm·rule` | 多工作区白名单管理 |
| `/compact` `/new` `/fork` `/resume` `/sessions` | 上下文压缩 / 新会话 / 分叉 / 恢复 / 列表 |
| `/think-tank` `/recall` `/note` | 智库：审议 / 检索 / 记笔记 |
| `/review` | 子 Agent 复核本轮 |
| `/self-dev` | 注入自开发契约 |
| `/audit` | 审计尾 |
| `/stop` · `/restart` | 中止本轮 / 重启应用 |

## 六、自己开发自己

源码完全裸露，`self_read` / `self_write` 可读写应用自身任意源码（路径相对 `resources/app`）。
右栏输入 `/self-dev 给智库加一个导出命令`，或让云脑 `dispatch` 写插件代码、本地落盘，`plugin_reload` 生效。

## 七、配置

- **云脑密钥**：优先级 `DEEPSEEK_API_KEY` 环境变量 > `deepseek.key` 文件 > `~/.dsh/.credentials.yaml`。仓库不含任何密钥，自行创建。
- **`brains.json`**：换模型 / 改端口 / 改 GPU 层数。任何 Vulkan 设备通吃 Intel / AMD / NVIDIA，无 GPU 自动回落 CPU。
  改端口记得同步 `core/kernel.mjs` 里的客户端端口。
- **`/ws add <名> <路径>`**：增加工作区，白名单按工作区独立。
- **兜底脑启动命令**：缺少 `brains/brains.json` 时，程序改用环境变量 `STEWARD_QUALITY_CMD` / `STEWARD_SPEED_CMD` 指定的命令拉起本地脑；未设置则跳过。

## 八、状态

版本 `1.0.0`（内核层 Codex 功能复刻）。出厂验证 8 阶段：slash / 智库、模式闸门、工作区外只读、self-dev 热重载 + hooks、skills、sessions、云派发链零审批、子 Agent + undo + 中止。

已知限制：Windows 10/11 x64 专用（`core-shell` 走 PowerShell）；本地脑需 ≥16 GB 内存（8B Q4 ≈ 6 GB）。

## 九、License

[Apache License 2.0](LICENSE) © 2026 LukeMorse88
