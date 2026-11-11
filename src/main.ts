import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { Env } from './config/env.schema.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule.register(), {
    bufferLogs: true,
    bodyParser: false, // configureApp registers it with BODY_LIMIT
  });
  configureApp(app);

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

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
