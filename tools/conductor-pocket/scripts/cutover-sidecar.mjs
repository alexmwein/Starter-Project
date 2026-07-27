import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  beginOriginRetirement,
  configRevision,
  getVerificationCode,
  loadConfig,
  originRetirementComplete,
  saveConfig,
} from '../src/config.mjs';
import { APP_VERSION } from '../src/constants.mjs';
import { withOperationLock } from '../src/operation-lock.mjs';
import {
  assertLockedSidecarPrefs,
  assertNoFunnel,
  assertPrivateServeStatus,
  assertSameTailnet,
  pocketRootState,
  runningTailscaleIdentity,
} from '../src/tailscale-config.mjs';
import {
  migrateRelayOrigin,
  removeMainPocketRoot,
  resumeDedicatedOrigin,
  waitForExpectedHealth,
} from './lib/cutover.mjs';
import {
  RELAY_LABEL,
  SIDECAR_DIRECTORY,
  assertSidecarLaunchProfile,
  assertSupportedStatusVersion,
  assertSupportedTailscaleVersion,
  formulaBinaries,
  mainTailscaleCli,
  readMainStatus,
  readSidecarPrefs,
  readSidecarStatus,
  run,
  runSidecar,
} from './lib/sidecar.mjs';

const configPath =
  process.env.CONDUCTOR_POCKET_CONFIG ||
  path.join(os.homedir(), '.config', 'conductor-pocket', 'config.json');

function pairingOutput(config, pairingCode) {
  if (!pairingCode) return '';
  const url = `${config.publicOrigin}/#pair=${encodeURIComponent(pairingCode)}`;
  return [
    '',
    'New pairing link (single use, expires in 15 minutes):',
    url,
    '',
    `Verification code shown on both devices: ${getVerificationCode(config)}`,
    '',
    'The old hostname, session, CSRF proof, and passkey are now invalid.',
  ].join('\n');
}

async function jsonSidecar(argumentsList) {
  const { stdout } = await runSidecar(argumentsList);
  return JSON.parse(stdout || '{}') || {};
}

async function restartRelay(config) {
  await run('/bin/launchctl', [
    'kickstart',
    '-k',
    `gui/${process.getuid()}/${RELAY_LABEL}`,
  ]);
  await waitForExpectedHealth(`http://127.0.0.1:${config.port}`, {
    version: APP_VERSION,
    configRevision: configRevision(config),
    attempts: 150,
    delayMs: 200,
  });
}

function sameAddress(left, right) {
  const rightAddresses = new Set(right.addresses);
  return left.addresses.some((address) => rightAddresses.has(address));
}

function remainingRetirementDevices(config) {
  const retired = new Set(config.originRetirement?.retiredDeviceIds || []);
  return (config.originRetirement?.requiredDeviceIds || []).filter(
    (id) => !retired.has(id),
  );
}

