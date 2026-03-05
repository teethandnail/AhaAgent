# AhaAgent 使用说明书

## 文档索引

### 规范层（长期维护）

- `README.md`：运行、配置、排障、使用说明（Owner: Maintainer）
- `doc/产品需求与范围.md`：产品目标、范围、非目标、阶段计划（Owner: PM/Tech Lead）
- `doc/技术设计文档.md`：系统架构、模块职责、关键流程（Owner: Tech Lead）
- `doc/协议契约与错误码规范.md`：协议字段、工具契约、错误码（Owner: Server + Client）
- `doc/PolicyEngine决策表.md`：策略规则、审批矩阵（Owner: Server/Security）
- `doc/验收测试与CI门禁.md`：测试矩阵、CI 通过标准（Owner: QA/Infra）

### 归档层（历史方案）

- `docs/plans/`：阶段性计划与执行稿，仅供历史追溯，不作为当前规范来源。

## 目录

1. [环境要求](#1-环境要求)
2. [安装与构建](#2-安装与构建)
3. [配置 LLM API](#3-配置-llm-api)
4. [启动服务](#4-启动服务)
5. [使用 Web 界面](#5-使用-web-界面)
6. [开发模式](#6-开发模式)
7. [项目结构说明](#7-项目结构说明)
8. [命令参考](#8-命令参考)
9. [常见问题](#9-常见问题)

---

## 1. 环境要求

| 依赖     | 最低版本 | 说明                       |
| -------- | -------- | -------------------------- |
| Node.js  | 22.x     | 推荐 LTS 版本             |
| npm      | 10.x     | 随 Node.js 一起安装       |
| 操作系统 | macOS / Linux | Windows 尚未测试       |

确认版本：

```bash
node -v   # 应输出 v22.x.x 或更高
npm -v    # 应输出 10.x.x 或更高
```

## 2. 安装与构建

```bash
# 1. 克隆仓库
git clone <repo-url> AhaAgent
cd AhaAgent

# 2. 安装所有依赖（npm workspaces 会自动安装三个子包的依赖）
npm install

# 3. 构建 TypeScript（shared → server → client）
npm run build
```

构建成功后，`packages/server/dist/` 下会生成编译后的 JS 文件。

### 验证安装

```bash
# 运行全部测试
npm test

# 类型检查
npm run typecheck

# 代码风格检查
npm run lint
```

## 3. 配置 LLM API

AhaAgent 使用 OpenAI-compatible 接口，支持 OpenAI、Claude (via proxy)、DeepSeek 等供应商。

### 方式一：环境变量（推荐）

```bash
# 必填：API 密钥
export AHA_LLM_API_KEY="sk-your-api-key-here"

# 可选：供应商名称（默认 openai）
export AHA_LLM_PROVIDER="openai"

# 可选：模型名称（默认 gpt-4）
export AHA_LLM_MODEL="gpt-4o"

# 可选：API Base URL（默认 https://api.openai.com/v1）
export AHA_LLM_BASE_URL="https://api.openai.com/v1"
```

**使用不同供应商的示例：**

```bash
# OpenAI
export AHA_LLM_API_KEY="sk-..."
export AHA_LLM_MODEL="gpt-4o"
export AHA_LLM_BASE_URL="https://api.openai.com/v1"

# DeepSeek
export AHA_LLM_API_KEY="sk-..."
export AHA_LLM_PROVIDER="deepseek"
export AHA_LLM_MODEL="deepseek-chat"
export AHA_LLM_BASE_URL="https://api.deepseek.com/v1"

# Claude (通过 OpenAI-compatible proxy，如 LiteLLM)
export AHA_LLM_API_KEY="sk-..."
export AHA_LLM_PROVIDER="claude"
export AHA_LLM_MODEL="claude-sonnet-4-6"
export AHA_LLM_BASE_URL="http://localhost:4000/v1"

# 本地模型（Ollama）
export AHA_LLM_API_KEY="ollama"
export AHA_LLM_PROVIDER="ollama"
export AHA_LLM_MODEL="llama3"
export AHA_LLM_BASE_URL="http://localhost:11434/v1"
```

### 方式二：配置文件

创建 `~/.aha/config.json`：

```json
{
  "llm": {
    "provider": "openai",
    "apiKey": "sk-your-api-key-here",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1"
  }
}
```

```bash
# 创建配置目录
mkdir -p ~/.aha

# 创建配置文件
cat > ~/.aha/config.json << 'EOF'
{
  "llm": {
    "provider": "openai",
    "apiKey": "sk-your-api-key-here",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1"
  }
}
EOF
```

> **优先级**：环境变量 > 配置文件。如果同时设置，环境变量优先。

> **注意**：不配置 LLM 也可以启动，但 AI 对话功能将不可用。启动时会显示警告：`Warning: No LLM config found. LLM features will be unavailable.`

## 4. 启动服务

### 快速启动

```bash
# 构建（首次或代码更改后需要）
npm run build

# 启动 Daemon（后端服务）
node packages/server/dist/cli.js [工作区路径]
```

**参数说明：**

| 参数/环境变量  | 默认值             | 说明                                 |
| -------------- | ------------------ | ------------------------------------ |
| 第一个命令行参数 | 当前目录 (cwd)     | 工作区路径，Agent 只能操作此目录下的文件 |
| `AHA_PORT`     | `3000`             | HTTP/WebSocket 服务端口              |
| `AHA_ORIGIN_PORT` | `5173`          | 允许的前端 Origin 端口（默认匹配 Vite） |

**启动示例：**

```bash
# 以当前目录为工作区，默认端口 3000
node packages/server/dist/cli.js

# 指定工作区目录
node packages/server/dist/cli.js /path/to/your/project

# 指定端口
AHA_PORT=8080 node packages/server/dist/cli.js /path/to/your/project
```

成功启动后会输出：

```
AhaAgent daemon started
  URL: http://localhost:3000
  Token: <session-token>
  Workspace: /path/to/your/project
```

> **Token** 是本次会话的鉴权令牌，前端通过 WebSocket 连接时需要携带。
> 当前前端会在启动时先请求 `http://localhost:<AHA_PORT>` 获取 token，再自动拼接到 WebSocket 连接 URL，你无需手动输入。

### 启动前端

打开另一个终端窗口：

```bash
cd packages/client
npx vite --port 5173
```

然后在浏览器中打开 `http://localhost:5173`。

### 一键开发模式（前后端同时启动）

```bash
# 在根目录执行，同时启动 shared/server/client 的 watch 模式
npm run dev
```

> 注意：`npm run dev` 使用 `concurrently` 同时运行三个包的 dev 脚本。server 使用 `tsx watch` 热重载，client 使用 Vite HMR。

## 5. 使用 Web 界面

### 界面布局

打开 `http://localhost:5173` 后，界面分为以下区域：

```
┌──────────────────────────────────────────────┐
│  AhaAgent          [Tasks] [DevConsole]       │  ← 顶部导航栏
├────────────────────────────────┬─────────────┤
│                                │             │
│    聊天对话区域                  │  任务面板    │
│                                │ (可折叠)     │
│    [用户消息]                   │             │
│    [AI 回复]                    │  ■ Task 1   │
│    [用户消息]                   │    ✓ Step 1 │
│                                │    ● Step 2 │
│                                │             │
├────────────────────────────────┴─────────────┤
│  [输入框...]                        [发送]     │
└──────────────────────────────────────────────┘
```

### 核心功能

#### 1. 聊天对话

在底部输入框中输入消息，点击"发送"或按 Enter。AI 会流式返回响应。

#### 2. 任务面板

点击顶部 **Tasks** 按钮打开右侧任务面板：

- **状态图标**：
  - ⚪ 灰色 = 等待中 (pending)
  - 🔵 蓝色旋转 = 执行中 (running)
  - 🟡 黄色警告 = 等待审批 (blocked)
  - 🟢 绿色勾选 = 成功 (success)
  - 🔴 红色叉号 = 失败 (failed)
  - ⚫ 灰色删除线 = 已取消 (cancelled)

- 可展开子任务树
- 执行中/等待审批的任务可点击"取消"

#### 3. 审批弹窗

当 Agent 需要执行高风险操作（写入文件、删除文件、执行命令、安装扩展）时，会弹出审批对话框：

- 显示操作类型、目标文件/命令
- 显示风险等级 (medium / high / critical)
- 显示 Diff 预览（文件修改时）
- 显示审批倒计时（过期后自动失效）
- 点击"批准"允许执行，点击"拒绝"阻止操作

#### 4. 开发者控制台

点击顶部 **DevConsole** 按钮打开底部抽屉，显示所有原始 WebSocket 消息：

- `IN` = 服务端发来的消息
- `OUT` = 客户端发出的消息
- 用于调试和排查问题

### 连接状态

界面顶部会显示 WebSocket 连接状态：

- 🟢 `connected` — 已连接
- 🟡 `connecting` — 连接中
- 🔴 `disconnected` — 已断开
- ❌ `error` — 连接错误

## 6. 开发模式

### 热重载开发

```bash
# 终端 1：启动所有服务的热重载模式
npm run dev
```

这会同时启动：
- `packages/shared` — TypeScript 编译监听
- `packages/server` — tsx watch 自动重启
- `packages/client` — Vite HMR 热更新

### 运行测试

```bash
# 运行所有测试
npm test

# 监听模式（修改文件自动重跑）
npm run test:watch

# 带覆盖率报告
npm run coverage

# 只运行某个模块的测试
npx vitest run --project server src/orchestrator/
npx vitest run --project server src/policy/
npx vitest run --project server src/gateway/
npx vitest run --project shared
```

### 代码质量

```bash
# ESLint 检查
npm run lint

# 自动修复
npm run lint:fix

# Prettier 格式化
npm run format

# 只检查不修改
npm run format:check
```

## 7. 项目结构说明

```
AhaAgent/
├── packages/
│   ├── shared/                  # 共享类型和协议
│   │   └── src/
│   │       ├── protocol.ts      # WebSocket 消息信封、事件类型
│   │       ├── errors.ts        # 错误码定义 (AHA-xxx-NNN)
│   │       ├── tools.ts         # 工具调用接口
│   │       ├── policy.ts        # 策略引擎接口
│   │       └── task.ts          # 任务/审批/检查点接口
│   │
│   ├── server/                  # 后端 Daemon
│   │   └── src/
│   │       ├── app.ts           # ★ 主入口，模块串联
│   │       ├── cli.ts           # CLI 启动脚本
│   │       ├── gateway/         # WebSocket 网关 + 鉴权
│   │       ├── policy/          # 策略引擎（默认拒绝）
│   │       ├── tools/           # 文件沙箱 + 工具处理
│   │       ├── orchestrator/    # 任务状态机 + 审批 + 检查点
│   │       ├── llm/             # LLM 路由（OpenAI-compatible）
│   │       ├── memory/          # 记忆系统（jieba 分词 + FTS5 + 上下文压缩）
│   │       ├── logger/          # 结构化日志 + 脱敏
│   │       ├── extensions/      # MCP 扩展安装 + 隔离运行
│   │       └── db/              # SQLite schema + 客户端
│   │
│   └── client/                  # 前端 Web UI
│       └── src/
│           ├── App.tsx          # 主布局
│           ├── stores/          # Zustand 状态管理
│           │   ├── websocket.ts # WebSocket 连接管理
│           │   └── task.ts      # 任务状态管理
│           └── components/      # React 组件
│               ├── ChatWindow.tsx
│               ├── ApprovalDialog.tsx
│               ├── TaskPanel.tsx
│               ├── TaskTree.tsx
│               └── DevConsole.tsx
│
├── doc/                         # 需求/设计文档
├── docs/plans/                  # 实施计划
├── package.json                 # 根 package（npm workspaces）
├── tsconfig.base.json           # TypeScript 基础配置
├── eslint.config.mjs            # ESLint 9 flat config
├── vitest.config.ts             # Vitest 测试配置
└── prettier.config.js           # 代码格式化配置
```

### 数据目录

运行后会在 `~/.aha/` 下创建以下结构：

```
~/.aha/
├── config.json          # LLM 配置文件
├── aha.db               # SQLite 数据库（任务、检查点、记忆、审计）
├── logs/
│   ├── aha-info.log     # 信息日志
│   ├── aha-error.log    # 错误日志
│   └── aha-audit.log    # 审计日志（审批、执行、取消记录）
└── extensions/          # 已安装的 MCP 扩展
```

## 8. 命令参考

### 启动命令

```bash
# 标准启动
node packages/server/dist/cli.js [workspace-path]

# 带环境变量
AHA_PORT=8080 AHA_LLM_API_KEY=sk-xxx node packages/server/dist/cli.js ./my-project

# 开发模式（热重载）
npm run dev
```

### 构建命令

```bash
npm run build          # 构建所有包
npm run build:clean    # 清理后重新构建
```

### 测试命令

```bash
npm test               # 运行所有测试
npm run test:watch     # 监听模式
npm run coverage       # 覆盖率报告
```

### 代码质量命令

```bash
npm run lint           # ESLint 检查
npm run lint:fix       # ESLint 自动修复
npm run format         # Prettier 格式化
npm run format:check   # Prettier 检查
npm run typecheck      # TypeScript 类型检查
```

### 浏览器自动化（可选）

如果你希望 Agent 直接操作真实浏览器（`browser_tool`），需要额外安装 Playwright：

```bash
npm i -w packages/server playwright
npx playwright install chromium
```

可选环境变量：

```bash
# 默认 0（可见窗口）；设置为 1 使用无头模式
export AHA_BROWSER_HEADLESS=0

# 可选：指定浏览器通道（例如 chrome、msedge）
export AHA_BROWSER_CHANNEL=chrome
```

如果你希望 Agent 直接使用你平常登录态的浏览器（不重复登录），可使用 CDP 连接模式：

```bash
# 1) 先手动启动你自己的 Chrome（带远程调试端口）
# macOS 示例：
open -na "Google Chrome" --args --remote-debugging-port=9222

# 2) 启动 AhaAgent 时指向该端口
export AHA_BROWSER_CDP_URL=http://127.0.0.1:9222
node packages/server/dist/cli.js
```

## 9. 常见问题

### Q: 启动时报 "No LLM config found"

这是正常警告，表示未配置 LLM API。Daemon 可以正常启动，但 AI 对话功能不可用。参考 [配置 LLM API](#3-配置-llm-api) 进行设置。

### Q: 前端无法连接后端

1. 确认后端已启动并正在监听（检查终端输出的端口号）
2. 前端默认连接 `ws://localhost:3000`，如果后端端口不同，需要修改前端代码中的连接地址
3. 检查浏览器控制台是否有 WebSocket 连接错误

### Q: 端口被占用

```bash
# 使用其他端口
AHA_PORT=8080 node packages/server/dist/cli.js
```

### Q: 构建失败

```bash
# 清理后重新构建
npm run build:clean

# 如果依赖有问题，重新安装
rm -rf node_modules packages/*/node_modules
npm install
npm run build
```

### Q: 测试失败

```bash
# 查看详细测试输出
npx vitest run --reporter=verbose

# 运行单个测试文件
npx vitest run packages/server/src/policy/policy-engine.test.ts
```

### Q: 为什么提示 `playwright is not installed`？

你触发了 `browser_tool`，但服务端还没安装浏览器驱动依赖。执行：

```bash
npm i -w packages/server playwright
npx playwright install chromium
```

### Q: 我想让 Agent 直接使用我平常登录过的网站会话，怎么做？

推荐使用 `AHA_BROWSER_CDP_URL`：

1. 用 `--remote-debugging-port=9222` 启动你当前日常 Chrome。
2. 启动 AhaAgent 前设置 `AHA_BROWSER_CDP_URL=http://127.0.0.1:9222`。
3. Agent 会优先连接这个已运行的浏览器实例，而不是新开隔离上下文。

### Q: Agent 只能读取工作区内的文件吗？

是的。这是安全设计的一部分。Agent 只能访问启动时指定的工作区目录内的文件。尝试访问工作区外的路径会被文件沙箱拦截，返回 `AHA-SANDBOX-001` 错误。

### Q: 敏感文件（.env, *.key 等）会被发送给 LLM 吗？

不会。以下文件会被自动标记为敏感文件并禁止外发：
- `.env*` — 环境变量文件
- `*.pem`, `*.key` — 证书和密钥
- `id_rsa*`, `.ssh/*` — SSH 密钥
- `.npmrc` — npm 配置（可能包含 token）
- `secrets.*` — 秘密配置文件

### Q: 记忆系统是怎么工作的？

AhaAgent 内置长期记忆系统，Agent 会自主决定何时读取和写入记忆：

- **自动记忆**：当对话中出现值得长期保留的信息（用户偏好、项目事实、重要决策），Agent 会自动调用 `memory_store` 存储
- **自动回忆**：当用户提问涉及历史信息时，Agent 会自动调用 `memory_search` 搜索相关记忆
- **跨会话持久化**：记忆存储在 SQLite 数据库中（`~/.aha/aha.db`），重启服务后记忆依然保留
- **中英文支持**：使用 `@node-rs/jieba` 分词引擎，中文按词语切分（如"喜欢"、"牛肉"），英文按单词切分
- **上下文压缩**：当对话接近上下文窗口上限时，系统自动触发记忆存盘 + 历史消息压缩

相关环境变量：

```bash
# 上下文窗口 token 上限（默认 128000）
export AHA_CONTEXT_WINDOW=128000

# 记忆条目上限，超过后自动淘汰低价值记忆（默认 500）
export AHA_MEMORY_MAX_ENTRIES=500
```

### Q: 对话历史会保持吗？

是的。同一个对话（conversationId）内的消息历史会在内存中保持，Agent 能记住你在当前对话中说过的话。重启服务后对话历史会清空，但通过记忆系统存储的长期信息会保留。

### Q: 当前版本的限制

这是 V1 版本，当前已支持基础 Agent 自动循环（含工具调用与审批恢复），但仍有以下已知边界：

1. **断点恢复**：CheckpointManager 已实现，Daemon 重启后的自动恢复流程仍在完善
2. **扩展系统**：安装校验和隔离运行器已实现，MCP 协议通信仍需补全
3. **浏览器自动化**：`browser_tool` 已可用，但复杂站点（反爬、强登录流程、验证码）成功率受站点策略影响
4. **生产化配置**：前端仍以 `VITE_WS_PORT` 为主配置入口，生产环境建议统一配置下发机制

---

_文档版本：V1.1 | 更新日期：2026-03-06_
