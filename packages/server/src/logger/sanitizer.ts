/**
 * Redacts sensitive patterns from text to prevent secret leakage in logs.
 *
 * Handles:
 * - OpenAI-style API keys (sk-...)
 * - Bearer JWT tokens
 * - JSON fields named password, secret, token, apiKey, api_key
 * - PEM private keys
 */

const API_KEY_RE = /\bsk-[a-zA-Z0-9]{10,}\b/g;
const BEARER_RE = /\bBearer\s+eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g;
const JSON_FIELD_RE =
  /("(?:password|secret|token|apiKey|api_key)")\s*:\s*"[^"]*"/gi;
const PEM_RE =
  /-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g;

export function sanitize(text: string): string {
  let result = text;
  result = result.replace(PEM_RE, '[REDACTED]');
  result = result.replace(BEARER_RE, 'Bearer [REDACTED]');
  result = result.replace(API_KEY_RE, '[REDACTED]');
  result = result.replace(JSON_FIELD_RE, '$1: "[REDACTED]"');
  return result;
}
