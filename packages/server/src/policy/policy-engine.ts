import { type PolicyAction, type PolicyInput, type PolicyResult } from '@aha-agent/shared';
import { isPathInWorkspace, hasPathTraversal } from './path-rules.js';
import { isSensitivePath } from './sensitive-rules.js';
import { isCommandBlocked } from './command-rules.js';

/** Actions that always require explicit user approval. */
const APPROVAL_REQUIRED_ACTIONS: ReadonlySet<PolicyAction> = new Set([
  'diff_edit',
  'write_file',
  'delete_file',
  'run_command',
  'install_extension',
]);

/** Read-only actions that are allowed inside a valid workspace. */
const READ_ACTIONS: ReadonlySet<PolicyAction> = new Set([
  'read_file',
  'list_dir',
  'grep',
  'web_search',
  'fetch_url',
  'browser_open',
  'extract_main_content',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deny(errorCode: string, reason: string): PolicyResult {
  return { decision: 'deny', errorCode, reason };
}

function requireApproval(errorCode: string, reason: string): PolicyResult {
  return { decision: 'require_approval', errorCode, reason };
}

function allow(): PolicyResult {
  return { decision: 'allow' };
}

/**
 * Determine whether the current approval scope covers the given resource and
 * has not expired.
 */
function hasValidApproval(input: PolicyInput): boolean {
  const { hasUserApproval, approvalScope } = input.context;
  if (!hasUserApproval || !approvalScope) return false;

  // Check expiry
  const now = new Date();
  const expiresAt = new Date(approvalScope.expiresAt);
  if (now >= expiresAt) return false;

  // Check that the approval workspace covers the resource path
  const resourcePath = input.resource.path;
  if (resourcePath) {
    if (!isPathInWorkspace(resourcePath, approvalScope.workspace)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate a policy decision for a given input.
 *
 * Decision priority (high -> low):
 *   1. Hard deny rules (D-001 .. D-006)
 *   2. Approval required check
 *   3. Allow rules
 *   4. Default deny
 */
export function evaluate(input: PolicyInput): PolicyResult {
  // -----------------------------------------------------------------------
  // D-001: Session / Origin validation
  // -----------------------------------------------------------------------
  if (input.context.sessionValid === false) {
    return deny('AHA-AUTH-001', 'Session token missing or invalid');
  }
  if (input.context.originValid === false) {
    return deny('AHA-AUTH-002', 'Origin/Host validation failed');
  }

  // -----------------------------------------------------------------------
  // D-002: Path must be inside allowed workspace
  // -----------------------------------------------------------------------
  const resourcePath = input.resource.path;
  const workspace = input.resource.workspace;

  if (resourcePath) {
    if (hasPathTraversal(resourcePath)) {
      return deny('AHA-SANDBOX-001', 'Path contains traversal sequences');
    }
    if (workspace && !isPathInWorkspace(resourcePath, workspace)) {
      return deny('AHA-SANDBOX-001', 'Path escapes workspace boundary');
    }
  }

  // -----------------------------------------------------------------------
  // D-003: Sensitive file + read / send_to_llm
  // -----------------------------------------------------------------------
  if (
    resourcePath &&
    isSensitivePath(resourcePath) &&
    (READ_ACTIONS.has(input.action) || input.action === 'send_to_llm')
  ) {
    return deny('AHA-SANDBOX-002', 'Access to sensitive file denied');
  }

  // -----------------------------------------------------------------------
  // D-004: secret data must never reach send_to_llm
  // -----------------------------------------------------------------------
  if (input.resource.sensitivity === 'secret' && input.action === 'send_to_llm') {
    return deny('AHA-POLICY-001', 'Secret data cannot be sent to LLM');
  }

  // -----------------------------------------------------------------------
  // D-005: assistant cannot directly install extensions
  // -----------------------------------------------------------------------
  if (input.actor === 'assistant' && input.action === 'install_extension') {
    return deny('AHA-POLICY-001', 'Assistant cannot directly install extensions');
  }

  // -----------------------------------------------------------------------
  // D-006: Blocked command
  // -----------------------------------------------------------------------
  if (input.action === 'run_command' && input.resource.command) {
    if (isCommandBlocked(input.resource.command)) {
      return deny('AHA-POLICY-001', 'Command is blocked by policy');
    }
  }

  // -----------------------------------------------------------------------
  // Approval check
  // -----------------------------------------------------------------------
  if (APPROVAL_REQUIRED_ACTIONS.has(input.action)) {
    if (!hasValidApproval(input)) {
      return requireApproval('AHA-POLICY-002', 'Action requires user approval');
    }
    // Valid approval exists -- fall through to allow rules
  }

  // -----------------------------------------------------------------------
  // Allow rules
  // -----------------------------------------------------------------------

  // Read-only operations in workspace
  if (READ_ACTIONS.has(input.action)) {
    return allow();
  }

  // send_to_llm with non-secret data
  if (input.action === 'send_to_llm' && input.resource.sensitivity !== 'secret') {
    return allow();
  }

  // Approved mutating actions
  if (APPROVAL_REQUIRED_ACTIONS.has(input.action) && hasValidApproval(input)) {
    return allow();
  }

  // -----------------------------------------------------------------------
  // Default deny
  // -----------------------------------------------------------------------
  return deny('AHA-POLICY-001', 'Action denied by default policy');
}
