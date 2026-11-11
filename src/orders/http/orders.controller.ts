import { Controller, Get, Param, Query } from '@nestjs/common';
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
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrderRepository,
    private readonly queue: BullMqEnrichmentQueue,
  ) {}

  @Get('orders')
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
  async findOne(@Param('id') id: string): Promise<OrderResponse> {
    const order = await this.orders.findById(id);
    if (!order) throw new OrderNotFoundError(id);
    return presentOrder(order);
  }

  @Get('queue/metrics')
  metrics(): Promise<EnrichmentQueueMetrics> {
    return this.queue.metrics();
  }
}
