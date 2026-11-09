import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { API_PREFIX } from '@itsm/contracts';
import { AppModule } from './app.module.js';

async function main() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(API_PREFIX);
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void main();
