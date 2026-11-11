import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import {
  InvalidOrderError,
  OrderBeingProcessedError,
  RevisionLimitReachedError,
} from '../../orders/domain/order.js';
import { ConcurrentUpdateError } from '../../orders/application/ports/order.repository.js';
import {
  IdempotencyKeyReusedError,
  OrderAlreadyExistsError,
} from '../../orders/application/receive-order.use-case.js';
import { OrderNotFoundError } from '../../orders/http/order-not-found.error.js';
import { QueueUnavailableError } from '../../orders/infra/queue/bullmq-enrichment.queue.js';
import {
  InvalidPayloadError,
  flattenValidationErrors,
  toHttpError,
} from './http-error.js';

describe('toHttpError', () => {
  it.each([
    [new OrderAlreadyExistsError('ext-1'), 409, 'ORDER_ALREADY_EXISTS'],
    [new OrderBeingProcessedError('ext-1'), 409, 'ORDER_BEING_PROCESSED'],
    [new RevisionLimitReachedError('ext-1', 10), 409, 'REVISION_LIMIT_REACHED'],
    [new ConcurrentUpdateError('ext-1'), 409, 'CONCURRENT_UPDATE'],
    [new IdempotencyKeyReusedError('key-1'), 422, 'IDEMPOTENCY_KEY_REUSED'],
    [new InvalidOrderError('bad'), 422, 'INVALID_ORDER'],
    [new OrderNotFoundError('abc'), 404, 'ORDER_NOT_FOUND'],
    [
      new QueueUnavailableError('redis is reconnecting'),
      503,
      'QUEUE_UNAVAILABLE',
    ],
  ])('%s → %i %s', (error, status, code) => {
    expect(toHttpError(error)).toMatchObject({
      status,
      code,
      message: error.message,
    });
  });

  it('lists the field errors of an invalid payload', () => {
    const error = new InvalidPayloadError([
      { field: 'currency', message: 'bad' },
    ]);

    expect(toHttpError(error)).toEqual({
      status: 400,
      code: 'INVALID_PAYLOAD',
      message: 'The payload is invalid',
      errors: [{ field: 'currency', message: 'bad' }],
    });
  });

  it('maps body parser failures (they are not HttpExceptions)', () => {
    const malformed = Object.assign(new SyntaxError('Unexpected end'), {
      type: 'entity.parse.failed',
      status: 400,
    });
    const tooLarge = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
    });

    expect(toHttpError(malformed)).toMatchObject({
      status: 400,
      code: 'MALFORMED_JSON',
    });
    expect(toHttpError(tooLarge)).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('recognizes body parser failures that Nest wrapped in an HttpException (cause)', () => {
    // Nest 12 maps a SyntaxError into BadRequestException(message, { cause }).
    const parse = Object.assign(new SyntaxError('Unexpected end'), {
      type: 'entity.parse.failed',
    });
    const tooLarge = Object.assign(new Error('too large'), {
      type: 'entity.too.large',
    });

    expect(
      toHttpError(new BadRequestException('x', { cause: parse })),
    ).toMatchObject({
      status: 400,
      code: 'MALFORMED_JSON',
    });
    expect(
      toHttpError(new HttpException('x', 413, { cause: tooLarge })),
    ).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it("keeps Nest's own HTTP errors, with a code derived from the status", () => {
    expect(toHttpError(new NotFoundException('Cannot GET /x'))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Cannot GET /x',
    });
  });

  it('hides the details of anything unexpected behind a 500', () => {
    expect(toHttpError(new TypeError('secret internals'))).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});

describe('flattenValidationErrors', () => {
  const node = (
    property: string,
    constraints?: Record<string, string>,
    children: ValidationError[] = [],
  ): ValidationError => ({ property, constraints, children });

  it('turns the nested class-validator tree into dotted field paths', () => {
    const tree = [
      node('currency', { isISO4217: 'currency must be ISO 4217' }),
      node('items', undefined, [
        node('0', undefined, [
          node('qty', { isPositive: 'qty must be positive' }),
        ]),
      ]),
      node('customer', undefined, [
        node('email', { isEmail: 'email must be an email' }),
      ]),
    ];

    expect(flattenValidationErrors(tree)).toEqual([
      {
        field: 'currency',
        message: 'currency must be ISO 4217',
        constraint: 'isISO4217',
      },
      {
        field: 'items.0.qty',
        message: 'qty must be positive',
        constraint: 'isPositive',
      },
      {
        field: 'customer.email',
        message: 'email must be an email',
        constraint: 'isEmail',
      },
    ]);
  });

  it('keeps every constraint of a field', () => {
    const tree = [
      node('order_id', {
        isString: 'must be a string',
        isNotEmpty: 'must not be empty',
      }),
    ];

    expect(flattenValidationErrors(tree)).toHaveLength(2);
  });
});
