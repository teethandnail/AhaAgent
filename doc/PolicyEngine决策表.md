# AhaAgent Policy Engine 决策表（V1）

## 1. 目标

定义统一授权决策：`allow` / `deny` / `require_approval`。

目标是让 AI Agent 与人工开发都能按同一策略实现，避免边界漂移。

## 2. 决策输入模型

```ts
type Actor = 'user' | 'assistant' | 'extension';

type Action =
  | 'read_file'
  | 'list_dir'
  | 'grep'
  | 'web_search'
  | 'fetch_url'
  | 'browser_open'
  | 'extract_main_content'
  | 'diff_edit'
  | 'write_file'
  | 'delete_file'
  | 'run_command'
  | 'install_extension'
  | 'invoke_extension_tool'
  | 'send_to_llm';

interface PolicyInput {
  actor: Actor;
  action: Action;
  resource: {
    path?: string;
    workspace?: string;
    command?: string;
    extensionId?: string;
    sensitivity?: 'public' | 'restricted' | 'secret';
  };
  context: {
    taskId?: string;
    hasUserApproval?: boolean;
    approvalScope?: {
      workspace: string;
      maxActions: number;
      expiresAt: string;
    };
    trustedSource?: boolean;
    originValid?: boolean;
    sessionValid?: boolean;
  };
}
```

## 3. 决策优先级（从高到低）

1.  **硬拒绝规则**（命中即 `deny`）。
2.  **会话与来源校验**（不合法即 `deny`）。
3.  **审批范围校验**（超范围即 `deny`）。
4.  **需审批动作判断**（未审批则 `require_approval`）。
5.  **允许规则**（满足条件才 `allow`）。
6.  兜底规则：`deny`。

## 4. 硬拒绝规则（P0）

| 编号  | 条件                                                         | 决策 | 错误码             |
| ----- | ------------------------------------------------------------ | ---- | ------------------ |
| D-001 | `sessionValid=false` 或 `originValid=false`                  | deny | `AHA-AUTH-001/002` |
| D-002 | `path` 不在 `allowed_workspaces`                             | deny | `AHA-SANDBOX-001`  |
| D-003 | 命中敏感黑名单且 action 为读取或外发                         | deny | `AHA-SANDBOX-002`  |
| D-004 | `sensitivity='secret'` 且 `action='send_to_llm'`             | deny | `AHA-POLICY-001`   |
| D-005 | `actor='assistant'` 且 `action='install_extension'` 直接执行 | deny | `AHA-POLICY-001`   |
| D-006 | `extension` 未安装、未启用或签名无效                         | deny | `AHA-EXT-001`      |

## 5. 需审批动作规则

以下动作如果无有效审批，统一返回 `require_approval`：

- `diff_edit`
- `write_file`
- `delete_file`
- `run_command`
- `install_extension`
- `invoke_extension_tool`（当扩展声明高风险权限时）

说明：`browser_tool` 为编排层工具名，在策略层映射为只读动作 `browser_open`，默认不需要审批。

审批必须满足：

- `approvalScope.workspace` 覆盖当前资源。
- 未超过 `maxActions`。
- 当前时间早于 `expiresAt`。

运行模式补充：

- `interactive`：严格按上述审批规则执行。
- `autonomous`：在编排层可对 `write_file/delete_file/run_command` 做自动放行，但硬拒绝规则仍必须生效。

## 6. 允许规则矩阵

| actor     | action                                       | 条件                                       | 决策                   |
| --------- | -------------------------------------------- | ------------------------------------------ | ---------------------- |
| user      | read_file/list_dir/grep                      | 路径在工作区且不命中硬拒绝                 | allow                  |
| assistant | read_file/list_dir/grep                      | 同上                                       | allow                  |
| assistant | web_search/fetch_url/browser_open/extract_main_content | URL 通过安全校验且不命中硬拒绝     | allow                  |
| assistant | memory_search/memory_store                             | 内部工具，无外部副作用             | allow                  |
| assistant | send_to_llm                                  | 输入非 `secret`; `restricted` 已脱敏       | allow                  |
| assistant | diff_edit/write_file/delete_file/run_command | 有效审批存在且在 scope 内                  | allow                  |
| user      | install_extension                            | 来源可信 + 校验通过 + 用户确认权限         | allow                  |
| assistant | install_extension                            | 仅可 `propose_install_skill`，不可直接安装 | deny                   |
| extension | invoke_extension_tool                        | 扩展已启用 + 权限匹配 + 未越界             | allow                  |
| extension | read/write/run_command                       | 仅允许在声明权限与审批范围内               | allow/require_approval |

## 7. 扩展权限最小集合

### 7.1 权限枚举

- `fs.read`
- `fs.write`
- `exec.run`
- `net.outbound`
- `workspace.scoped:<path>`

### 7.2 默认策略

- 默认权限为空（`[]`）。
- 未声明权限的扩展只能执行纯计算型工具。
- 任何 `exec.run` 或 `net.outbound` 默认需要审批。

## 8. 命令执行白名单策略（V1）

### 8.1 允许的命令（建议默认）

- `npm test`
- `npm run build`
- `pnpm test`
- `pnpm build`
- `pytest`
- `go test ./...`

### 8.2 禁止命令（硬拒绝）

- 破坏性文件命令：`rm -rf /`, `sudo rm`, `dd`, `mkfs`
- 系统级高危命令：`chmod -R 777 /`, `chown -R /`
- 未经授权的网络下载执行链：`curl ... | sh`, `wget ... | bash`

## 9. 参考实现伪代码

```ts
function evaluate(input: PolicyInput): 'allow' | 'deny' | 'require_approval' {
  if (!input.context.sessionValid || !input.context.originValid) return 'deny';
  if (isPathEscaped(input.resource.path)) return 'deny';
  if (hitsSensitiveRule(input.resource, input.action)) return 'deny';
  if (input.action === 'send_to_llm' && input.resource.sensitivity === 'secret') return 'deny';
  if (input.actor === 'assistant' && input.action === 'install_extension') return 'deny';
  if (requiresApproval(input.action) && !hasValidApproval(input.context, input.resource)) {
    return 'require_approval';
  }
  if (matchesAllowRule(input)) return 'allow';
  return 'deny';
}
```

## 10. 测试断言（必须覆盖）

1.  assistant 对 `install_extension` 必须被拒绝。
2.  `secret` 数据不得进入 `send_to_llm`。
3.  审批过期后重复提交必须被拒绝。
4.  扩展越权访问工作区外路径必须拒绝。
5.  同一审批 nonce 二次提交必须拒绝。
