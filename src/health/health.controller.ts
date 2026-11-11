import { Controller, Get, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Connection } from 'mongoose';
import { EnrichmentQueue } from '../orders/application/ports/enrichment.queue.js';
import { CachedSupportedCurrencies } from '../orders/infra/exchange/cached-supported-currencies.js';
import { CircuitBreakingExchangeRateProvider } from '../orders/infra/exchange/circuit-breaking.provider.js';
import { evaluateHealth, type HealthReport } from './evaluate-health.js';

const MONGO_PING_TIMEOUT_MS = 1000;

/**
 * GET /health: 200 ok | 200 degraded | 503 down (only Mongo is critical).
 * Only Mongo is pinged; Redis and Frankfurter report the state their clients
 * already know, so polling /health never adds load to the external API.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    private readonly queue: EnrichmentQueue,
    private readonly exchange: CircuitBreakingExchangeRateProvider,
    private readonly currencies: CachedSupportedCurrencies,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'ok | degraded (Redis or Frankfurter out: orders still accepted) | down',
  })
  @ApiResponse({
    status: 200,
    description: 'ok or degraded: keep the instance in the load balancer',
  })
  @ApiResponse({
    status: 503,
    description: 'down: Mongo unreachable, orders cannot be stored',
  })
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthReport['body']> {
    const report = evaluateHealth({
      mongo: await this.pingMongo(),
      redis: this.queue.isAvailable(),
      frankfurter: {
        circuit: this.exchange.circuitState,
        currenciesSource: this.currencies.listSource,
      },
    });
    res.status(report.httpStatus);
    return report.body;
  }

  private async pingMongo(): Promise<boolean> {
    if (this.mongo.readyState !== 1 || !this.mongo.db) return false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.mongo.db.admin().ping(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('ping timeout')),
            MONGO_PING_TIMEOUT_MS,
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
