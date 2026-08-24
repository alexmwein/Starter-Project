import fs from 'node:fs/promises';
import path from 'node:path';

const STABLE_RUNTIME_NAME =
  /^runtime-[0-9A-Za-z][0-9A-Za-z._-]*-(\d{13})-(\d+)$/;

function parsedRuntimeName(name) {
  const match = STABLE_RUNTIME_NAME.exec(name);
  if (!match) return null;
  return {
    name,
    timestamp: Number.parseInt(match[1], 10),
    processId: Number.parseInt(match[2], 10),
  };
}

async function realDirectRuntime(runtimeParent, runtimePath) {
  const requestedPath = path.resolve(runtimePath);
  const parsed = parsedRuntimeName(path.basename(requestedPath));
  if (!parsed) return null;
  let stat;
  let realPath;
  try {
    [stat, realPath] = await Promise.all([
      fs.lstat(requestedPath),
      fs.realpath(requestedPath),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    path.dirname(realPath) !== runtimeParent ||
    path.basename(realPath) !== path.basename(requestedPath)
  ) {
    return null;
  }
  return { ...parsed, path: realPath };
}

async function realRuntimeRoot(runtimeParent) {
  const expectedParent = path.resolve(runtimeParent);
  const parentStat = await fs.lstat(expectedParent);
  const realParent = await fs.realpath(expectedParent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error('runtime root must be a real directory');
  }
  return realParent;
}

export async function runtimeForLoadedLaunchdJob(
  runtimeParent,
  argumentsList,
  { configPath, workingDirectory, access = fs.access } = {},
) {
  if (
    !Array.isArray(argumentsList) ||
    argumentsList.length !== 6 ||
    !path.isAbsolute(argumentsList[0]) ||
    argumentsList[1] !== '--no-warnings=ExperimentalWarning' ||
    !path.isAbsolute(argumentsList[2]) ||
    argumentsList[3] !== 'serve' ||
    argumentsList[4] !== '--config' ||
    typeof configPath !== 'string' ||
    argumentsList[5] !== configPath
  ) {
    throw new Error('loaded relay arguments could not prove a rollback runtime');
  }
  try {
    await access(argumentsList[0], fs.constants.X_OK);
  } catch {
    throw new Error('loaded relay interpreter must remain executable');
  }
  const realParent = await realRuntimeRoot(runtimeParent);
  const cliPath = argumentsList[2];
  const requestedRuntime = path.dirname(path.dirname(cliPath));
  const runtime = await realDirectRuntime(realParent, requestedRuntime);
  if (!runtime) {
    throw new Error('loaded rollback runtime must be a real direct child');
  }
  const workingRuntime =
    typeof workingDirectory === 'string'
      ? await realDirectRuntime(realParent, workingDirectory)
      : null;
  if (!workingRuntime || workingRuntime.path !== runtime.path) {
    throw new Error(
      'working directory must match the loaded rollback runtime',
    );
  }
  const [realCliPath, cliStat] = await Promise.all([
    fs.realpath(cliPath),
    fs.stat(cliPath),
  ]);
  if (
    !cliStat.isFile() ||
    realCliPath !== path.join(runtime.path, 'src', 'cli.mjs')
  ) {
    throw new Error('loaded relay CLI must belong to the rollback runtime');
  }
  return runtime.path;
}

export function rollbackPlistForLoadedRelay({
  previousJobWasLoaded,
  previousLoadedPlist,
  previousPlist,
}) {
  if (previousJobWasLoaded) {
    if (typeof previousLoadedPlist !== 'string' || !previousLoadedPlist) {
      throw new Error('validated loaded relay profile is unavailable for rollback');
    }
    return previousLoadedPlist;
  }
  return previousPlist;
}

export async function pruneStableRuntimes(
  runtimeParent,
  activeRuntime,
  { retainPrior = 1, rollbackRuntime = null } = {},
) {
  if (!Number.isSafeInteger(retainPrior) || retainPrior < 0) {
    throw new TypeError('retainPrior must be a nonnegative integer');
  }
  const realParent = await realRuntimeRoot(runtimeParent);
  const active = await realDirectRuntime(realParent, activeRuntime);
  if (!active) {
    throw new Error('active runtime must be a real direct child of the runtime root');
  }

  const entries = await fs.readdir(realParent, { withFileTypes: true });
  const runtimes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const runtime = await realDirectRuntime(
      realParent,
      path.join(realParent, entry.name),
    );
    if (runtime) runtimes.push(runtime);
  }
  if (!runtimes.some((runtime) => runtime.path === active.path)) {
    throw new Error('active runtime disappeared before retention could run');
  }

  let prior = runtimes
    .filter((runtime) => runtime.path !== active.path)
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        right.processId - left.processId ||
        right.name.localeCompare(left.name),
    );
  const retained = [];
  if (rollbackRuntime != null) {
    if (retainPrior < 1) {
      throw new Error('configured rollback requires one retained prior runtime');
    }
    const rollback = await realDirectRuntime(realParent, rollbackRuntime);
    if (!rollback || rollback.path === active.path) {
      throw new Error('rollback runtime must be a real prior direct child');
    }
    if (!prior.some((runtime) => runtime.path === rollback.path)) {
      throw new Error('rollback runtime disappeared before retention could run');
    }
    retained.push(rollback);
    prior = prior.filter((runtime) => runtime.path !== rollback.path);
  }
  retained.push(...prior.slice(0, retainPrior - retained.length));
  const retainedPaths = new Set(retained.map((runtime) => runtime.path));
  const candidates = prior
    .filter((runtime) => !retainedPaths.has(runtime.path))
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        left.processId - right.processId ||
        left.name.localeCompare(right.name),
    );
  const removed = [];
  for (const candidate of candidates) {
    const verified = await realDirectRuntime(realParent, candidate.path);
    if (!verified) continue;
    await fs.rm(verified.path, { recursive: true, force: false });
    removed.push(verified.path);
  }
  return {
    active: active.path,
    retained: retained.map((runtime) => runtime.path),
    removed,
  };
}
