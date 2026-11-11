import { HttpException, HttpStatus } from '@nestjs/common';
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

export interface FieldError {
  field: string;
  message: string;
}

/** Thrown by the ValidationPipe: the payload broke the contract. */
export class InvalidPayloadError extends Error {
  override name = 'InvalidPayloadError';
  constructor(readonly errors: FieldError[]) {
    super('The payload is invalid');
  }
}

export interface HttpError {
  status: number;
  /** Stable, machine readable: clients branch on it, not on the message. */
  code: string;
  message: string;
  errors?: FieldError[];
}

/** Domain and application errors → HTTP. One table, so every endpoint answers alike. */
const KNOWN: Array<[new (...args: never[]) => Error, number, string]> = [
  [OrderAlreadyExistsError, HttpStatus.CONFLICT, 'ORDER_ALREADY_EXISTS'],
  [OrderBeingProcessedError, HttpStatus.CONFLICT, 'ORDER_BEING_PROCESSED'],
  [RevisionLimitReachedError, HttpStatus.CONFLICT, 'REVISION_LIMIT_REACHED'],
  [ConcurrentUpdateError, HttpStatus.CONFLICT, 'CONCURRENT_UPDATE'],
  [
    IdempotencyKeyReusedError,
    HttpStatus.UNPROCESSABLE_ENTITY,
    'IDEMPOTENCY_KEY_REUSED',
  ],
  [InvalidOrderError, HttpStatus.UNPROCESSABLE_ENTITY, 'INVALID_ORDER'],
];

/** body-parser errors reach Nest as plain errors with a `type`. */
const BODY_PARSER: Record<string, [number, string, string]> = {
  'entity.parse.failed': [400, 'MALFORMED_JSON', 'The body is not valid JSON'],
  'entity.too.large': [
    413,
    'PAYLOAD_TOO_LARGE',
    'The body exceeds the size limit',
  ],
};

export function toHttpError(error: unknown): HttpError {
  if (error instanceof InvalidPayloadError) {
    return {
      status: 400,
      code: 'INVALID_PAYLOAD',
      message: error.message,
      errors: error.errors,
    };
  }
  for (const [type, status, code] of KNOWN) {
    if (error instanceof type) return { status, code, message: error.message };
  }

  // Raw, or wrapped by Nest in an HttpException whose `cause` is the parser error.
  const parserType =
    (error as { type?: unknown })?.type ??
    (error as { cause?: { type?: unknown } })?.cause?.type;
  if (typeof parserType === 'string' && parserType in BODY_PARSER) {
    const [status, code, message] = BODY_PARSER[parserType]!;
    return { status, code, message };
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      status,
      code: HttpStatus[status] ?? 'HTTP_ERROR',
      message: error.message,
    };
  }

  // Anything else is ours: log it, never leak it.
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  };
}

/** class-validator nests errors (items → 0 → qty); clients get flat dotted paths. */
export function flattenValidationErrors(
  errors: ValidationError[],
  parent = '',
): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({
      field,
      message,
    }));
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}
