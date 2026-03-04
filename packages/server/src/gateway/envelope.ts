import { type WsEnvelope } from '@aha-agent/shared';

const MIN_ID_LENGTH = 8;

/**
 * Validate all fields of a WsEnvelope according to the protocol spec.
 *
 * Requirements:
 * - protocolVersion must be '1.0'
 * - sessionId, requestId, idempotencyKey must be strings with minLength 8
 * - type must be a non-empty string
 * - payload must be a non-null object
 */
export function validateEnvelope(data: unknown): data is WsEnvelope<Record<string, unknown>> {
  if (data === null || typeof data !== 'object') {
    return false;
  }

  const envelope = data as Record<string, unknown>;

  if (envelope.protocolVersion !== '1.0') {
    return false;
  }

  if (typeof envelope.sessionId !== 'string' || envelope.sessionId.length < MIN_ID_LENGTH) {
    return false;
  }

  if (typeof envelope.requestId !== 'string' || envelope.requestId.length < MIN_ID_LENGTH) {
    return false;
  }

  if (
    typeof envelope.idempotencyKey !== 'string' ||
    envelope.idempotencyKey.length < MIN_ID_LENGTH
  ) {
    return false;
  }

  if (typeof envelope.timestamp !== 'string' || envelope.timestamp.length === 0) {
    return false;
  }

  if (typeof envelope.type !== 'string' || envelope.type.length === 0) {
    return false;
  }

  if (envelope.payload === null || typeof envelope.payload !== 'object') {
    return false;
  }

  return true;
}

/**
 * Parse a raw WebSocket message string into a validated WsEnvelope.
 * Throws on invalid JSON or envelope validation failure.
 */
export function parseEnvelope(raw: string): WsEnvelope<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Invalid JSON');
  }

  if (!validateEnvelope(parsed)) {
    throw new Error('Invalid envelope');
  }

  return parsed;
}
