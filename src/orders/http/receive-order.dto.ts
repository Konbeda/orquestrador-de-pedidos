import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({ example: 'user@example.com', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Ana', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;
}

export class OrderItemDto {
  @ApiProperty({ example: 'ABC123', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sku!: string;

  @ApiProperty({ example: 2, minimum: 1, description: 'Positive integer' })
  @IsInt()
  @IsPositive()
  qty!: number;

  @ApiProperty({ example: 59.9, minimum: 0 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  unit_price!: number;
}

export class ReceiveOrderDto {
  @ApiProperty({
    example: 'ext-123',
    maxLength: 100,
    description: 'Id in the sending system; unique',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  order_id!: string;

  @ApiProperty({ type: CustomerDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => CustomerDto)
  customer!: CustomerDto;

  @ApiProperty({ type: [OrderItemDto], minItems: 1, maxItems: 500 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  /** Format only; whether the provider converts it is decided by the use case. */
  @ApiProperty({
    example: 'USD',
    description:
      'ISO 4217. A valid code Frankfurter does not convert is accepted (202) and ends FAILED_ENRICHMENT / UNSUPPORTED_CURRENCY',
  })
  @IsISO4217CurrencyCode()
  currency!: string;

  @ApiProperty({
    example: '5f0c1a2e-9a7b-4c1d-8e3f-1b2c3d4e5f60',
    maxLength: 255,
    description:
      'One per operation: resend the same key on retries and you get 200 with the same order',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotency_key!: string;
}
