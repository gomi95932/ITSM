import { exec, execSync, execFile } from 'node:child_process';
import { exec as execute } from 'child_process';
import * as childProcess from 'node:child_process';
const commonProcess = require('child_process');

function unsafe(source: string, command: string) {
  // ruleid: itsm-no-dynamic-code
  eval(source);
  // ruleid: itsm-no-dynamic-code
  new Function(source);
  // ruleid: itsm-no-shell-command-strings
  exec(command);
  // ruleid: itsm-no-shell-command-strings
  execSync(command);
  // ruleid: itsm-no-shell-command-strings
  execute(command);
  // ruleid: itsm-no-shell-command-strings
  childProcess.exec(command);
  // ruleid: itsm-no-shell-command-strings
  commonProcess.execSync(command);
  // ruleid: itsm-no-disabled-tls
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  // ruleid: itsm-no-disabled-tls
  const insecureTls = { rejectUnauthorized: false };
  // ruleid: itsm-no-shell-option
  const shell = { shell: true };
  return { insecureTls, shell };
}

function safe(source: string, filename: string) {
  // ok: itsm-no-dynamic-code
  const parsed = JSON.parse(source);
  // ok: itsm-no-shell-command-strings
  execFile('git', ['show', filename]);
  // ok: itsm-no-shell-command-strings
  const match = /^ticket-(\d+)$/.exec(filename);
  // ok: itsm-no-disabled-tls
  const tls = { rejectUnauthorized: true };
  // ok: itsm-no-shell-option
  const options = { shell: false };
  return { parsed, match, tls, options };
}