async function cutover() {
  process.umask(0o077);
  const { cli: sidecarCli, daemon: sidecarDaemon } = await formulaBinaries();
  await assertSupportedTailscaleVersion(sidecarCli);
  await assertSidecarLaunchProfile(sidecarDaemon);

  const config = await loadConfig(configPath);
  const loopbackOrigin = `http://127.0.0.1:${config.port}`;
  await waitForExpectedHealth(loopbackOrigin, {
    version: APP_VERSION,
    configRevision: configRevision(config),
    attempts: 5,
    delayMs: 200,
  });

  const sidecarDirectoryStat = await fs.stat(SIDECAR_DIRECTORY);
  if ((sidecarDirectoryStat.mode & 0o077) !== 0) {
    throw new Error('The dedicated Tailscale state directory is not private');
  }

  const sidecarStatus = await readSidecarStatus();
  assertSupportedStatusVersion(sidecarStatus);
  const sidecarIdentity = runningTailscaleIdentity(sidecarStatus);
  if (!/^conductor-pocket(?:-\d+)?\./.test(sidecarIdentity.dnsName)) {
    throw new Error(
      `Refusing unexpected dedicated-node hostname: ${sidecarIdentity.dnsName}`,
    );
  }
  assertLockedSidecarPrefs(await readSidecarPrefs());

  const mainCli = await mainTailscaleCli();
  await assertSupportedTailscaleVersion(mainCli);
  const mainStatus = await readMainStatus();
  assertSupportedStatusVersion(mainStatus);
  assertSameTailnet(sidecarStatus, mainStatus);
  const mainIdentity = runningTailscaleIdentity(mainStatus);
  if (
    sidecarIdentity.dnsName === mainIdentity.dnsName ||
    sameAddress(sidecarIdentity, mainIdentity)
  ) {
    throw new Error('The dedicated node is not isolated from the Mac Tailscale node');
  }

  const target = `http://127.0.0.1:${config.port}`;
  const beforeSidecarServe = await jsonSidecar([
    'serve',
    'status',
    '--json',
  ]).catch(() => ({}));
  if (Object.keys(beforeSidecarServe).length === 0) {
    await runSidecar(['serve', '--bg', '--yes', target]);
  }
  const sidecarServe = await jsonSidecar(['serve', 'status', '--json']);
  assertPrivateServeStatus(sidecarServe, {
    rpId: sidecarIdentity.dnsName,
    port: config.port,
  });
  assertNoFunnel(await jsonSidecar(['funnel', 'status', '--json']));

  const dedicatedOrigin = `https://${sidecarIdentity.dnsName}`;
  const alreadyDedicated =
    config.publicOrigin === dedicatedOrigin &&
    config.rpId === sidecarIdentity.dnsName;
  await waitForExpectedHealth(config.publicOrigin, {
    version: APP_VERSION,
    configRevision: configRevision(config),
    attempts: 5,
    delayMs: 200,
  });

  if (!alreadyDedicated && !config.originRetirement) {
    if (
      config.devices.length === 0 &&
      !process.argv.includes('--attest-no-old-devices')
    ) {
      throw new Error(
        'The legacy config has no retirement record and no paired devices, so Pocket cannot prove whether an old client already revoked itself. If this origin was never paired or you independently erased every old Pocket copy, rerun with --attest-no-old-devices.',
      );
    }
    const prepared = beginOriginRetirement(config);
    await saveConfig(configPath, prepared);
    await restartRelay(prepared);
    await waitForExpectedHealth(prepared.publicOrigin, {
      version: APP_VERSION,
      configRevision: configRevision(prepared),
    });
    process.stdout.write(`Old-origin retirement is now enforced.

Remaining phones: ${prepared.originRetirement.requiredDeviceIds.length}

On each old iPhone:
1. Fully close and reopen Conductor Pocket while online.
2. In Security & Devices, confirm it says client ${APP_VERSION}.
3. Tap Sign out for that same phone. Pocket erases its local data before the Mac accepts retirement.
4. Remove the old Home Screen icon.

Then rerun: npm run sidecar:cutover
`);
    return;
  }

  if (!alreadyDedicated && !originRetirementComplete(config)) {
    const remaining = remainingRetirementDevices(config);
    process.stdout.write(`Cutover remains locked.

${remaining.length} old phone${remaining.length === 1 ? '' : 's'} still must self-sign-out with client ${APP_VERSION}.
Remote revocation cannot satisfy this check.

After every old Home Screen copy is removed, rerun: npm run sidecar:cutover
`);
    return;
  }

  const removeOldRoot = ({ requirePocket = false, rpId } = {}) =>
    removeMainPocketRoot({
      mainCli,
      rpId: rpId || mainIdentity.dnsName,
      port: config.port,
      runCommand: run,
      requirePocket,
    });

  if (!alreadyDedicated) {
    const { stdout: mainServeOutput } = await run(mainCli, [
      'serve',
      'status',
      '--json',
    ]);
    const mainServe = JSON.parse(mainServeOutput || '{}');
    if (
      pocketRootState(mainServe, {
        rpId: config.rpId,
        port: config.port,
      }) !== 'pocket'
    ) {
      throw new Error('The main Tailscale node no longer has the exact old Pocket root');
    }
    const migrated = await migrateRelayOrigin({
      oldConfig: config,
      dedicatedOrigin,
      save: (nextConfig) => saveConfig(configPath, nextConfig),
      restart: restartRelay,
      verify: (origin, expectedConfig) =>
        waitForExpectedHealth(origin, {
          version: APP_VERSION,
          configRevision: configRevision(expectedConfig),
        }),
      removeOldRoot: () =>
        removeOldRoot({ requirePocket: true, rpId: config.rpId }),
    });

    process.stdout.write(
      `Conductor Pocket moved to its dedicated private origin.

Dedicated node: ${sidecarIdentity.dnsName}
Dedicated addresses: ${sidecarIdentity.addresses.join(', ')}
Old Pocket root removed: https://${config.rpId}/
Unrelated main-node handlers: preserved exactly
Funnel: disabled
${pairingOutput(migrated.config, migrated.pairingCode)}
`,
    );
    return;
  }

  const resumed = await resumeDedicatedOrigin({
    config,
    save: (nextConfig) => saveConfig(configPath, nextConfig),
    restart: restartRelay,
    verify: (origin, expectedConfig) =>
      waitForExpectedHealth(origin, {
        version: APP_VERSION,
        configRevision: configRevision(expectedConfig),
      }),
    removeOldRoot: () => removeOldRoot(),
  });
  const rootState = resumed.cleanup.removed
    ? 'removed'
    : resumed.cleanup.state === 'absent'
      ? 'already absent'
      : 'foreign root preserved';
  process.stdout.write(`Conductor Pocket dedicated ingress is ready.

Dedicated node: ${sidecarIdentity.dnsName}
Dedicated addresses: ${sidecarIdentity.addresses.join(', ')}
Exclusive proxy: ${target}
Old Pocket root: ${rootState}
Funnel: disabled
${pairingOutput(resumed.config, resumed.pairingCode)}
`);
}

withOperationLock('cut over to the dedicated Pocket origin', cutover).catch(
  (error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
