import { useState, useEffect } from 'react';
import { useWebSocketStore } from '@/stores/websocket';
import { cn } from '@/lib/utils';

const riskColors: Record<string, string> = {
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
};

export function ApprovalDialog() {
  const { pendingApproval, approve } = useWebSocketStore();
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    if (!pendingApproval) return;

    const updateTimer = () => {
      const expires = new Date(pendingApproval.expiresAt).getTime();
      const now = Date.now();
      const diff = Math.max(0, expires - now);
      const seconds = Math.ceil(diff / 1000);
      setTimeLeft(`${seconds}s`);

      if (diff <= 0) {
        approve(pendingApproval.approvalId, pendingApproval.approvalNonce, 'reject');
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [pendingApproval, approve]);

  if (!pendingApproval) return null;

  const riskClass = riskColors[pendingApproval.riskLevel] ?? riskColors['medium'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Dialog */}
      <div
        className="relative z-10 w-full max-w-lg rounded-lg shadow-lg p-6 mx-4"
        style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}
      >
        <h2 className="text-lg font-semibold mb-4">Action Requires Approval</h2>

        <div className="space-y-3 mb-6">
          {/* Action type */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Action</span>
            <span className="text-sm font-mono">{pendingApproval.actionType}</span>
          </div>

          {/* Target */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Target</span>
            <span className="text-sm font-mono truncate max-w-[300px]">{pendingApproval.target}</span>
          </div>

          {/* Risk level */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Risk Level</span>
            <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', riskClass)}>
              {pendingApproval.riskLevel.toUpperCase()}
            </span>
          </div>

          {/* Expiry */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Expires In</span>
            <span className="text-sm font-mono text-red-600">{timeLeft}</span>
          </div>

          {/* Diff preview */}
          {pendingApproval.diffPreview && (
            <div>
              <span className="text-sm font-medium block mb-1">Diff Preview</span>
              <pre
                className="text-xs font-mono p-3 rounded-md overflow-x-auto max-h-48 overflow-y-auto"
                style={{ backgroundColor: 'var(--muted)' }}
              >
                {pendingApproval.diffPreview}
              </pre>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3 justify-end">
          <button
            onClick={() => approve(pendingApproval.approvalId, pendingApproval.approvalNonce, 'reject')}
            className="rounded-md px-4 py-2 text-sm font-medium border transition-colors hover:opacity-80"
            style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}
          >
            Reject
          </button>
          <button
            onClick={() => approve(pendingApproval.approvalId, pendingApproval.approvalNonce, 'approve')}
            className="rounded-md px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
            style={{ backgroundColor: 'var(--destructive)' }}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
