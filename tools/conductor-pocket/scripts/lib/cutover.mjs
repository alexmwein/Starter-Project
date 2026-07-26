import {
  assertRootRemovedWithHandlersPreserved,
  pocketRootState,
} from '../../src/tailscale-config.mjs';
import {
  migrateToDedicatedOrigin,
  rotatePairing,
} from '../../src/config.mjs';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function waitForExpectedHealth(
  origin,
  {
    version,
    configRevision,
    fetchImpl = fetch,
    attempts = 60,
    delayMs = 500,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${origin}/api/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (
          body?.ok === true &&
          body.version === version &&
          (!configRevision || body.configRevision === configRevision)
        ) {
          return body;
        }
      }
    } catch {
      // DNS, certificate provisioning, or the replacement relay may still be starting.
    }
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  throw new Error(
    `Conductor Pocket ${version} did not become healthy at ${origin}`,
  );
}

export async function removeMainPocketRoot({
  mainCli,
  rpId,
  port,
  runCommand,
  requirePocket = false,
}) {
  const { stdout: beforeOutput } = await runCommand(mainCli, [
    'serve',
    'status',
    '--json',
  ]);
  const before = JSON.parse(beforeOutput || '{}');
  const state = pocketRootState(before, { rpId, port });
  if (state !== 'pocket') {
    if (requirePocket) {
      throw new Error(
        state === 'foreign'
          ? 'The main-node root belongs to another service'
          : 'The expected old Pocket root is not configured',
      );
    }
    return { removed: false, state, before, after: before };
  }

  await runCommand(mainCli, [
    'serve',
    '--yes',
    '--https=443',
    '--set-path=/',
    'off',
  ]);
  const { stdout: afterOutput } = await runCommand(mainCli, [
    'serve',
    'status',
    '--json',
  ]);
  const after = JSON.parse(afterOutput || '{}');
  assertRootRemovedWithHandlersPreserved(before, after, { rpId, port });
  return { removed: true, state, before, after };
}

export async function migrateRelayOrigin({
  oldConfig,
  dedicatedOrigin,
  save,
  restart,
  verify,
  removeOldRoot,
  now = Date.now(),
}) {
  const migrated = migrateToDedicatedOrigin(
    oldConfig,
    dedicatedOrigin,
    now,
  );
  let dedicatedVerified = false;
  try {
    await save(migrated.config);
    await restart(migrated.config);
    await verify(migrated.config.publicOrigin, migrated.config);
    dedicatedVerified = true;
    await removeOldRoot();
    return migrated;
  } catch (primaryError) {
    if (!dedicatedVerified) {
      try {
        await save(oldConfig);
        await restart(oldConfig);
        await verify(oldConfig.publicOrigin, oldConfig);
      } catch (rollbackError) {
        throw new AggregateError(
          [primaryError, rollbackError],
          `Dedicated-origin migration failed (${errorMessage(
            primaryError,
          )}); restoring the old relay also failed (${errorMessage(
            rollbackError,
          )})`,
        );
      }
    }
    throw primaryError;
  }
}

export async function resumeDedicatedOrigin({
  config,
  save,
  restart,
  verify,
  removeOldRoot,
  now = Date.now(),
}) {
  await verify(config.publicOrigin, config);
  const cleanup = await removeOldRoot();
  if (config.devices.length > 0) {
    return {
      config,
      pairingCode: null,
      cleanup,
    };
  }
  const rotated = rotatePairing(config, now);
  await save(rotated.config);
  await restart(rotated.config);
  await verify(rotated.config.publicOrigin, rotated.config);
  return {
    ...rotated,
    cleanup,
  };
}
