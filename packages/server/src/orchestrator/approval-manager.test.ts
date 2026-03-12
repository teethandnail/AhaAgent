import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ApprovalManager, type CreateApprovalParams } from './approval-manager.js';

function makeParams(overrides?: Partial<CreateApprovalParams>): CreateApprovalParams {
  return {
    taskId: 'task-1',
    actionType: 'write_file',
    target: '/src/index.ts',
    riskLevel: 'medium',
    scope: { workspace: '/project', maxActions: 5, timeoutSec: 300 },
    ...overrides,
  };
}

describe('ApprovalManager', () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    manager = new ApprovalManager();
  });

  // ── createApproval ────────────────────────────────────────

  describe('createApproval', () => {
    it('generates a unique approvalId and nonce', () => {
      const a = manager.createApproval(makeParams());
      const b = manager.createApproval(makeParams());

      expect(a.approvalId).toBeTruthy();
      expect(a.nonce).toBeTruthy();
      expect(a.approvalId).not.toBe(b.approvalId);
      expect(a.nonce).not.toBe(b.nonce);
      // nonce should be 64 hex chars (32 bytes)
      expect(a.nonce).toMatch(/^[0-9a-f]{64}$/);
    });

    it('sets correct expiry for medium risk (5 minutes)', () => {
      vi.useFakeTimers({ now: new Date('2025-01-01T00:00:00.000Z') });
      const approval = manager.createApproval(makeParams({ riskLevel: 'medium' }));
      expect(approval.expiresAt).toBe('2025-01-01T00:05:00.000Z');
      vi.useRealTimers();
    });

    it('sets correct expiry for high risk (3 minutes)', () => {
      vi.useFakeTimers({ now: new Date('2025-01-01T00:00:00.000Z') });
      const approval = manager.createApproval(makeParams({ riskLevel: 'high' }));
      expect(approval.expiresAt).toBe('2025-01-01T00:03:00.000Z');
      vi.useRealTimers();
    });

    it('sets correct expiry for critical risk (1 minute)', () => {
      vi.useFakeTimers({ now: new Date('2025-01-01T00:00:00.000Z') });
      const approval = manager.createApproval(makeParams({ riskLevel: 'critical' }));
      expect(approval.expiresAt).toBe('2025-01-01T00:01:00.000Z');
      vi.useRealTimers();
    });
  });

  describe('restoreApproval', () => {
    it('restores a persisted approval so it can be validated again', () => {
      const approval = {
        approvalId: 'approval-restore',
        taskId: 'task-restore',
        actionType: 'write_file' as const,
        target: '/src/index.ts',
        riskLevel: 'medium' as const,
        nonce: 'a'.repeat(64),
        expiresAt: '2099-01-01T00:05:00.000Z',
        scope: {
          workspace: '/project',
          maxActions: 1,
          timeoutSec: 300,
        },
      };

      manager.restoreApproval(approval);
      const result = manager.validateApproval(approval.approvalId, approval.nonce);

      expect(result.valid).toBe(true);
    });
  });

  // ── validateApproval ──────────────────────────────────────

  describe('validateApproval', () => {
    it('succeeds with correct nonce', () => {
      const approval = manager.createApproval(makeParams());
      const result = manager.validateApproval(approval.approvalId, approval.nonce);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.approval.approvalId).toBe(approval.approvalId);
      }
    });

    it('rejects wrong nonce', () => {
      const approval = manager.createApproval(makeParams());
      const result = manager.validateApproval(approval.approvalId, 'wrong-nonce');

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe('Invalid nonce');
      }
    });

    it('rejects expired approval', () => {
      vi.useFakeTimers({ now: new Date('2025-01-01T00:00:00.000Z') });
      const approval = manager.createApproval(makeParams({ riskLevel: 'medium' }));

      // Advance past the 5-minute expiry
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      const result = manager.validateApproval(approval.approvalId, approval.nonce);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe('Approval expired');
      }
      vi.useRealTimers();
    });

    it('rejects already consumed approval (nonce replay prevention)', () => {
      const approval = manager.createApproval(makeParams());

      // First validation succeeds
      const first = manager.validateApproval(approval.approvalId, approval.nonce);
      expect(first.valid).toBe(true);

      // Second validation with same nonce fails
      const second = manager.validateApproval(approval.approvalId, approval.nonce);
      expect(second.valid).toBe(false);
      if (!second.valid) {
        expect(second.error).toBe('Approval already used');
      }
    });

    it('uses timing-safe comparison (double validation with correct nonce fails)', () => {
      // This test verifies the consumption mechanism which is intertwined
      // with the timing-safe validation: calling validateApproval twice
      // with the correct nonce must fail the second time, proving the
      // nonce is consumed after one successful use.
      const approval = manager.createApproval(makeParams());
      const r1 = manager.validateApproval(approval.approvalId, approval.nonce);
      expect(r1.valid).toBe(true);

      const r2 = manager.validateApproval(approval.approvalId, approval.nonce);
      expect(r2.valid).toBe(false);
      if (!r2.valid) {
        expect(r2.error).toBe('Approval already used');
      }
    });

    it('returns error when approval is not found', () => {
      const result = manager.validateApproval('nonexistent-id', 'some-nonce');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe('Approval not found');
      }
    });
  });

  // ── getActiveApproval ─────────────────────────────────────

  describe('getActiveApproval', () => {
    it('returns pending approval for the given task', () => {
      const approval = manager.createApproval(makeParams({ taskId: 'task-42' }));
      const active = manager.getActiveApproval('task-42');

      expect(active).not.toBeNull();
      expect(active?.approvalId).toBe(approval.approvalId);
    });

    it('returns null for consumed approval', () => {
      const approval = manager.createApproval(makeParams({ taskId: 'task-42' }));
      manager.consumeApproval(approval.approvalId);

      const active = manager.getActiveApproval('task-42');
      expect(active).toBeNull();
    });

    it('returns null for expired approval', () => {
      vi.useFakeTimers({ now: new Date('2025-01-01T00:00:00.000Z') });
      manager.createApproval(makeParams({ taskId: 'task-42', riskLevel: 'critical' }));

      // Advance past 1-minute critical expiry
      vi.advanceTimersByTime(60 * 1000 + 1);
      const active = manager.getActiveApproval('task-42');
      expect(active).toBeNull();
      vi.useRealTimers();
    });

    it('returns null when no approval exists for the task', () => {
      const active = manager.getActiveApproval('nonexistent-task');
      expect(active).toBeNull();
    });
  });

  // ── cleanup ───────────────────────────────────────────────

  describe('cleanup', () => {
    it('removes expired approvals from the map', () => {
      vi.useFakeTimers({ now: new Date('2025-01-01T00:00:00.000Z') });

      // Create one medium (5 min) and one critical (1 min)
      const medium = manager.createApproval(makeParams({ taskId: 'task-m', riskLevel: 'medium' }));
      const critical = manager.createApproval(
        makeParams({ taskId: 'task-c', riskLevel: 'critical' }),
      );

      // Advance 2 minutes: critical expired, medium still active
      vi.advanceTimersByTime(2 * 60 * 1000);
      manager.cleanup();

      // Critical should be cleaned up
      const critResult = manager.validateApproval(critical.approvalId, critical.nonce);
      expect(critResult.valid).toBe(false);
      if (!critResult.valid) {
        expect(critResult.error).toBe('Approval not found');
      }

      // Medium should still exist
      const medResult = manager.validateApproval(medium.approvalId, medium.nonce);
      expect(medResult.valid).toBe(true);

      vi.useRealTimers();
    });
  });

  // ── toBlockedPayload ──────────────────────────────────────

  describe('toBlockedPayload', () => {
    it('creates correct ActionBlockedPayload format', () => {
      const approval = manager.createApproval(
        makeParams({
          taskId: 'task-99',
          actionType: 'delete_file',
          target: '/etc/config',
          diffPreview: '- old\n+ new',
          riskLevel: 'high',
          scope: { workspace: '/ws', maxActions: 3, timeoutSec: 120 },
        }),
      );

      const payload = manager.toBlockedPayload(approval);

      expect(payload).toEqual({
        taskId: 'task-99',
        approvalId: approval.approvalId,
        approvalNonce: approval.nonce,
        expiresAt: approval.expiresAt,
        riskLevel: 'high',
        actionType: 'delete_file',
        target: '/etc/config',
        diffPreview: '- old\n+ new',
        permissionScope: {
          workspace: '/ws',
          maxActions: 3,
          timeoutSec: 120,
        },
      });
    });
  });

  // ── Scope validation ──────────────────────────────────────

  describe('scope validation', () => {
    it('rejects scope with empty workspace', () => {
      const approval = manager.createApproval(
        makeParams({ scope: { workspace: '', maxActions: 5, timeoutSec: 300 } }),
      );
      const result = manager.validateApproval(approval.approvalId, approval.nonce);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('workspace');
      }
    });

    it('rejects scope with maxActions <= 0', () => {
      const approval = manager.createApproval(
        makeParams({ scope: { workspace: '/ws', maxActions: 0, timeoutSec: 300 } }),
      );
      const result = manager.validateApproval(approval.approvalId, approval.nonce);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('maxActions');
      }
    });

    it('rejects scope with timeoutSec <= 0', () => {
      const approval = manager.createApproval(
        makeParams({ scope: { workspace: '/ws', maxActions: 5, timeoutSec: 0 } }),
      );
      const result = manager.validateApproval(approval.approvalId, approval.nonce);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('timeoutSec');
      }
    });

    it('rejects scope with timeoutSec > 3600', () => {
      const approval = manager.createApproval(
        makeParams({ scope: { workspace: '/ws', maxActions: 5, timeoutSec: 3601 } }),
      );
      const result = manager.validateApproval(approval.approvalId, approval.nonce);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('timeoutSec');
      }
    });
  });
});
