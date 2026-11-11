import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FieldErrorModel {
  @ApiProperty({ example: 'items.0.qty' })
  field!: string;

  @ApiProperty({ example: 'qty must be a positive number' })
  message!: string;
}

/** Every error of the API, from any endpoint. */
export class ErrorResponse {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({
    description: 'Stable, machine readable: branch on it, not on the message',
    example: 'INVALID_PAYLOAD',
    enum: [
      'INVALID_PAYLOAD',
      'MALFORMED_JSON',
      'PAYLOAD_TOO_LARGE',
      'ORDER_ALREADY_EXISTS',
      'ORDER_BEING_PROCESSED',
      'REVISION_LIMIT_REACHED',
      'CONCURRENT_UPDATE',
      'IDEMPOTENCY_KEY_REUSED',
      'INVALID_ORDER',
      'ORDER_NOT_FOUND',
      'QUEUE_UNAVAILABLE',
      'NOT_FOUND',
      'INTERNAL_ERROR',
    ],
  })
  code!: string;

  @ApiProperty({ example: 'The payload is invalid' })
  message!: string;

  @ApiProperty({
    description:
      'Same as the x-request-id response header; quote it to support',
    example: 'req_6346e2db-baa9-47c7-84d3-96c52aa682bf',
  })
  request_id!: string;

  @ApiPropertyOptional({
    type: [FieldErrorModel],
    description: 'Only on INVALID_PAYLOAD',
  })
  errors?: FieldErrorModel[];
}
