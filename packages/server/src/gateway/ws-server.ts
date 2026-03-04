import http from 'node:http';
import { type WsEnvelope, ServerEvents, createError } from '@aha-agent/shared';
import { WebSocketServer, type WebSocket } from 'ws';

import { generateSessionToken, validateOrigin, validateSessionToken } from './auth.js';
import { parseEnvelope } from './envelope.js';
import { IdempotencyStore } from './idempotency.js';

export interface GatewayOptions {
  port: number;
  /** Allowed origin port (for Origin header validation). Defaults to `port`. */
  originPort?: number;
  /** TTL for idempotency keys in milliseconds. Default: 5 minutes. */
  idempotencyTtlMs?: number;
  /** Called when a valid, non-duplicate envelope is received. */
  onMessage?: (ws: WebSocket, envelope: WsEnvelope<Record<string, unknown>>) => void;
}

export interface Gateway {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  sessionToken: string;
  broadcast: (data: string) => void;
  clientCount: () => number;
}

/**
 * Create an HTTP + WebSocket gateway server.
 *
 * - HTTP GET / returns `{ status: 'ok', token: sessionToken }`
 * - WS connections require Origin validation and sessionToken in query param
 * - Messages are parsed through envelope validation
 * - Duplicate idempotencyKeys are silently ignored
 */
export function createGateway(options: GatewayOptions): Gateway {
  const { port, idempotencyTtlMs } = options;
  const originPort = options.originPort ?? port;
  const sessionToken = generateSessionToken();
  const idempotencyStore = new IdempotencyStore(idempotencyTtlMs);
  idempotencyStore.startAutoCleanup();

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', token: sessionToken }));
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    // Validate Origin
    const origin = req.headers.origin;
    if (!validateOrigin(origin, originPort)) {
      sendError(ws, '', 'AUTH_ORIGIN_INVALID');
      ws.close(4403, 'Origin not allowed');
      return;
    }

    // Validate session token from query parameter
    const url = new URL(req.url ?? '/', `http://localhost:${String(port)}`);
    const token = url.searchParams.get('token') ?? '';
    if (!validateSessionToken(sessionToken, token)) {
      sendError(ws, '', 'AUTH_TOKEN_INVALID');
      ws.close(4401, 'Invalid session token');
      return;
    }

    // Handle incoming messages
    ws.on('message', (raw: Buffer | string) => {
      const rawStr = typeof raw === 'string' ? raw : raw.toString('utf8');

      let envelope: WsEnvelope<Record<string, unknown>>;
      try {
        envelope = parseEnvelope(rawStr);
      } catch {
        sendError(ws, '', 'SYS_UNKNOWN', 'Malformed message envelope');
        return;
      }

      // Idempotency dedup: silently ignore duplicates
      if (idempotencyStore.isDuplicate(envelope.idempotencyKey)) {
        return;
      }

      // Dispatch to handler
      options.onMessage?.(ws, envelope);
    });
  });

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.listen(port, () => {
        resolve();
      });
      server.on('error', reject);
    });

  const stop = (): Promise<void> =>
    new Promise((resolve, reject) => {
      idempotencyStore.clear();

      // Close all WebSocket connections
      for (const client of wss.clients) {
        client.close(1001, 'Server shutting down');
      }

      wss.close((wssErr) => {
        if (wssErr) {
          reject(wssErr);
          return;
        }
        server.close((httpErr) => {
          if (httpErr) {
            reject(httpErr);
            return;
          }
          resolve();
        });
      });
    });

  const broadcast = (data: string): void => {
    for (const client of wss.clients) {
      client.send(data);
    }
  };

  const clientCount = (): number => wss.clients.size;

  return { start, stop, sessionToken, broadcast, clientCount };
}

function sendError(
  ws: WebSocket,
  requestId: string,
  errorKey: 'AUTH_TOKEN_INVALID' | 'AUTH_ORIGIN_INVALID' | 'SYS_UNKNOWN',
  details?: string,
): void {
  const err = createError(errorKey, details);
  const payload = {
    requestId,
    errorCode: err.code,
    message: err.message,
    retryable: err.retryable,
  };
  const envelope = {
    protocolVersion: '1.0' as const,
    sessionId: '',
    requestId,
    idempotencyKey: requestId || crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: ServerEvents.ERROR,
    payload,
  };
  ws.send(JSON.stringify(envelope));
}
