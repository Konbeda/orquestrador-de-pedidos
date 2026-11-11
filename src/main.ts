import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.schema.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(),
    {
      bufferLogs: true,
      bodyParser: false,
    },
  );
  app.useLogger(app.get(Logger));

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  app.useBodyParser('json', {
    limit: config.get('BODY_LIMIT', { infer: true }),
  });

  // Lets in-flight jobs and requests finish on SIGTERM (docker stop, k8s rollout).
  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle('Orders Orchestrator')
    .setDescription(
      'Receives orders by webhook, enriches them asynchronously and exposes their status.',
    )
    .setVersion('1.0')
    .build();
  SwaggerModule.setup('docs', app, () =>
    SwaggerModule.createDocument(app, openApi),
  );

  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
