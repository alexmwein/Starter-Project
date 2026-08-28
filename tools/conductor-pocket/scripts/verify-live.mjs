// Post-deploy proof. Twice tonight the installer reported success while the
// LaunchAgent was left unregistered with a stale process holding the port, so
// the relay was dead and the phone saw 502 while everything looked fine. This
// checks what the phone actually experiences, and recovers the one failure mode
// that is safe to recover automatically.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { configRevision, loadConfig } from '../src/config.mjs';
import { APP_VERSION, SHELL_REVISION } from '../src/constants.mjs';
import { withOperationLock } from '../src/operation-lock.mjs';
import {
  recoverAttestedRelay,
  verifyPublicRelease,
} from './lib/live-verification.mjs';
import {
  RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS,
  assertRelayLaunchProfile,
  bootoutIfLoaded,
  RELAY_LABEL,
  RELAY_LAUNCH_AGENT_PATH,
  waitForLaunchdRemoval,
  waitForRelayShutdown,
} from './lib/sidecar.mjs';

const run = promisify(execFile);
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

async function recover(config) {
  await withOperationLock('recover the Pocket relay', async () => {
    await recoverAttestedRelay({
      configPath,
      port: config.port,
      attest: assertRelayLaunchProfile,
      bootout: () => bootoutIfLoaded(RELAY_LABEL),
      waitForRemoval: () =>
        waitForLaunchdRemoval(
          RELAY_LABEL,
          RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS,
        ),
      waitForShutdown: (options) => waitForRelayShutdown(options),
      bootstrap: () =>
        run('/bin/launchctl', [
          'bootstrap',
          `gui/${process.getuid()}`,
          RELAY_LAUNCH_AGENT_PATH,
        ]),
    });
  });
}

const config = await loadConfig(configPath);
const expected = {
  version: APP_VERSION,
  configRevision: configRevision(config),
  shellRevision: SHELL_REVISION,
};
let body = null;
for (let attempt = 1; attempt <= 12 && !body; attempt += 1) {
  body = await health(config.port);
  if (!body && attempt === 4) {
    process.stdout.write('relay not answering, recovering once\n');
    await recover(config);
  }
  if (!body) await new Promise((r) => setTimeout(r, 1_500));
}

const problems = [];
if (!body) problems.push(`relay is not answering on 127.0.0.1:${config.port}`);
else if (
  body.ok !== true ||
  body.version !== expected.version ||
  body.configRevision !== expected.configRevision ||
  body.shellRevision !== expected.shellRevision
) {
  problems.push(
    'loopback relay identity does not match this release',
  );
}
try {
  await verifyPublicRelease({
    origin: config.publicOrigin,
    expected: {
      version: APP_VERSION,
      configRevision: configRevision(config),
      shellRevision: SHELL_REVISION,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  problems.push(`public release proof failed: ${message}`);
}

if (problems.length) {
  for (const problem of problems) process.stderr.write(`FAIL ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  `live: shell ${SHELL_REVISION}, loopback and public release proof ok\n`,
);
