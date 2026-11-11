import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Swagger UI at /docs, the OpenAPI JSON at /docs-json. */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Orders Orchestrator')
    .setDescription(
      [
        'Receives orders by webhook, enriches them asynchronously (currency conversion with',
        'Frankfurter) and exposes their status.',
        '',
        'Every response carries an `x-request-id` header (yours, if you send one).',
        'Every error has the same shape: see `ErrorResponse`.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    () => SwaggerModule.createDocument(app, config),
    {
      jsonDocumentUrl: 'docs-json',
    },
  );
}
