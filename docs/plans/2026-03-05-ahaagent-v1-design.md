# AhaAgent V1 Implementation Design

## Tech Decisions

- **Frontend**: React + TypeScript
- **Backend**: Node.js + TypeScript
- **Package Manager**: npm
- **Project Structure**: Monorepo (`packages/shared`, `packages/server`, `packages/client`)
- **Storage**: SQLite
- **Realtime**: WebSocket
- **Scope**: Strict minimal loop (security/protocol -> task orchestration -> extensions)

## Monorepo Structure

```
packages/
  shared/      — Types, protocol contracts, error codes, validators
  server/      — Daemon Core (Gateway, PolicyEngine, ToolEngine, Orchestrator, LLM Router, Memory, Extensions)
  client/      — React Web Client (Chat UI, Approval dialogs, Task panels, Dev console)
```

## Phased Parallel Development

### Phase 0: Foundation (Serial, prerequisite for all)

- Monorepo scaffolding (npm workspaces, tsconfig, eslint, prettier)
- Shared types: WsEnvelope, events, ToolCall/ToolResult, TaskNode, ApprovalRequest, Checkpoint, PolicyInput, error codes
- JSON Schema validators from protocol spec

### Phase 1: Security + Protocol Skeleton (6 parallel tracks)

1. **WS Gateway + Auth**: HTTP/WS server, sessionToken generation/validation, Origin check, envelope middleware, idempotency dedup
2. **Policy Engine**: evaluate() function, hard-deny rules (D-001~D-006), approval rules, allow matrix, command whitelist/blacklist
3. **File Sandbox (Tool Engine)**: path.resolve + realpath validation, workspace jail, symlink rejection, sensitivity classification, sanitization pipeline
4. **LLM Router**: OpenAI-compatible adapter, multi-provider config, retry with exponential backoff, traceId tracking, context compression stub
5. **Audit Logger**: Structured logging (traceId, taskId, requestId, actor, action, result), file rotation (info/error/audit), sanitization before write
6. **React Frontend Skeleton**: Chat UI with streaming, WebSocket client with auth, approval dialog component, dev console drawer

### Phase 2: Task Orchestration (4 parallel tracks, after Phase 1)

7. **Task State Machine + Queue/Locks**: State transitions (idle->planning->running->awaiting_approval->success/failed/cancelled), ReadQueue (concurrent), MutationQueue (serial), file-level locks with TTL
8. **Checkpoint + Recovery**: Checkpoint persistence to SQLite, approval-decoupled recovery, daemon restart recovery
9. **Approval Full Flow**: nonce generation + one-time validation, expiry enforcement, scope validation (workspace/maxActions/timeout), front-back integration
10. **Frontend Task Panel**: Task tree/DAG visualization, status badges, progress indicators, cancel controls

### Phase 3: Memory + Extensions (2 parallel tracks, after Phase 2)

11. **Memory System**: SQLite schema (access_count, last_accessed_at, sensitivity), short-term session cache with summarization, long-term recall (TopK, non-sensitive), LRU + value-score eviction
12. **Extension System (MCP)**: Install flow (whitelist, manifest+SHA256+signature verify, permission declaration), isolated Runner (separate process, resource limits), health check, tool directory registration

## Key Interfaces Between Modules

- All modules depend on `packages/shared` types only
- Gateway dispatches to Orchestrator via internal event bus
- Orchestrator calls PolicyEngine.evaluate() before every tool execution
- ToolEngine enforces sandbox independently of PolicyEngine
- LLM Router is called by Orchestrator, returns structured tool calls
- Audit Logger is cross-cutting, injected via middleware/decorator pattern

## Testing Strategy

Per `验收测试与CI门禁.md`:

- Unit: Policy decisions, error code mapping, tool param validation
- Integration: WS protocol, task state machine, checkpoint recovery, file sandbox
- Security: Auth bypass, path escape, sensitive data egress, approval replay
- E2E: Full session from message to approval to terminal state
