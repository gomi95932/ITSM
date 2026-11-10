import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new Pool({
    host: process.env.DB_HOST ?? 'db', port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'itsm', user: process.env.DB_USER ?? 'itsm', password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 5000, statement_timeout: 15000,
  });
  async onModuleDestroy(): Promise<void> { await this.pool.end(); }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
