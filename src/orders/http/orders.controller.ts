import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ErrorResponse } from '../../shared/http/error-response.js';
import {
  OrderPage as OrderPageModel,
  OrderResponse as OrderResponseModel,
  QueueMetrics,
  ReprocessResult,
} from './api-models.js';
import { ReprocessOrders } from '../application/reprocess-orders.use-case.js';
import { requestIdOf } from '../../shared/http/request-id.js';
import { ReprocessOrdersDto } from './reprocess-orders.dto.js';
import { OrderRepository } from '../application/ports/order.repository.js';
import {
  BullMqEnrichmentQueue,
  type EnrichmentQueueMetrics,
} from '../infra/queue/bullmq-enrichment.queue.js';
import { ListOrdersQuery } from './list-orders.query.js';
import { OrderNotFoundError } from './order-not-found.error.js';
import { presentOrder, type OrderResponse } from './order.presenter.js';

export interface OrderPage {
  data: OrderResponse[];
  /** Pass as `cursor` to get the next (older) page; null on the last one. */
  next_cursor: string | null;
}

/*
 * Read side. No use case in between: a read has no business rule to protect,
 * so the controller goes straight to the repository port.
 */
@ApiTags('orders')
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrderRepository,
    private readonly queue: BullMqEnrichmentQueue,
    private readonly reprocessOrders: ReprocessOrders,
  ) {}

  /** 202: the orders go back to the queue; GET /orders/:id follows them. */
  @Post('orders/reprocess')
  @ApiOperation({
    summary: 'Send FAILED_ENRICHMENT orders back for enrichment (low priority)',
  })
  @ApiResponse({ status: 202, type: ReprocessResult })
  @ApiResponse({
    status: 400,
    type: ErrorResponse,
    description: 'INVALID_PAYLOAD',
  })
  @HttpCode(HttpStatus.ACCEPTED)
  async reprocess(@Body() body: ReprocessOrdersDto, @Req() req: Request) {
    const result = await this.reprocessOrders.execute({
      orderIds: body.order_ids,
      limit: body.limit,
      requestId: requestIdOf(req),
    });
    return {
      reprocessed: result.reprocessed.map((r) => ({
        id: r.id,
        pending_enqueue: r.pendingEnqueue,
      })),
      skipped: result.skipped,
    };
  }

  @Get('orders')
  @ApiOperation({ summary: 'List orders, newest first, cursor paginated' })
  @ApiResponse({ status: 200, type: OrderPageModel })
  @ApiResponse({
    status: 400,
    type: ErrorResponse,
    description: 'INVALID_PAYLOAD (bad status, limit or cursor)',
  })
  async list(@Query() query: ListOrdersQuery): Promise<OrderPage> {
    // One extra row tells whether another page exists without a count query.
    const rows = await this.orders.list({
      status: query.status,
      orderId: query.order_id,
      before: query.cursor,
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map(presentOrder),
      next_cursor: rows.length > query.limit ? page.at(-1)!.id! : null,
    };
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'One order by internal id' })
  @ApiResponse({ status: 200, type: OrderResponseModel })
  @ApiResponse({
    status: 404,
    type: ErrorResponse,
    description: 'ORDER_NOT_FOUND',
  })
  async findOne(@Param('id') id: string): Promise<OrderResponse> {
    const order = await this.orders.findById(id);
    if (!order) throw new OrderNotFoundError(id);
    return presentOrder(order);
  }

  @ApiTags('queue')
  @Get('queue/metrics')
  @ApiOperation({
    summary: 'Enrichment queue: jobs per state, circuit pause, dead letters',
  })
  @ApiResponse({ status: 200, type: QueueMetrics })
  @ApiResponse({
    status: 503,
    type: ErrorResponse,
    description: 'QUEUE_UNAVAILABLE (Redis down)',
  })
  metrics(): Promise<EnrichmentQueueMetrics> {
    return this.queue.metrics();
  }
}
