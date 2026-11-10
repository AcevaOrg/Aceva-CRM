import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@aceva/contracts';
import { PrismaService } from '../prisma/prisma.service';

const API_VERSION = '0.1.0';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Is the API running, and can it reach PostgreSQL?' })
  @ApiOkResponse({
    description: 'status "ok" when the database answers, otherwise "degraded" (database "down").',
    schema: {
      example: { status: 'ok', database: 'up', time: '2026-11-10T10:00:00.000Z', version: API_VERSION },
    },
  })
  async check(): Promise<HealthResponse> {
    let database: HealthResponse['database'] = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      time: new Date().toISOString(),
      version: API_VERSION,
    };
  }
}
