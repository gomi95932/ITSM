import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const [destination, option] = process.argv.slice(2);
if (!destination || (option && option !== '--seed-development-fixtures')) {
  console.error('Usage: node scripts/create-development-env.mjs PATH [--seed-development-fixtures]');
  process.exit(1);
}
await writeFile(destination, [
  `ITSM_DB_PASSWORD=${randomBytes(32).toString('hex')}`,
  `ITSM_REDIS_PASSWORD=${randomBytes(32).toString('hex')}`,
  'ITSM_WEB_PORT=8088', 'ITSM_NODE_ENV=development', 'ENABLE_DEV_AUTH=true',
  'NOTIFICATION_MODE=fake', 'ENABLE_LIVE_NOTIFICATIONS=false',
  `ITSM_SEED_DEV_DATA=${option === '--seed-development-fixtures'}`, '',
].join('\n'), { flag: 'wx', mode: 0o600 });
console.log('Private development environment file created; credentials not printed');
