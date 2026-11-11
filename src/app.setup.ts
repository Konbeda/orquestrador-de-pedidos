import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.schema.js';
import { setupSwagger } from './swagger.js';
import {
  InvalidPayloadError,
  flattenValidationErrors,
} from './shared/http/http-error.js';

/**
 * Everything the running app and the e2e tests must share. Kept out of main.ts
 * so tests exercise the same body limit, validation and error format as production.
 * The app must be created with `bodyParser: false` and `rawBody: true`
 * (exact bytes kept in req.rawBody for the audit hash, even when the JSON fails to parse).
 */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  express.useLogger(express.get(Logger));
  express.useBodyParser('json', {
    limit: config.get('BODY_LIMIT', { infer: true }),
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields
      transform: true,
      // Per property: one message per field, while every invalid field is still listed.
      stopAtFirstError: true,
      exceptionFactory: (errors) =>
        new InvalidPayloadError(flattenValidationErrors(errors)),
    }),
  );
  // The error filter is registered with APP_FILTER (RejectionsModule): it needs DI for the audit.

  // Lets in-flight jobs and requests finish on SIGTERM (docker stop, k8s rollout).
  app.enableShutdownHooks();

  setupSwagger(app);
}
