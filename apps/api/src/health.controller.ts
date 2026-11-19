import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { type HealthResponse } from '@itsm/contracts';
import { Database } from './database.service.js';
import { matchesSchemaMigrations, readSchemaMigrations, type SchemaMigration } from './schema-readiness.js';

@Controller('health')
export class HealthController {
  private requiredMigrations?: Promise<SchemaMigration[]>;
  constructor(private readonly db: Database) {}
  @Get()
  check(): HealthResponse {
    return { status: 'ok', service: 'itsm-api' };
  }
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    try {
      const expected = await (this.requiredMigrations ??= readSchemaMigrations());
      const result = await this.db.pool.query<SchemaMigration>(`SELECT name,checksum,
        (SELECT count(*) FROM (SELECT id FROM tickets LIMIT 0) t) AS tickets,
        (SELECT count(*) FROM (SELECT ticket_id FROM sla_cycles LIMIT 0) s) AS sla
        FROM schema_migrations`);
      if (!matchesSchemaMigrations(expected, result.rows)) throw new Error('SCHEMA_NOT_MIGRATED');
      return { status: 'ok', service: 'itsm-api' };
    } catch { throw new ServiceUnavailableException({ code: 'API_NOT_READY' }); }
  }
}
