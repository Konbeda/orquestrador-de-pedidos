import { createHash } from 'node:crypto';

export type RejectionKind =
  'INVALID_PAYLOAD' | 'MALFORMED_JSON' | 'PAYLOAD_TOO_LARGE';

export interface RejectionInput {
  requestId: string;
  receivedAt: Date;
  /** Who sent it (client IP: the webhook has no authentication yet). */
  source: string;
  userAgent: string | null;
  kind: RejectionKind;
  /** Exact bytes received, when the body was read. */
  rawBody?: Buffer;
  /** The JSON, when it parsed. */
  parsedBody?: unknown;
  /** Content-Length, for a body refused before being read. */
  declaredSize?: number;
  errors: Array<{ field: string; message: string; constraint?: string }>;
}

/** Stored in webhook_rejections: enough to explain a 400, as little personal data as possible. */
export interface RejectionRecord {
  request_id: string;
  received_at: Date;
  source: string;
  user_agent: string | null;
  kind: RejectionKind;
  errors: Array<{ field: string; message: string }>;
  /** `field:rule` without item indexes (items.qty:isPositive), for grouping in analytics. */
  error_codes: string[];
  /** Contract fields only, email and name masked; null when the body never parsed. */
  payload: Record<string, unknown> | null;
  /** Names of fields outside the contract. Their values are never stored. */
  unknown_fields: string[];
  /** SHA-256 of the exact bytes: proves what was sent without keeping it. */
  payload_hash: string | null;
  payload_size: number | null;
}

/** u***@example.com: the client recognizes it, we do not keep it. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 0) return `${email.slice(0, 1)}***`;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** Ana Maria Souza → A*** M*** S*** */
export function maskName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length ? words.map((word) => `${word[0]}***`).join(' ') : '***';
}

const CONTRACT = {
  top: new Set([
    'order_id',
    'customer',
    'items',
    'currency',
    'idempotency_key',
  ]),
  item: new Set(['sku', 'qty', 'unit_price']),
};

const BODY_CODES: Partial<Record<RejectionKind, string>> = {
  MALFORMED_JSON: 'body:malformedJson',
  PAYLOAD_TOO_LARGE: 'body:tooLarge',
};

export function buildRejectionRecord(input: RejectionInput): RejectionRecord {
  const { payload, unknownFields } =
    input.kind === 'INVALID_PAYLOAD'
      ? project(input.parsedBody)
      : { payload: null, unknownFields: [] };

  return {
    request_id: input.requestId,
    received_at: input.receivedAt,
    source: input.source,
    user_agent: input.userAgent,
    kind: input.kind,
    errors: input.errors.map(({ field, message }) => ({ field, message })),
    error_codes: errorCodes(input),
    payload,
    unknown_fields: unknownFields,
    payload_hash: input.rawBody
      ? createHash('sha256').update(input.rawBody).digest('hex')
      : null,
    payload_size: input.rawBody?.length ?? input.declaredSize ?? null,
  };
}

function errorCodes(input: RejectionInput): string[] {
  const bodyCode = BODY_CODES[input.kind];
  if (bodyCode) return [bodyCode];
  const codes = input.errors
    .filter((error) => error.constraint)
    .map(
      (error) =>
        `${error.field.replace(/\.\d+(?=\.|$)/g, '')}:${error.constraint}`,
    );
  return [...new Set(codes)];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const typeTag = (value: unknown) =>
  `[redacted: ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}]`;

/**
 * Allowlist: keeps contract fields (values as sent, since a wrong type is often
 * the reason for the 400), masks customer data, and reduces everything else to
 * its field name.
 */
function project(body: unknown): {
  payload: Record<string, unknown> | null;
  unknownFields: string[];
} {
  if (!isObject(body)) return { payload: null, unknownFields: [] };
  const unknown = new Set<string>();
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (!CONTRACT.top.has(key)) {
      unknown.add(key);
    } else if (key === 'customer') {
      payload.customer = isObject(value)
        ? maskCustomer(value, unknown)
        : typeTag(value);
    } else if (key === 'items' && Array.isArray(value)) {
      payload.items = value.map((item) =>
        isObject(item) ? pickItem(item, unknown) : item,
      );
    } else {
      payload[key] = value;
    }
  }
  return { payload, unknownFields: [...unknown].sort() };
}

function maskCustomer(customer: Record<string, unknown>, unknown: Set<string>) {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(customer)) {
    if (key === 'email')
      masked.email =
        typeof value === 'string' ? maskEmail(value) : typeTag(value);
    else if (key === 'name')
      masked.name =
        typeof value === 'string' ? maskName(value) : typeTag(value);
    else unknown.add(`customer.${key}`);
  }
  return masked;
}

function pickItem(item: Record<string, unknown>, unknown: Set<string>) {
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (CONTRACT.item.has(key)) picked[key] = value;
    else unknown.add(`items.${key}`);
  }
  return picked;
}
