import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { API_PREFIX } from '@itsm/contracts';
import { AppModule } from './app.module.js';
import { json } from 'express';

async function main() {
  const app = await NestFactory.create(AppModule, { bodyParser:false });
  app.use(json({ limit:'3mb' }));
  app.use((_req: unknown,res: { setHeader(k:string,v:string):void },next:()=>void) => { res.setHeader('Cache-Control','no-store'); next(); });
  app.setGlobalPrefix(API_PREFIX);
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void main();
