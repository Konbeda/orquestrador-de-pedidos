import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Either request_id (one support lookup) or source (+ period). Never a full scan. */
export class ListRejectionsQuery {
  @ApiPropertyOptional({
    description:
      'request_id of a refused webhook (request_id or source is required)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  request_id?: string;

  @ApiPropertyOptional({ description: 'Sender (client IP)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;

  /** Inclusive. Default: 24 hours before `to`. */
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Inclusive; default 24 h before to',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /** Exclusive. Default: now. */
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Exclusive; default now',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
