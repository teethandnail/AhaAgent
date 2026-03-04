export type Actor = 'user' | 'assistant' | 'extension';

export type PolicyAction =
  | 'read_file'
  | 'list_dir'
  | 'grep'
  | 'diff_edit'
  | 'write_file'
  | 'delete_file'
  | 'run_command'
  | 'install_extension'
  | 'invoke_extension_tool'
  | 'send_to_llm';

export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

export interface PolicyInput {
  actor: Actor;
  action: PolicyAction;
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

export interface PolicyResult {
  decision: PolicyDecision;
  errorCode?: string;
  reason?: string;
}
