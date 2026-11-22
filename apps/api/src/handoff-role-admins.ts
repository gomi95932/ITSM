import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Database } from './database.service.js';
import { handoffAdministrators } from './admin-handoff.js';

const db=new Database();
try {
  const args=process.argv.slice(2),apply=args.length===1&&args[0]==='--apply';
  if(!(args.length===0||apply)||process.env.ITSM_ADMIN_HANDOFF_CONFIRM!=='TRANSFER_DEMO_ADMINS')throw new Error('HANDOFF_CONFIRMATION_REQUIRED');
  if(apply&&(process.env.NODE_ENV!=='production'||process.env.ENABLE_DEV_AUTH!=='false'))throw new Error('HANDOFF_PRODUCTION_AUTH_REQUIRED');
  const input=readFileSync(0,'utf8');
  if(Buffer.byteLength(input)>16384)throw new Error('HANDOFF_SELECTION_INVALID');
  const result=await db.transaction(client=>handoffAdministrators(client,JSON.parse(input),apply));
  console.log(JSON.stringify(result));
} catch(error) {
  const code=error instanceof Error&&/^HANDOFF_[A-Z_]+$/.test(error.message)?error.message:'HANDOFF_FAILED';
  console.error(code);process.exitCode=1;
} finally {await db.onModuleDestroy();}
