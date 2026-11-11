import {
  Body,
  Controller,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ErrorResponse } from '../../shared/http/error-response.js';
import { OrderResponse as OrderResponseModel } from './api-models.js';
import { ReceiveOrder } from '../application/receive-order.use-case.js';
import { presentOrder, type OrderResponse } from './order.presenter.js';
import { ReceiveOrderDto } from './receive-order.dto.js';
import { requestIdOf } from '../../shared/http/request-id.js';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly receiveOrder: ReceiveOrder) {}

  /**
   * 202 created or updated (enrichment happens asynchronously),
   * 200 duplicate (same idempotency key: nothing new happened).
   */
  @Post('orders')
  @ApiOperation({ summary: 'Receive an order (idempotent by idempotency_key)' })
  @ApiResponse({
    status: 202,
    type: OrderResponseModel,
    description: 'Created or updated; enrichment runs asynchronously',
  })
  @ApiResponse({
    status: 200,
    type: OrderResponseModel,
    description: 'Duplicate: same idempotency_key, nothing new happened',
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponse,
    description:
      'INVALID_PAYLOAD or MALFORMED_JSON; recorded in the rejection audit',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponse,
    description:
      'ORDER_ALREADY_EXISTS, ORDER_BEING_PROCESSED, REVISION_LIMIT_REACHED or CONCURRENT_UPDATE',
  })
  @ApiResponse({
    status: 413,
    type: ErrorResponse,
    description: 'PAYLOAD_TOO_LARGE (BODY_LIMIT)',
  })
  @ApiResponse({
    status: 422,
    type: ErrorResponse,
    description: 'IDEMPOTENCY_KEY_REUSED (same key, other order_id)',
  })
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
