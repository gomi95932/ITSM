import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { attachmentConfiguration,attachmentInput,attachmentMagic,attachmentSignature,validAttachmentSignature } from './attachment-policy.js';
import { readAttachmentUpload } from './attachment-stream.js';

const config={ENABLE_ATTACHMENTS:'true',ATTACHMENT_STORAGE_APPROVAL_REF:'isolated-ci',ATTACHMENT_SIGNING_KEY:'a'.repeat(64),ATTACHMENT_CLAMD_HOST:'scanner'};
const input={name:'example.txt',mime:'text/plain',size:3,sha256:'b'.repeat(64),visibility:'PUBLIC',contentClass:'GENERAL'};
test('attachments require explicit private storage and scanner configuration',()=>{
  assert.ok(attachmentConfiguration(config));assert.equal(attachmentConfiguration({}),undefined);
  for(const key of Object.keys(config))assert.equal(attachmentConfiguration({...config,[key]:''}),undefined,key);
  for(const changes of [{ATTACHMENT_CLAMD_HOST:'user@host'},{ATTACHMENT_CLAMD_PORT:'0'},{ATTACHMENT_MAX_BYTES:'20971521'},{ATTACHMENT_MAX_BYTES:'NaN'}])
    assert.equal(attachmentConfiguration({...config,...changes}),undefined);
});
test('canonical upload metadata rejects executable names, path traversal and type mismatches',()=>{
  assert.deepEqual(attachmentInput(input),input);
  assert.equal(JSON.stringify(attachmentInput({...input,name:'example.txt'})),JSON.stringify(attachmentInput({contentClass:'GENERAL',visibility:'PUBLIC',sha256:'b'.repeat(64),size:3,mime:'text/plain',name:'example.txt'})));
  for(const changes of [{name:'../file.txt'},{name:'file\u202etxt.txt'},{name:' file.txt'},{name:'file.html'},{mime:'text/html'},
    {size:0},{size:1.5},{size:20971521},{sha256:'X'.repeat(64)},{visibility:'ALL'},{contentClass:'SECURITY_SENSITIVE'},{extra:'unexpected'}])
    assert.equal(attachmentInput({...input,...changes}),undefined);
  assert.ok(attachmentMagic(Buffer.from('正常文本\nvalue,one'),'text/plain'));
  for(const bytes of [Buffer.from('<script>alert(1)</script>'),Buffer.from([0xff,0xfe]),Buffer.from('abc\0def')])assert.equal(attachmentMagic(bytes,'text/plain'),false);
  assert.equal(attachmentMagic(Buffer.from('%PDF-1.7'),'application/pdf'),true);
  assert.equal(attachmentMagic(Buffer.from('plain text'),'image/png'),false);
});
test('short-lived grant binds identity, object and operation',()=>{
  const now=Date.now(),expires=now+60_000,key='a'.repeat(64),token=attachmentSignature(key,'object','alice','download',expires);
  assert.equal(validAttachmentSignature(key,token,'object','alice','download',expires,now),true);
  for(const [object,actor,operation,time] of [['other','alice','download',expires],['object','bob','download',expires],
    ['object','alice','upload',expires],['object','alice','download',now],['object','alice','download',now+300001]] as const)
    assert.equal(validAttachmentSignature(key,token,object,actor,operation,time,now),false);
  assert.equal(validAttachmentSignature(key,'x','object','alice','download',expires,now),false);
});
test('raw upload accepts exact bytes and terminates oversized, short, disconnected and stalled streams',async()=>{
  const normal=new PassThrough(),result=readAttachmentUpload(normal,3);normal.end(Buffer.from('abc'));assert.equal((await result).toString(),'abc');
  const over=new PassThrough(),oversize=readAttachmentUpload(over,2);over.end(Buffer.from('abc'));await assert.rejects(oversize);
  const short=new PassThrough(),shortResult=readAttachmentUpload(short,3);short.end(Buffer.from('a'));await assert.rejects(shortResult);
  const gone=new PassThrough(),goneResult=readAttachmentUpload(gone,3);gone.destroy();await assert.rejects(goneResult);
  await assert.rejects(readAttachmentUpload(new PassThrough(),3,20));
  const ended=new PassThrough();ended.destroy();await assert.rejects(readAttachmentUpload(ended,3,20));
});
