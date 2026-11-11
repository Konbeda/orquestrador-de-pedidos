import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * One id per request: the caller's x-request-id when it sends one (so both sides
 * correlate), a generated one otherwise. Echoed in the response header and in
 * every log line and error body.
 */
export function assignRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const existing = (req as { id?: unknown }).id;
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' &&
    incoming.length > 0 &&
    incoming.length <= 128
      ? incoming
      : `req_${randomUUID()}`;
  (req as { id?: string }).id = id;
  if (!res.headersSent) res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

export function requestIdOf(req: IncomingMessage): string {
  return (req as { id?: string }).id ?? 'unknown';
}
