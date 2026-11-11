import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { Env } from '../config/env.schema.js';
import { AllExceptionsFilter } from '../shared/http/all-exceptions.filter.js';
import {
  MongoRejectionLog,
  REJECTIONS_COLLECTION,
} from './mongo-rejection-log.js';
import { RejectionLog } from './rejection-log.js';
import { RejectionsController } from './rejections.controller.js';

@Module({
  controllers: [RejectionsController],
  providers: [
    {
      provide: RejectionLog,
      inject: [getConnectionToken(), ConfigService],
      useFactory: async (
        connection: Connection,
        config: ConfigService<Env, true>,
      ) => {
        const log = new MongoRejectionLog(
          connection.collection(REJECTIONS_COLLECTION),
          {
            retentionDays: config.get('REJECTION_RETENTION_DAYS', {
              infer: true,
            }),
          },
        );
        // Includes the TTL index (LGPD retention), adjusted in place if the retention changed.
        await log.ensureIndexes();
        return log;
      },
    },
    // Global error filter, here because it audits rejected webhooks through RejectionLog.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class RejectionsModule {}
