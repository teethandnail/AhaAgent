export interface AhaError {
  code: string;
  message: string;
  retryable: boolean;
}

export const ErrorCodes = {
  AUTH_TOKEN_INVALID: {
    code: 'AHA-AUTH-001',
    message: 'Session token missing or invalid',
    retryable: false,
  },
  AUTH_ORIGIN_INVALID: {
    code: 'AHA-AUTH-002',
    message: 'Origin/Host validation failed',
    retryable: false,
  },
  POLICY_DENIED: {
    code: 'AHA-POLICY-001',
    message: 'Action denied by policy',
    retryable: false,
  },
  POLICY_APPROVAL_REQUIRED: {
    code: 'AHA-POLICY-002',
    message: 'Action requires approval',
    retryable: false,
  },
  SANDBOX_PATH_ESCAPE: {
    code: 'AHA-SANDBOX-001',
    message: 'Path escapes workspace boundary',
    retryable: false,
  },
  SANDBOX_SENSITIVE_FILE: {
    code: 'AHA-SANDBOX-002',
    message: 'Access to sensitive file denied',
    retryable: false,
  },
  TOOL_INVALID_PARAMS: {
    code: 'AHA-TOOL-001',
    message: 'Tool parameters invalid',
    retryable: false,
  },
  TOOL_VERSION_CONFLICT: {
    code: 'AHA-TOOL-002',
    message: 'File version conflict',
    retryable: true,
  },
  TASK_NOT_FOUND: {
    code: 'AHA-TASK-001',
    message: 'Task not found or already terminated',
    retryable: false,
  },
  TASK_LOCK_CONFLICT: {
    code: 'AHA-TASK-002',
    message: 'Resource lock conflict',
    retryable: true,
  },
  EXT_VERIFY_FAILED: {
    code: 'AHA-EXT-001',
    message: 'Extension signature/checksum verification failed',
    retryable: false,
  },
  EXT_RUNTIME_CRASH: {
    code: 'AHA-EXT-002',
    message: 'Extension runtime crashed',
    retryable: true,
  },
  LLM_REQUEST_FAILED: {
    code: 'AHA-LLM-001',
    message: 'Upstream model request failed',
    retryable: true,
  },
  SYS_UNKNOWN: {
    code: 'AHA-SYS-001',
    message: 'Unknown system error',
    retryable: true,
  },
} as const;

export type ErrorCodeKey = keyof typeof ErrorCodes;

export function createError(key: ErrorCodeKey, details?: string): AhaError {
  const base = ErrorCodes[key];
  return {
    code: base.code,
    message: details ? `${base.message}: ${details}` : base.message,
    retryable: base.retryable,
  };
}
