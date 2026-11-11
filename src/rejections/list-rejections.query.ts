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
  @IsOptional()
  @IsString()
  @MaxLength(128)
  request_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;

  /** Inclusive. Default: 24 hours before `to`. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /** Exclusive. Default: now. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
