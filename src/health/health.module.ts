import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [OrdersModule],
  controllers: [HealthController],
})
export class HealthModule {}
