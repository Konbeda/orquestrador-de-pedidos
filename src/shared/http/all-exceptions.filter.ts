import type { IncomingMessage } from 'node:http';
import {
  Catch,
  Injectable,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RejectionLog } from '../../rejections/rejection-log.js';
import {
  buildRejectionRecord,
  type RejectionKind,
} from '../../rejections/rejection-record.js';
import { assignRequestId } from './request-id.js';
import { toHttpError, type HttpError } from './http-error.js';

/** Contract violations on the webhook are audited; business conflicts (409/422) are not. */
const AUDITED: Record<string, RejectionKind> = {
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  MALFORMED_JSON: 'MALFORMED_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
};
const WEBHOOK_PATH = '/webhooks/orders';

/**
 * Every error leaves the API in the same shape:
 *   { statusCode, code, message, request_id, errors? }
 * Also catches body-parser failures, which happen before routing and before the
 * request logger, hence assigning the request id here when it is still missing.
 * Registered through APP_FILTER (not useGlobalFilters) so it can receive the RejectionLog.
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  constructor(private readonly rejections: RejectionLog) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = assignRequestId(req, res);
    const error = toHttpError(exception);

    if (error.status >= 500) {
      this.logger.error(
        { request_id: requestId, err: exception },
        'Unhandled error',
      );
    }
    await this.audit(req, requestId, error);

    res.status(error.status).json({
      statusCode: error.status,
      code: error.code,
      message: error.message,
      request_id: requestId,
      // The rule names (constraint) are internal: they feed the audit, not the client.
      ...(error.errors
        ? {
            errors: error.errors.map(({ field, message }) => ({
              field,
              message,
            })),
          }
        : {}),
    });
  }

  /** Best effort: a failing audit is logged and never changes the answer to the client. */
  private async audit(
    req: Request,
    requestId: string,
    error: HttpError,
  ): Promise<void> {
    const kind = AUDITED[error.code];
    if (!kind || req.method !== 'POST' || req.path !== WEBHOOK_PATH) return;

    try {
      const declared = Number(req.headers['content-length']);
      await this.rejections.record(
        buildRejectionRecord({
          requestId,
          receivedAt: new Date(),
          source: req.ip ?? req.socket.remoteAddress ?? 'unknown',
          userAgent: req.headers['user-agent'] ?? null,
          kind,
          rawBody: (req as IncomingMessage & { rawBody?: Buffer }).rawBody,
          parsedBody: kind === 'INVALID_PAYLOAD' ? req.body : undefined,
          declaredSize: Number.isFinite(declared) ? declared : undefined,
          errors: error.errors ?? [],
        }),
      );
    } catch (auditError) {
      this.logger.warn(
        { request_id: requestId, err: auditError },
        'Could not audit rejected webhook',
      );
    }
  }
}
