import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class ReprocessOrdersDto {
  /** Specific orders (ids from GET /orders). Without it: every retryable failure, oldest first. */
  @ApiPropertyOptional({
    type: [String],
    maxItems: 100,
    description:
      'Ids from GET /orders; omit to reprocess every retryable failure, oldest first',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @Matches(/^[0-9a-f]{24}$/i, {
    each: true,
    message: 'order_ids must contain order ids',
  })
  order_ids?: string[];

  /** Batch size when no ids are given. */
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 500,
    default: 100,
    description: 'Batch size without order_ids',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
