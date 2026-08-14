// Post-deploy proof. Twice tonight the installer reported success while the
// LaunchAgent was left unregistered with a stale process holding the port, so
// the relay was dead and the phone saw 502 while everything looked fine. This
// checks what the phone actually experiences, and recovers the one failure mode
// that is safe to recover automatically.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { SHELL_REVISION } from '../src/constants.mjs';

const run = promisify(execFile);
const label = 'com.ovo.conductor-pocket';
const configPath =
  process.env.CONDUCTOR_POCKET_CONFIG ||
  path.join(os.homedir(), '.config', 'conductor-pocket', 'config.json');

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Host: `127.0.0.1:${port}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function reachable(origin) {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(10_000) });
    return response.status;
  } catch {
    return 0;
  }
}

// A stale process from a previous runtime can hold the port and make bootstrap
// fail with an I/O error, which is why a plain kickstart did not recover it.
async function recover() {
  await run('/usr/bin/pkill', ['-f', 'conductor-pocket/runtimes.*cli.mjs serve']).catch(() => {});
  await new Promise((r) => setTimeout(r, 1_500));
  await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]).catch(() => {});
  await new Promise((r) => setTimeout(r, 1_500));
  await run('/bin/launchctl', [
    'bootstrap',
    `gui/${process.getuid()}`,
    path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
  ]).catch(() => {});
}

const config = await loadConfig(configPath);
let body = null;
for (let attempt = 1; attempt <= 12 && !body; attempt += 1) {
  body = await health(config.port);
  if (!body && attempt === 4) {
    process.stdout.write('relay not answering, recovering once\n');
    await recover();
  }
  if (!body) await new Promise((r) => setTimeout(r, 1_500));
}

const problems = [];
if (!body) problems.push(`relay is not answering on 127.0.0.1:${config.port}`);
else if (body.shellRevision !== SHELL_REVISION) {
  problems.push(
    `relay serves shell ${body.shellRevision}, source expects ${SHELL_REVISION}`,
  );
}
const status = await reachable(config.publicOrigin);
if (status !== 200) problems.push(`${config.publicOrigin} returned ${status}`);

// The phone caches assets by the token in their URL, so a stale token means it
// can never load new code no matter how many times this deploys.
const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
if (!html.includes(SHELL_REVISION)) {
  problems.push('index.html does not reference the current shell revision');
}

if (problems.length) {
  for (const problem of problems) process.stderr.write(`FAIL ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  `live: shell ${SHELL_REVISION}, loopback ok, ${config.publicOrigin} 200\n`,
);
