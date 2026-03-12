import crypto from 'node:crypto';

import type {
  ApprovalRequest,
  ActionBlockedPayload,
  RiskLevel,
  ApprovalActionType,
  PermissionScope,
} from '@aha-agent/shared';

/** Internal entry that tracks consumption state alongside the approval data. */
interface ApprovalEntry {
  approval: ApprovalRequest;
  consumed: boolean;
}

/** Parameters required to create a new approval. */
export interface CreateApprovalParams {
  taskId: string;
  actionType: ApprovalActionType;
  target: string;
  diffPreview?: string;
  riskLevel: RiskLevel;
  scope: PermissionScope;
}

/** Result of validating an approval request. */
export type ValidateResult =
  | { valid: true; approval: ApprovalRequest }
  | { valid: false; error: string };

/** Expiry durations per risk level, in milliseconds. */
const EXPIRY_MS: Record<RiskLevel, number> = {
  medium: 5 * 60 * 1000,
  high: 3 * 60 * 1000,
  critical: 1 * 60 * 1000,
};

/**
 * Manages the full lifecycle of approval requests:
 * creation, validation (with timing-safe nonce comparison),
 * consumption, and cleanup.
 */
export class ApprovalManager {
  private readonly pending = new Map<string, ApprovalEntry>();

  /**
   * Create a new approval request.
   *
   * Generates a unique id and cryptographic nonce, computes the expiry
   * based on the risk level, and stores the approval internally.
   */
  createApproval(params: CreateApprovalParams): ApprovalRequest {
    const approvalId = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + EXPIRY_MS[params.riskLevel]).toISOString();

    const approval: ApprovalRequest = {
      approvalId,
      taskId: params.taskId,
      actionType: params.actionType,
      target: params.target,
      diffPreview: params.diffPreview,
      riskLevel: params.riskLevel,
      nonce,
      expiresAt,
      scope: { ...params.scope },
    };

    this.pending.set(approvalId, { approval, consumed: false });
    return approval;
  }

  /**
   * Restore a previously persisted approval back into the active pending map.
   */
  restoreApproval(approval: ApprovalRequest): void {
    this.pending.set(approval.approvalId, {
      approval,
      consumed: false,
    });
  }

  /**
   * Validate an approval by id and nonce.
   *
   * Checks existence, nonce match (timing-safe), expiry, consumption state,
   * and scope validity. On success the approval is marked as consumed.
   */
  validateApproval(approvalId: string, nonce: string): ValidateResult {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return { valid: false, error: 'Approval not found' };
    }

    // Timing-safe nonce comparison
    const expectedBuf = Buffer.from(entry.approval.nonce, 'utf8');
    const actualBuf = Buffer.from(nonce, 'utf8');

    if (expectedBuf.length !== actualBuf.length) {
      return { valid: false, error: 'Invalid nonce' };
    }

    if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return { valid: false, error: 'Invalid nonce' };
    }

    // Check expiry
    if (new Date(entry.approval.expiresAt).getTime() <= Date.now()) {
      return { valid: false, error: 'Approval expired' };
    }

    // Check already consumed (nonce replay prevention)
    if (entry.consumed) {
      return { valid: false, error: 'Approval already used' };
    }

    // Scope validation
    const scopeError = this.validateScope(entry.approval.scope);
    if (scopeError) {
      return { valid: false, error: scopeError };
    }

    // Mark as consumed
    entry.consumed = true;

    return { valid: true, approval: entry.approval };
  }

  /**
   * Consume an approval so it cannot be reused, then remove it from the map.
   */
  consumeApproval(approvalId: string): void {
    const entry = this.pending.get(approvalId);
    if (entry) {
      entry.consumed = true;
      this.pending.delete(approvalId);
    }
  }

  /**
   * Return the active (not consumed, not expired) approval for a given task.
   */
  getActiveApproval(taskId: string): ApprovalRequest | null {
    const now = Date.now();
    for (const entry of this.pending.values()) {
      if (
        entry.approval.taskId === taskId &&
        !entry.consumed &&
        new Date(entry.approval.expiresAt).getTime() > now
      ) {
        return entry.approval;
      }
    }
    return null;
  }

  /**
   * Remove all expired approvals from the internal map.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending.entries()) {
      if (new Date(entry.approval.expiresAt).getTime() <= now) {
        this.pending.delete(id);
      }
    }
  }

  /**
   * Convert an ApprovalRequest to the ActionBlockedPayload protocol format.
   */
  toBlockedPayload(approval: ApprovalRequest): ActionBlockedPayload {
    return {
      taskId: approval.taskId,
      approvalId: approval.approvalId,
      approvalNonce: approval.nonce,
      expiresAt: approval.expiresAt,
      riskLevel: approval.riskLevel,
      actionType: approval.actionType,
      target: approval.target,
      diffPreview: approval.diffPreview,
      permissionScope: {
        workspace: approval.scope.workspace,
        maxActions: approval.scope.maxActions,
        timeoutSec: approval.scope.timeoutSec,
      },
    };
  }

  /**
   * Validate scope constraints. Returns an error string or undefined if valid.
   */
  private validateScope(scope: PermissionScope): string | undefined {
    if (!scope.workspace || scope.workspace.trim() === '') {
      return 'Invalid scope: workspace must be non-empty';
    }
    if (scope.maxActions <= 0) {
      return 'Invalid scope: maxActions must be greater than 0';
    }
    if (scope.timeoutSec <= 0 || scope.timeoutSec > 3600) {
      return 'Invalid scope: timeoutSec must be between 1 and 3600';
    }
    return undefined;
  }
}
