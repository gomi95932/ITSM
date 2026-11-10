import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { type HealthResponse } from '@itsm/contracts';
import { Database } from './database.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly db: Database) {}
  @Get()
  check(): HealthResponse {
    return { status: 'ok', service: 'itsm-api' };
  }
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    try {
      const result = await this.db.pool.query(`SELECT
        (SELECT count(*) FROM schema_migrations WHERE name IN ('001_ticket_core.sql','002_workspace.sql','003_ticket_ownership.sql','004_p1_review.sql')) AS migrations,
        (SELECT count(*) FROM (SELECT id FROM tickets LIMIT 0) t) AS tickets,
        (SELECT count(*) FROM (SELECT ticket_id FROM sla_cycles LIMIT 0) s) AS sla`);
      if (Number(result.rows[0]?.migrations) !== 4) throw new Error('SCHEMA_NOT_MIGRATED');
      return { status: 'ok', service: 'itsm-api' };
    } catch { throw new ServiceUnavailableException({ code: 'API_NOT_READY' }); }
  }
}
