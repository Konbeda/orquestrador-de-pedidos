import { ApiProperty } from '@nestjs/swagger';
import { FailureReason, OrderStatus } from '../domain/order-status.js';
import type { OrderResponse as OrderResponseShape } from './order.presenter.js';

/*
 * OpenAPI models of the responses. The presenter defines the shape (interface);
 * these classes only describe it for Swagger, and `implements` keeps them in sync.
 */

export class EnrichmentModel {
  @ApiProperty({ example: 'BRL' })
  target_currency!: string;

  @ApiProperty({ example: 5.5517 })
  rate!: number;

  @ApiProperty({
    example: '2026-11-10',
    description: 'Date of the rate, as published by Frankfurter',
  })
  rate_date!: string;

  @ApiProperty({ example: 665.09 })
  converted_total!: number;
}

export class FailureModel {
  @ApiProperty({ enum: Object.values(FailureReason) })
  reason!: string;

  @ApiProperty({
    description: 'Whether POST /orders/reprocess can send it back',
  })
  retryable!: boolean;
}

/** An order as the API shows it: no customer data, no idempotency keys. */
export class OrderResponse implements OrderResponseShape {
  @ApiProperty({
    example: '6af3e21ba882a0d0ffdfb82d',
    description: 'Internal id',
  })
  id!: string;

  @ApiProperty({ example: 'ext-123', description: 'Id in the sending system' })
  order_id!: string;

  @ApiProperty({ enum: Object.values(OrderStatus) })
  status!: string;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ example: 119.8 })
  total!: number;

  @ApiProperty({
    example: 1,
    description: 'Grows with each accepted update (policy=update)',
  })
  revision!: number;

  @ApiProperty({ type: EnrichmentModel, nullable: true })
  enrichment!: EnrichmentModel | null;

  @ApiProperty({ type: FailureModel, nullable: true })
  failure!: FailureModel | null;
}

export class OrderPage {
  @ApiProperty({ type: [OrderResponse] })
  data!: OrderResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Pass as `cursor` for the next (older) page; null on the last one',
  })
  next_cursor!: string | null;
}

export class ReprocessedModel {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    description: 'Stored as RECEIVED but not enqueued: the orphan sweeper will',
  })
  pending_enqueue!: boolean;
}

export class SkippedModel {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    enum: [
      'NOT_FOUND',
      'NOT_FAILED',
      'NOT_RETRYABLE',
      'LIMIT_REACHED',
      'CONCURRENT_UPDATE',
    ],
  })
  reason!: string;
}

export class ReprocessResult {
  @ApiProperty({ type: [ReprocessedModel] })
  reprocessed!: ReprocessedModel[];

  @ApiProperty({ type: [SkippedModel] })
  skipped!: SkippedModel[];
}

export class EnrichmentQueueCounts {
  @ApiProperty() waiting!: number;
  @ApiProperty() active!: number;
  @ApiProperty({ description: 'Waiting for their retry backoff' })
  delayed!: number;
  @ApiProperty() completed!: number;
  @ApiProperty() failed!: number;

  @ApiProperty({
    description:
      'Remaining pause set by the open circuit breaker (0 = running)',
  })
  paused_for_ms!: number;
}

export class DeadLetterCounts {
  @ApiProperty({
    description: 'Jobs that failed for good (copies, kept for inspection)',
  })
  total!: number;
}

export class QueueMetrics {
  @ApiProperty({ type: EnrichmentQueueCounts })
  enrichment!: EnrichmentQueueCounts;

  @ApiProperty({ type: DeadLetterCounts })
  dead_letter!: DeadLetterCounts;
}
