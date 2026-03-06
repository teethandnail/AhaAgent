# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指引。

## 项目简介

AhaAgent 是一个带 Web UI 的 AI Agent，通过 OpenAI 兼容接口调用 LLM，执行文件操作、浏览器自动化等任务，关键操作需人工审批。

## 常用命令

```bash
npm run build              # 构建所有包（shared → server → client）
npm run build:clean        # 清理后重新构建
npm run dev                # 热重载开发（同时启动三个包）
npm test                   # 运行全部测试（vitest）
npm run test:watch         # 监听模式
npx vitest run packages/server/src/policy/policy-engine.test.ts  # 运行单个测试文件
npm run lint               # ESLint 检查
npm run lint:fix           # ESLint 自动修复
npm run format             # Prettier 格式化
npm run typecheck          # TypeScript 类型检查
```

启动后端：`node packages/server/dist/cli.js [工作区路径]`
启动前端：`cd packages/client && npx vite --port 5173`

## 架构

TypeScript monorepo，使用 npm workspaces 管理 3 个包：

- **packages/shared** — 共享协议类型、错误码（`AHA-xxx-NNN`）、工具/策略/任务接口。server 和 client 均依赖此包。
- **packages/server** — 后端 Daemon（Node.js），核心模块：
  - `app.ts` — 主入口，串联所有模块
  - `gateway/` — WebSocket 网关 + Token 鉴权
  - `orchestrator/` — 任务状态机、审批流程、检查点
  - `policy/` — 策略引擎（默认拒绝，按规则放行）
  - `tools/` — 文件沙箱（仅允许访问工作区）+ 工具处理器
  - `llm/` — OpenAI 兼容 LLM 路由
  - `memory/` — 长期记忆（SQLite FTS5 + jieba 分词 + 上下文压缩）
  - `extensions/` — MCP 扩展安装 + 隔离运行
  - `db/` — SQLite schema + 客户端
- **packages/client** — React Web UI（Vite + Zustand），通过 WebSocket 连接后端。

## 关键设计决策

- **默认拒绝策略**：所有工具执行须经 PolicyEngine 审查，高风险操作需用户通过 WebSocket 审批
- **文件沙箱**：Agent 仅能访问启动时指定的工作区目录内的文件
- **敏感文件屏蔽**：`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc`、`secrets.*` 不会发送给 LLM
- **构建顺序**：shared 必须先于 server 和 client 构建（tsconfig project references 已处理）

## 技术栈

- TypeScript（ES2022、NodeNext 模块、严格模式、`noUncheckedIndexedAccess`）
- Vitest 测试（每个包有独立 `vitest.config.ts`，根配置通过 `projects` 聚合）
- ESLint 9 flat config + Prettier
- SQLite 持久化（`~/.aha/aha.db`）

## 环境变量

- `AHA_LLM_API_KEY`、`AHA_LLM_PROVIDER`、`AHA_LLM_MODEL`、`AHA_LLM_BASE_URL` — LLM 配置
- `AHA_PORT`（默认 3000）、`AHA_ORIGIN_PORT`（默认 5173）— 服务端口
- `AHA_BROWSER_HEADLESS`、`AHA_BROWSER_CDP_URL` — 浏览器自动化
- `AHA_CONTEXT_WINDOW`、`AHA_MEMORY_MAX_ENTRIES` — 记忆系统调优
