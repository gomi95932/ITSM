import { Worker } from 'bullmq';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// Queue delivery is introduced with the transactional outbox; no jobs are accepted yet.
const worker = new Worker('itsm-outbox', async () => {
  throw new Error('Outbox delivery is not implemented');
}, { connection: redis, autorun: false });

worker.on('error', (error) => console.error('Worker connection error:', error.message));
void redis.ping().then(() => {
  console.log('ITSM worker connected to Redis; outbox processing is disabled until T09');
}).catch((error: unknown) => {
  console.error('ITSM worker cannot connect to Redis:', error);
  process.exitCode = 1;
  void shutdown();
});

async function shutdown() {
  await worker.close();
  await redis.quit();
}

process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
