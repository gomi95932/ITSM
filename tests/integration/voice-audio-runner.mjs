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
    ...(format==='mp4'?['-movflags','frag_keyframe+empty_moov']:[]),'-f',format==='wav'?'s16le':format,'pipe:1'],{encoding:'buffer',maxBuffer:4_000_000,timeout:10000});
  if(format==='wav'){
    // A pipe cannot finalize RIFF lengths; wrap the known mono PCM fixture in a complete WAV file.
    assert.equal(stdout.length,seconds*16000*2);
    const header=Buffer.from('524946460000000057415645666d74201000000001000100803e0000007d0000020010006461746100000000','hex');
    header.writeUInt32LE(stdout.length+36,4);header.writeUInt32LE(stdout.length,40);
    return Buffer.concat([header,stdout]);
  }
  return stdout;
}
for(const [format,codec,mime] of [['wav','pcm_s16le','audio/wav'],['webm','libopus','audio/webm'],['ogg','libopus','audio/ogg'],['mp4','aac','audio/mp4']]){
  console.log(`Decoding generated ${mime} fixture`);
  const result=await normalizedVoice(await sample(1,format,codec),mime);
  assert.equal(result.toString('ascii',0,4),'RIFF');assert.equal(result.readUInt32LE(24),16000);
  assert.equal(result.readUInt16LE(22),1);assert.ok(result.length>30000&&result.length<34000);
  console.log(`Verified ${mime}: ${result.length-44} PCM bytes`);
}
await assert.rejects(()=>normalizedVoice(Buffer.from('not real audio'),'audio/webm'));
await assert.rejects(()=>normalizedVoice(Buffer.from('RIFFxxxxWAVE'),'audio/wav'));
await assert.rejects(()=>normalizedVoice(Buffer.alloc(2_000_001),'audio/wav'));
await assert.rejects(()=>normalizedVoice(Buffer.from('OggSnotvalid'),'audio/mp4'));
const long=await sample(31,'wav','pcm_s16le');
await assert.rejects(()=>normalizedVoice(long,'audio/wav'),error=>{assert.match(JSON.stringify(error),/VOICE_TOO_LONG/);return true;});
assert.deepEqual(await readdir('/tmp'),before,'no recordings or decoder output are persisted to disk');
console.log('Real decoder verified: WebM, Ogg, MP4, WAV, duration, malformed and oversized audio, in-memory processing');
