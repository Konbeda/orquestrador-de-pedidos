import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponse } from '../shared/http/error-response.js';
import { InvalidPayloadError } from '../shared/http/http-error.js';
import { ListRejectionsQuery } from './list-rejections.query.js';
import { RejectionLog } from './rejection-log.js';
import type { RejectionRecord } from './rejection-record.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Support tool: "my webhook got a 400, what was wrong with it?" */
@ApiTags('webhooks')
@Controller('webhooks/rejections')
export class RejectionsController {
  constructor(private readonly rejections: RejectionLog) {}

  @Get()
  @ApiOperation({
    summary:
      'Audit of refused webhooks (masked): by request_id, or by source within a period',
  })
  @ApiResponse({ status: 200, description: '{ data: RejectionRecord[] }' })
  @ApiResponse({
    status: 400,
    type: ErrorResponse,
    description: 'INVALID_PAYLOAD (neither request_id nor source)',
  })
  async list(
    @Query() query: ListRejectionsQuery,
  ): Promise<{ data: RejectionRecord[] }> {
    if (query.request_id) {
      return { data: await this.rejections.findByRequestId(query.request_id) };
    }
    if (query.source) {
      const to = query.to ?? new Date();
      const from = query.from ?? new Date(to.getTime() - DAY_MS);
      return {
        data: await this.rejections.listBySource({
          source: query.source,
          from,
          to,
          limit: query.limit,
        }),
      };
    }
    throw new InvalidPayloadError([
      { field: 'request_id', message: 'request_id or source is required' },
    ]);
  }
}
