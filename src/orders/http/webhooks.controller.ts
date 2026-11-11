import {
  Body,
  Controller,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ReceiveOrder } from '../application/receive-order.use-case.js';
import { presentOrder, type OrderResponse } from './order.presenter.js';
import { ReceiveOrderDto } from './receive-order.dto.js';
import { requestIdOf } from '../../shared/http/request-id.js';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly receiveOrder: ReceiveOrder) {}

  /**
   * 202 created or updated (enrichment happens asynchronously),
   * 200 duplicate (same idempotency key: nothing new happened).
   */
  @Post('orders')
  async receive(
    @Body() body: ReceiveOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponse> {
    const requestId = requestIdOf(req);
    const result = await this.receiveOrder.execute({
      orderId: body.order_id,
      idempotencyKey: body.idempotency_key,
      customer: { email: body.customer.email, name: body.customer.name },
      items: body.items.map((item) => ({
        sku: item.sku,
        qty: item.qty,
        unitPrice: item.unit_price,
      })),
      currency: body.currency,
      requestId,
    });

    if (result.pendingEnqueue) {
      // Accepted and stored; the orphan sweeper will enqueue it.
      this.logger.warn(
        {
          request_id: requestId,
          order: result.order.id,
          err: result.enqueueError,
        },
        'Order stored but not enqueued (queue unavailable); left to the sweeper',
      );
    }

    res.status(
      result.outcome === 'duplicate' ? HttpStatus.OK : HttpStatus.ACCEPTED,
    );
    return presentOrder(result.order);
  }
}
