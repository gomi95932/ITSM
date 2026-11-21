import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { json as jsonBody } from 'express';
import { AppModule } from '/srv/apps/api/dist/app.module.js';
import { Database } from '/srv/apps/api/dist/database.service.js';

if(process.env.ENABLE_DEV_AUTH!=='true'||process.env.NODE_ENV!=='development')throw new Error('ISOLATED_DEVELOPMENT_ONLY');
let scannerMode='normal';const sockets=new Set();
// This fixture verifies the real HTTP/database workflow; it does not validate antivirus detection.
const scanner=createServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  let pending=Buffer.alloc(0),command='',size=-1,bytes=Buffer.alloc(0);
  socket.on('data',chunk=>{
    pending=Buffer.concat([pending,chunk]);
    if(!command){const end=pending.indexOf(0);if(end<0)return;command=pending.toString('utf8',0,end);pending=pending.subarray(end+1);
      if(command==='zVERSION'){socket.end(`ClamAV 1.4/123/${new Date(Date.now()-(scannerMode==='stale'?73*3600_000:0)).toUTCString()}\0`);return;}
      if(scannerMode==='down'){socket.destroy();return;}}
    while(true){
      if(size===-1){if(pending.length<4)return;size=pending.readUInt32BE(0);pending=pending.subarray(4);if(!size){
        socket.end(bytes.includes(Buffer.from('fixture-detection'))?'stream: Fixture.Signature FOUND\0':'stream: OK\0');return;}}
      if(pending.length<size)return;bytes=Buffer.concat([bytes,pending.subarray(0,size)]);pending=pending.subarray(size);size=-1;
    }
  });
});
await new Promise(resolve=>scanner.listen(0,'127.0.0.1',resolve));
Object.assign(process.env,{ENABLE_ATTACHMENTS:'true',ATTACHMENT_STORAGE_APPROVAL_REF:'disposable-ci-protocol-fixture',
  ATTACHMENT_SIGNING_KEY:'a'.repeat(64),ATTACHMENT_CLAMD_HOST:'127.0.0.1',ATTACHMENT_CLAMD_PORT:String(scanner.address().port)});
