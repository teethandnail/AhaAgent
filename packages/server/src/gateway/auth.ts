import crypto from 'node:crypto';

/**
 * Generate a cryptographically random session token (64 hex characters).
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate a session token using timing-safe comparison.
 * Rejects empty strings and mismatched tokens.
 */
export function validateSessionToken(expected: string, actual: string): boolean {
  if (!expected || !actual) {
    return false;
  }

  // Both must be same byte-length for timingSafeEqual
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Validate that the request origin is a localhost address on the expected port.
 * Only `http://localhost:<port>` and `http://127.0.0.1:<port>` are accepted.
 */
export function validateOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) {
    return false;
  }

  const allowed = [`http://localhost:${String(port)}`, `http://127.0.0.1:${String(port)}`];
  return allowed.includes(origin);
}
