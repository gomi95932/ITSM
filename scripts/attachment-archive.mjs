import { constants } from 'node:fs';
import { lstat,mkdtemp,open,readdir,realpath,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Pool } from 'pg';

const [operation,database]=process.argv.slice(1),root='/var/lib/itsm/attachments';
const keyPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.blob$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const summary=items=>hash(JSON.stringify([...items].sort((a,b)=>a.key.localeCompare(b.key))));
const emit=async value=>{if(!process.stdout.write(`${JSON.stringify(value)}\n`))await once(process.stdout,'drain');};
const inventory=new Map();

if(operation==='create'){
  await emit({format:'itsm-private-attachments-v1'});
  let names=[];
  try{
    const stat=await lstat(root);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||await realpath(root)!==root)throw new Error('ATTACHMENT_STORAGE_INVALID');
    names=await readdir(root);
  }catch(error){if(error.code!=='ENOENT'||process.env.ENABLE_ATTACHMENTS==='true')throw error;}
  for(const key of names.sort()){
    if(!keyPattern.test(key))throw new Error('UNEXPECTED_ATTACHMENT_OBJECT');
    const file=await open(join(root,key),constants.O_RDONLY|constants.O_NOFOLLOW);
    let bytes;
    try{
      const stat=await file.stat();
      if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o777)!==0o400||stat.size<1||stat.size>20971520)throw new Error('ATTACHMENT_OBJECT_NOT_IMMUTABLE');
      bytes=await file.readFile();
    }finally{await file.close();}
    const metadata={key,size:bytes.length,sha256:hash(bytes)};inventory.set(key,metadata);
    await emit({...metadata,bytes:bytes.toString('base64')});
  }
  await emit({complete:true,objects:inventory.size,inventorySha256:summary(inventory.values())});
}else if(operation==='verify'){
  if(!/^itsm_restore_[0-9]+_[0-9]+$/.test(database??''))throw new Error('ISOLATED_RESTORE_DATABASE_REQUIRED');
  const scratch=await mkdtemp('/tmp/itsm-attachments-restore-');
  const db=new Pool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT??5432),database,user:process.env.DB_USER,password:process.env.DB_PASSWORD});
  let header=false,completed=false,referenced=0;
  try{
    for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
      if(line.length>28_000_000||completed)throw new Error('INVALID_ATTACHMENT_ARCHIVE');
      const item=JSON.parse(line);
      if(!header){if(item.format!=='itsm-private-attachments-v1')throw new Error('INVALID_ATTACHMENT_ARCHIVE');header=true;continue;}
      if(item.complete===true){
        if(item.objects!==inventory.size||item.inventorySha256!==summary(inventory.values()))throw new Error('ATTACHMENT_ARCHIVE_INVENTORY_MISMATCH');
        completed=true;continue;
      }
      if(!keyPattern.test(item.key??'')||inventory.has(item.key)||!Number.isInteger(item.size)||item.size<1||item.size>20971520||
        !/^[a-f0-9]{64}$/.test(item.sha256??'')||typeof item.bytes!=='string')throw new Error('INVALID_ATTACHMENT_ARCHIVE');
      const bytes=Buffer.from(item.bytes,'base64');
      if(bytes.toString('base64')!==item.bytes||bytes.length!==item.size||hash(bytes)!==item.sha256)throw new Error('ATTACHMENT_ARCHIVE_HASH_MISMATCH');
      const file=await open(join(scratch,item.key),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{
        await file.writeFile(bytes);await file.sync();await file.chmod(0o400);
      }finally{await file.close();}
      const restored=await open(join(scratch,item.key),constants.O_RDONLY|constants.O_NOFOLLOW);
      try{if(hash(await restored.readFile())!==item.sha256)throw new Error('ATTACHMENT_RESTORE_HASH_MISMATCH');}finally{await restored.close();}
      inventory.set(item.key,{key:item.key,size:item.size,sha256:item.sha256});
    }
    if(!header||!completed)throw new Error('INCOMPLETE_ATTACHMENT_ARCHIVE');
    const present=(await db.query("SELECT to_regclass('public.attachments') IS NOT NULL AS present")).rows[0].present;
    if(present){
      let after='00000000-0000-0000-0000-000000000000';
      while(true){
        const rows=(await db.query('SELECT id,object_key,size,sha256,scan_status FROM attachments WHERE id>$1 ORDER BY id LIMIT 1000',[after])).rows;
        if(!rows.length)break;
        for(const row of rows){
          if(row.object_key!==`${row.id}.blob`)throw new Error('INVALID_ATTACHMENT_REFERENCE');
          const item=inventory.get(row.object_key),required=['CLEAN','QUARANTINED','SCANNING'].includes(row.scan_status);
          if(required&&!item)throw new Error('REFERENCED_ATTACHMENT_MISSING');
          if(item&&(item.size!==row.size||item.sha256!==row.sha256))throw new Error('REFERENCED_ATTACHMENT_HASH_MISMATCH');
          if(required)referenced++;
          after=row.id;
        }
      }
    }
    await emit({method:'isolated-attachment-bytes-v1',status:'passed',objects:inventory.size,referenced,
      inventorySha256:summary(inventory.values()),verifiedAt:new Date().toISOString()});
  }finally{await db.end();await rm(scratch,{recursive:true,force:true});}
}else throw new Error('INVALID_ATTACHMENT_ARCHIVE_OPERATION');
