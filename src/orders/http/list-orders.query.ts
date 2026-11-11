import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { OrderStatus } from '../domain/order-status.js';

export class ListOrdersQuery {
  @ApiPropertyOptional({ enum: Object.values(OrderStatus) })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({
    example: 'ext-123',
    description: 'Exact order_id of the sending system',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  order_id?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  /** The `next_cursor` of the previous page. */
  @ApiPropertyOptional({ description: 'next_cursor of the previous page' })
  @IsOptional()
  @Matches(/^[0-9a-f]{24}$/i, {
    message: 'cursor must be a next_cursor from a previous page',
  })
  cursor?: string;
}
