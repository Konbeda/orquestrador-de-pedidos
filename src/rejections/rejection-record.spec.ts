import { createHash } from 'node:crypto';
import {
  buildRejectionRecord,
  maskEmail,
  maskName,
} from './rejection-record.js';

const sha256 = (data: string) =>
  createHash('sha256').update(data).digest('hex');

describe('masking', () => {
  it.each([
    ['user@example.com', 'u***@example.com'],
    ['a@b.co', 'a***@b.co'],
    ['no-at-sign', 'n***'],
    ['', '***'],
  ])('maskEmail(%s) → %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });

  it.each([
    ['Ana', 'A***'],
    ['Ana Maria Souza', 'A*** M*** S***'],
    ['  ', '***'],
  ])('maskName(%s) → %s', (input, expected) => {
    expect(maskName(input)).toBe(expected);
  });
});

describe('buildRejectionRecord', () => {
  const base = {
    requestId: 'req_1',
    receivedAt: new Date('2026-11-11T10:00:00.000Z'),
    source: '10.0.0.7',
    userAgent: 'partner-webhooks/2.1',
  };

  const body = {
    order_id: 'ext-1',
    customer: {
      email: 'user@example.com',
      name: 'Ana Souza',
      phone: '+55 11 99999-0000',
    },
    items: [{ sku: 'ABC', qty: 0, unit_price: 10, color: 'blue' }],
    currency: 'dolar',
    idempotency_key: 'key-1',
    notes: 'CPF 123.456.789-00',
  };
  const raw = Buffer.from(JSON.stringify(body));

  const invalidPayload = () =>
    buildRejectionRecord({
      ...base,
      kind: 'INVALID_PAYLOAD',
      rawBody: raw,
      parsedBody: body,
      errors: [
        {
          field: 'items.0.qty',
          message: 'qty must be positive',
          constraint: 'isPositive',
        },
        {
          field: 'currency',
          message: 'bad',
          constraint: 'isISO4217CurrencyCode',
        },
      ],
    });

  it('keeps the request metadata and the errors as answered to the client', () => {
    expect(invalidPayload()).toMatchObject({
      request_id: 'req_1',
      received_at: base.receivedAt,
      source: '10.0.0.7',
      user_agent: 'partner-webhooks/2.1',
      kind: 'INVALID_PAYLOAD',
      errors: [
        { field: 'items.0.qty', message: 'qty must be positive' },
        { field: 'currency', message: 'bad' },
      ],
    });
  });

  it('normalizes error codes as field:rule, without item indexes, for grouping', () => {
    expect(invalidPayload().error_codes).toEqual([
      'items.qty:isPositive',
      'currency:isISO4217CurrencyCode',
    ]);
  });

  it('hashes the exact bytes received (proves the content without storing it raw)', () => {
    expect(invalidPayload().payload_hash).toBe(sha256(JSON.stringify(body)));
    expect(invalidPayload().payload_size).toBe(raw.length);
  });

  it('stores only contract fields, with email and name masked', () => {
    expect(invalidPayload().payload).toEqual({
      order_id: 'ext-1',
      customer: { email: 'u***@example.com', name: 'A*** S***' },
      items: [{ sku: 'ABC', qty: 0, unit_price: 10 }],
      currency: 'dolar',
      idempotency_key: 'key-1',
    });
  });

  it('records only the NAMES of unknown fields, never their values (they may hold personal data)', () => {
    const record = invalidPayload();

    expect(record.unknown_fields).toEqual([
      'customer.phone',
      'items.color',
      'notes',
    ]);
    expect(JSON.stringify(record)).not.toMatch(
      /99999|123\.456|CPF|blue|user@example|Souza/,
    );
  });

  it('keeps wrongly typed values (that is often the reason for the 400), except under customer', () => {
    const record = buildRejectionRecord({
      ...base,
      kind: 'INVALID_PAYLOAD',
      rawBody: Buffer.from('{}'),
      parsedBody: {
        items: 'not-an-array',
        customer: 'Ana <ana@x.com>',
        qty: 1,
      },
      errors: [],
    });

    expect(record.payload).toEqual({
      items: 'not-an-array',
      customer: '[redacted: string]',
    });
    expect(record.unknown_fields).toEqual(['qty']);
  });

  it('a body that is not JSON: no payload at all, only hash and size', () => {
    const malformed = Buffer.from(
      '{"order_id": "ext-1", "customer": {"email": "user@exa',
    );

    const record = buildRejectionRecord({
      ...base,
      kind: 'MALFORMED_JSON',
      rawBody: malformed,
      errors: [],
    });

    expect(record).toMatchObject({
      payload: null,
      unknown_fields: [],
      payload_hash: sha256(malformed.toString()),
      payload_size: malformed.length,
      error_codes: ['body:malformedJson'],
    });
    expect(JSON.stringify(record)).not.toContain('user@exa');
  });

  it('a body over the limit: nothing of it was read, only the declared size', () => {
    const record = buildRejectionRecord({
      ...base,
      kind: 'PAYLOAD_TOO_LARGE',
      declaredSize: 5_000_000,
      errors: [],
    });

    expect(record).toMatchObject({
      payload: null,
      payload_hash: null,
      payload_size: 5_000_000,
      error_codes: ['body:tooLarge'],
    });
  });
});