const app=await NestFactory.create(AppModule,{logger:false,bodyParser:false});app.use(jsonBody({limit:'3mb'}));
app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');
const base=`${await app.getUrl()}/api/v1`,db=app.get(Database);
async function call(path,user='employee-1',method='GET',body,headers={}){
  const binary=Buffer.isBuffer(body);
  const requestHeaders=new Headers({'x-dev-user':user});
  if(body!==undefined)requestHeaders.set('content-type',binary?'application/octet-stream':'application/json');
  for(const [name,value] of Object.entries(headers))requestHeaders.set(name,value);
  const response=await fetch(base+path,{method,headers:requestHeaders,
    body:body===undefined?undefined:binary?body:JSON.stringify(body),signal:AbortSignal.timeout(150_000)});
  return {status:response.status,headers:response.headers,bytes:async()=>Buffer.from(await response.arrayBuffer()),json:async()=>response.json()};
}
const json=async(...args)=>{const r=await call(...args);return {status:r.status,data:await r.json()};};
const key=()=>randomUUID(),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
  const created=await json('/tickets','employee-1','POST',{contentClass:'GENERAL',serviceCode:'INC-BIZ',formVersion:1,
    subject:'Attachment CI workflow',description:'Synthetic fixture for attachment access',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{}},{'idempotency-key':key()});
  assert.equal(created.status,201,JSON.stringify(created));const id=created.data.id,path=`/tickets/${id}/attachments`;
  const reserve=async(bytes,visibility='PUBLIC',user='employee-1',changes={},requestKey=key())=>json(`${path}/presign`,user,'POST',
    {name:'fixture.txt',mime:'text/plain',size:bytes.length,sha256:sha(bytes),visibility,contentClass:'GENERAL',...changes},{'idempotency-key':requestKey});
  const upload=async(bytes,visibility='PUBLIC',user='employee-1')=>{
    const grant=await reserve(bytes,visibility,user);assert.equal(grant.status,201,JSON.stringify(grant));
    const result=await json(`${path}/${grant.data.id}/content`,user,'PUT',bytes,grant.data.headers);return {...result,id:grant.data.id,grant:grant.data};
  };
  const bytes=Buffer.from('synthetic attachment content'),publicFile=await upload(bytes);
  assert.equal(publicFile.status,200,JSON.stringify(publicFile));assert.equal(publicFile.data.scanStatus,'CLEAN');
  const grant=await json(`${path}/${publicFile.id}/download`,'employee-1','POST');assert.equal(grant.status,200);
  const downloaded=await call(`${path}/${publicFile.id}/content`,'employee-1','GET',undefined,grant.data.headers);
  assert.equal(downloaded.status,200);assert.deepEqual(await downloaded.bytes(),bytes);assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');
  assert.equal(downloaded.headers.get('cache-control'),'private, no-store');
  assert.equal((await json(`${path}/${publicFile.id}/content`,'employee-2','GET',undefined,grant.data.headers)).status,403);
  assert.equal((await json(`${path}/${publicFile.id}/content`,'employee-1','GET',undefined,{...grant.data.headers,'X-ITSM-Attachment-Expires':'1'})).status,403);
  assert.equal((await json(`${path}/${publicFile.id}/content`,'employee-1','PUT',bytes,publicFile.grant.headers)).status,409);
  assert.equal((await json(path,'employee-2')).status,404);
  assert.equal((await reserve(bytes,'INTERNAL')).status,403);
  const internalFile=await upload(Buffer.from('engineer-only fixture'),'INTERNAL','agent-1');assert.equal(internalFile.data.scanStatus,'CLEAN');
  const employeeList=await json(path);assert.equal(employeeList.data.items.some(row=>row.id===internalFile.id),false);
  assert.equal((await json(`${path}/${internalFile.id}/download`,'employee-1','POST')).status,404);
  const internalGrant=await json(`${path}/${internalFile.id}/download`,'agent-1','POST');assert.equal(internalGrant.status,200);
  const memberships=(await db.pool.query("DELETE FROM group_memberships WHERE employee_id='agent-1' RETURNING *")).rows;
  try{assert.equal((await json(`${path}/${internalFile.id}/content`,'agent-1','GET',undefined,internalGrant.data.headers)).status,404);}
  finally{for(const membership of memberships)await db.pool.query('INSERT INTO group_memberships(group_id,employee_id) VALUES ($1,$2)',[membership.group_id,membership.employee_id]);}
  await db.pool.query("UPDATE employees SET active=false WHERE id='employee-1'");
  try{assert.equal((await json(`${path}/${publicFile.id}/content`,'employee-1','GET',undefined,grant.data.headers)).status,401);}
  finally{await db.pool.query("UPDATE employees SET active=true WHERE id='employee-1'");}
  const detected=await upload(Buffer.from('fixture-detection'));assert.equal(detected.data.scanStatus,'QUARANTINED');
  assert.equal((await json(`${path}/${detected.id}/download`,'employee-1','POST')).status,409);
  const mismatch=await reserve(bytes,'PUBLIC','employee-1',{sha256:'f'.repeat(64)});
  assert.equal((await json(`${path}/${mismatch.data.id}/content`,'employee-1','PUT',bytes,mismatch.data.headers)).status,400);
  for(const mode of ['stale','down']){scannerMode=mode;const failed=await upload(bytes);assert.equal(failed.status,503);assert.equal((await json(`${path}/${failed.id}/download`,'employee-1','POST')).status,409);}scannerMode='normal';
  const idem=key(),first=await reserve(bytes,'PUBLIC','employee-1',{},idem),second=await reserve(bytes,'PUBLIC','employee-1',{},idem);
  assert.equal(first.data.id,second.data.id);assert.equal((await reserve(Buffer.from('other'),'PUBLIC','employee-1',{},idem)).status,409);
  const events=(await db.pool.query('SELECT action FROM attachment_audits WHERE attachment_id=$1 ORDER BY created_at',[publicFile.id])).rows.map(row=>row.action);
  for(const expected of ['RESERVED','UPLOADED','CLEAN','DOWNLOAD_GRANTED','DOWNLOADED'])assert.ok(events.includes(expected));
  assert.equal((await db.pool.query('SELECT scan_status FROM attachments WHERE id=$1',[mismatch.data.id])).rows[0].scan_status,'FAILED');
  console.log('Attachment HTTP/database integration passed: public/internal access, identity and membership revocation, grants, immutable upload, mismatch, quarantine, scanner failures, idempotency and audits. Antivirus replies were protocol fixtures.');
}finally{
  await app.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>scanner.close(resolve));
}
