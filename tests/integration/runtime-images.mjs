import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { verifyRuntimeImages } from '../../scripts/release.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const compose=args => execFileSync('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,
  '-f','infra/compose/compose.yaml',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const config=JSON.parse(compose(['config','--format','json']));
const images=Object.fromEntries(Object.entries({postgres:'db',redis:'redis',api:'api',worker:'worker',web:'web'})
  .map(([name,service]) => [name,config.services[service].image]));
const containerIdFor=service => compose(['ps','--status','running','-q',service]);
await verifyRuntimeImages(images,containerIdFor);
await assert.rejects(verifyRuntimeImages({...images,postgres:images.redis},containerIdFor),/RUNNING_IMAGE_MISMATCH/);
await assert.rejects(verifyRuntimeImages(images,() => ''),/SINGLE_RUNNING_CONTAINER_REQUIRED/);
await assert.rejects(verifyRuntimeImages(images,() => `${'a'.repeat(64)}\n${'b'.repeat(64)}`),/SINGLE_RUNNING_CONTAINER_REQUIRED/);
console.log('Runtime image verification passed for five actual CI containers; wrong image, missing and multiple containers rejected');
