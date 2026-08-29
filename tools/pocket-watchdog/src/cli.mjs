#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateSnapshot, planNotifications } from './checks.mjs';
import { deliverNotifications } from './notifications.mjs';
import { collectSnapshot } from './system.mjs';

process.umask(0o077);

function argumentsFor(values) {
  const result = { command: values[0] || 'run', dryRun: false };
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === '--dry-run') result.dryRun = true;
    else if (values[index] === '--config') result.configPath = values[++index];
    else if (values[index] === '--state') result.statePath = values[++index];
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  return result;
}

async function loadState(statePath) {
  try {
    const value = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return value?.version === 1 && value.issues && typeof value.issues === 'object'
      ? value
      : { version: 1, issues: {} };
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return { version: 1, issues: {} };
    }
    throw error;
  }
}

async function writeState(statePath, value) {
  const directory = path.dirname(statePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = `${statePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    await fs.rename(temporary, statePath);
    await fs.chmod(statePath, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function printReport(report) {
  for (const entry of report.statuses) {
    console.log(`[${entry.ok ? 'OK' : 'CHECK'}] ${entry.check}: ${entry.detail}`);
  }
  if (report.issues.length === 0) {
    console.log('Pocket watchdog: GREEN');
    return;
  }
  console.log(`Pocket watchdog: ${report.issues.length} issue${report.issues.length === 1 ? '' : 's'}`);
  for (const entry of report.issues) {
    console.log(`[${entry.severity.toUpperCase()}] ${entry.message}`);
  }
}

export async function main(values = process.argv.slice(2)) {
  const options = argumentsFor(values);
  if (!['run', 'doctor'].includes(options.command)) {
    throw new Error('Usage: pocket-watchdog [run|doctor] [--dry-run]');
  }
  const statePath = options.statePath || path.join(
    os.homedir(),
    '.config',
    'pocket-watchdog',
    'state.json',
  );
  let report;
  try {
    const snapshot = await collectSnapshot({ configPath: options.configPath });
    report = evaluateSnapshot(snapshot);
  } catch {
    report = {
      statuses: [{ check: 'Watchdog preflight', ok: false, detail: 'collector failed' }],
      issues: [{
        id: 'watchdog:collector',
        severity: 'critical',
        message: 'Pocket: the watchdog could not read its local preflight inputs. Run pocket-doctor on the Mac, then repair the reported config or file access.',
        recovery: 'Pocket recovered: the watchdog can read all local preflight inputs again.',
      }],
      unresolvedIssuePrefixes: [
        'disk:',
        'relay:',
        'session:',
        'sidebar:',
        'codex:',
        'load:',
      ],
    };
  }
  printReport(report);
  if (options.command === 'doctor' || options.dryRun) {
    if (options.dryRun && report.issues.length > 0) {
      console.log('Alerts suppressed for this dry run.');
    }
    return report.issues.length === 0 ? 0 : 1;
  }
  const state = await loadState(statePath);
  const plan = planNotifications(state, report.issues, Date.now(), {
    unresolvedIssuePrefixes: report.unresolvedIssuePrefixes,
  });
  await deliverNotifications(plan.notifications);
  await writeState(statePath, plan.nextState);
  console.log(`Notifications sent: ${plan.notifications.length}`);
  return report.issues.length === 0 ? 0 : 1;
}

const invokedPath = await fs.realpath(process.argv[1] || '').catch(() => '');
const modulePath = await fs.realpath(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`Pocket watchdog failed: ${error.message}`);
    process.exitCode = 2;
  }
}
