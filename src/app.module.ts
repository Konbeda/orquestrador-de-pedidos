import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv, type Env } from './config/env.schema.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Built on demand (not at import time) so the configuration is read when the
 * app is created: tests set their environment first, then call `register()`.
 */
@Module({})
export class AppModule {
  static register(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          validate: validateEnv,
          // Tests get their settings from the test containers, never from a local .env.
          ignoreEnvFile: process.env.NODE_ENV === 'test',
        }),

        LoggerModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) => ({
            pinoHttp: {
              level: config.get('LOG_LEVEL', { infer: true }),
              // Reuse the caller's id when it sends one, so both sides can correlate.
              genReqId: (req: IncomingMessage) => {
                const incoming = req.headers[REQUEST_ID_HEADER];
                return typeof incoming === 'string' && incoming.length > 0
                  ? incoming
                  : `req_${randomUUID()}`;
              },
              customProps: (req: IncomingMessage) => ({ request_id: req.id }),
              // Personal data never reaches the logs (LGPD: data minimization).
              redact: {
                paths: [
                  'req.headers.authorization',
                  'req.body.customer',
                  '*.customer.email',
                  '*.customer.name',
                ],
                censor: '[REDACTED]',
              },
              transport:
                config.get('NODE_ENV', { infer: true }) === 'development'
                  ? { target: 'pino-pretty', options: { singleLine: true } }
                  : undefined,
            },
          }),
        }),

        MongooseModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) => ({
            uri: config.get('MONGO_URI', { infer: true }),
            // Indexes are declared in the schemas and created at boot (unique + TTL).
            autoIndex: true,
          }),
        }),

        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) => ({
            connection: {
              host: config.get('REDIS_HOST', { infer: true }),
              port: config.get('REDIS_PORT', { infer: true }),
            },
          }),
        }),
      ],
    };
  }
}
