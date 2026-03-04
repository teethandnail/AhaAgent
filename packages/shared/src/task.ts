import { type TaskState } from './protocol.js';

export interface TaskNode {
  id: string;
  parentId?: string;
  title: string;
  status: TaskState;
  errorCode?: string;
  errorMessage?: string;
  children?: TaskNode[];
}

export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  actionType:
    | 'write_file'
    | 'delete_file'
    | 'run_command'
    | 'install_extension';
  target: string;
  diffPreview?: string;
  riskLevel: 'medium' | 'high' | 'critical';
  nonce: string;
  expiresAt: string;
  scope: {
    workspace: string;
    maxActions: number;
    timeoutSec: number;
  };
}

export interface Checkpoint {
  checkpointId: string;
  taskId: string;
  stepId: string;
  llmContextRef: string;
  pendingApprovalId?: string;
  createdAt: string;
}
