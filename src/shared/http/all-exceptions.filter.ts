import {
  Catch,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { assignRequestId } from './request-id.js';
import { toHttpError } from './http-error.js';

/**
 * Every error leaves the API in the same shape:
 *   { statusCode, code, message, request_id, errors? }
 * Also catches body-parser failures, which happen before routing and before the
 * request logger, hence assigning the request id here when it is still missing.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
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

    res.status(error.status).json({
      statusCode: error.status,
      code: error.code,
      message: error.message,
      request_id: requestId,
      ...(error.errors ? { errors: error.errors } : {}),
    });
  }
}
