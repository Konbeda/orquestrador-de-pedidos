import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsEmail,
  IsISO4217CurrencyCode,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/*
 * The webhook contract. Anything that breaks it is a 400 for the caller to fix.
 * Unknown fields are stripped, not refused: providers add fields over time.
 * Limits (lengths, item count) keep a single request from being abusive.
 */

export class CustomerDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;
}

export class OrderItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sku!: string;

  @IsInt()
  @IsPositive()
  qty!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  unit_price!: number;
}

export class ReceiveOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  order_id!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => CustomerDto)
  customer!: CustomerDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  /** Format only; whether the provider converts it is decided by the use case. */
  @IsISO4217CurrencyCode()
  currency!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotency_key!: string;
}
