import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { normalizedVoice } from '/srv/apps/api/dist/voice-asr.service.js';
const exec=promisify(execFile);
const before=await readdir('/tmp');
async function sample(seconds,format,codec){
  const {stdout}=await exec('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',
    'sine=frequency=440:sample_rate=16000','-t',String(seconds),'-c:a',codec,
    ...(format==='mp4'?['-movflags','frag_keyframe+empty_moov']:[]),'-f',format,'pipe:1'],{encoding:'buffer',maxBuffer:4_000_000,timeout:10000});
  return stdout;
}
for(const [format,codec,mime] of [['wav','pcm_s16le','audio/wav'],['webm','libopus','audio/webm'],['ogg','libopus','audio/ogg'],['mp4','aac','audio/mp4']]){
  const result=await normalizedVoice(await sample(1,format,codec),mime);
  assert.equal(result.toString('ascii',0,4),'RIFF');assert.equal(result.readUInt32LE(24),16000);
  assert.equal(result.readUInt16LE(22),1);assert.ok(result.length>30000&&result.length<34000);
}
await assert.rejects(()=>normalizedVoice(Buffer.from('not real audio'),'audio/webm'));
await assert.rejects(()=>normalizedVoice(Buffer.from('RIFFxxxxWAVE'),'audio/wav'));
await assert.rejects(()=>normalizedVoice(Buffer.alloc(2_000_001),'audio/wav'));
await assert.rejects(()=>normalizedVoice(Buffer.from('OggSnotvalid'),'audio/mp4'));
const long=await sample(31,'wav','pcm_s16le');
await assert.rejects(()=>normalizedVoice(long,'audio/wav'),error=>{assert.match(JSON.stringify(error),/VOICE_TOO_LONG/);return true;});
assert.deepEqual(await readdir('/tmp'),before,'no recordings or decoder output are persisted to disk');
console.log('Real decoder verified: WebM, Ogg, MP4, WAV, duration, malformed and oversized audio, in-memory processing');
