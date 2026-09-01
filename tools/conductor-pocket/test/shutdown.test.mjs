import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { AccessibilityTransport } from '../src/accessibility.mjs';
import {
  RELAY_EXIT_TIMEOUT_SECONDS,
  RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS,
  SHUTDOWN_DRAIN_MS,
  SHUTDOWN_FORCE_EXIT_MS,
} from '../src/timing.mjs';

// A dying relay must never orphan an osascript child mid-type: the child
// survives the parent, finishes the send, and nobody is left to record it.
// These locks pin every link of the chain that prevents that: the transport
// tracks and can kill its child, shutdown gates exit on both the server
// closing and the transport draining, the drain budget covers the automation
// worst case, and launchd is told to wait longer than the force deadline.

test('an idle transport drains immediately and has nothing to kill', async () => {
  const transport = new AccessibilityTransport();
  assert.equal(transport.busy, false);
  assert.equal(await transport.drain(1), true);
  assert.equal(transport.killCurrentAutomation(), false);
});

test('shutdown gates exit on both server close and transport drain, and kills the child on every forced path', async () => {
  const source = await fs.readFile(
    new URL('../src/cli.mjs', import.meta.url),
    'utf8',
  );
  const shutdownStart = source.indexOf('const shutdown = () => {');
  assert.ok(shutdownStart >= 0);
  const block = source.slice(shutdownStart, shutdownStart + 1400);
  // Both gates, checked in one place, so a phone that abandoned its
  // connection early cannot let the relay exit under a live automation.
  assert.match(block, /if \(!serverClosed \|\| !transportDrained\) return/);
  assert.match(
    block,
    /server\.closePocketEventStreams\?\.\(\);\s*server\.close\(/,
  );
  assert.match(block, /transport\s*\n?\s*\.drain\(SHUTDOWN_DRAIN_MS\)/);
  // The drain budget covers the 45s automation timeout plus confirmation,
  // and the force deadline sits above the drain, below launchd's SIGKILL.
  assert.equal(SHUTDOWN_DRAIN_MS, 85_000);
  assert.equal(SHUTDOWN_FORCE_EXIT_MS, 90_000);
  assert.match(source, /from '.\/timing\.mjs'/);
  // Every path that gives up on the drain kills the child first.
  const forceExits = block.match(/killCurrentAutomation\(\)/g) || [];
  assert.ok(forceExits.length >= 3);
  assert.match(
    block,
    /setTimeout\(\(\) => \{\s*transport\.killCurrentAutomation\(\);\s*process\.exit\(1\);/,
  );
  // The old flat 5s force-exit, which died mid-send, must not come back.
  assert.doesNotMatch(block, /5_000/);
});

test('the LaunchAgent tells launchd to outlast the force deadline', async () => {
  const source = await fs.readFile(
    new URL('../scripts/install-relay.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /<key>ExitTimeOut<\/key>[\s\S]{0,400}<integer>\$\{RELAY_EXIT_TIMEOUT_SECONDS\}<\/integer>/,
  );
  assert.equal(RELAY_EXIT_TIMEOUT_SECONDS, 95);
});

test('every relay removal wait outlasts the protected shutdown window', async () => {
  const [sidecar, installer, verifier, cutover] = await Promise.all([
    fs.readFile(new URL('../scripts/lib/sidecar.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/install-relay.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/verify-live.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/cutover-sidecar.mjs', import.meta.url), 'utf8'),
  ]);
  assert.equal(RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS, 100_000);
  assert.match(sidecar, /from '..\/..\/src\/timing\.mjs'/);
  assert.equal(
    (
      installer.match(
        /waitForLaunchdRemoval\(label, RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS\)/g,
      ) || []
    ).length,
    2,
  );
  assert.match(
    verifier,
    /waitForLaunchdRemoval\(\s*RELAY_LABEL,\s*RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS,?\s*\)/,
  );
  assert.match(
    cutover,
    /waitForLaunchdRemoval\(\s*RELAY_LABEL,\s*RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS,?\s*\)/,
  );
});

test('the transport records its child while a run is in flight', async () => {
  const source = await fs.readFile(
    new URL('../src/accessibility.mjs', import.meta.url),
    'utf8',
  );
  // A SET of children, not one slot. doctor() runs off the queue by design, so
  // two runs overlap; with a single slot the fast doctor run cleared the field
  // while a 45s send was still typing, and the killer then found nothing and
  // orphaned exactly the child it exists to kill.
  assert.match(source, /#currentChildren = new Set\(\)/);
  assert.match(source, /runChild = pending\.child;/);
  assert.match(source, /this\.#currentChildren\.add\(runChild\)/);
  assert.match(
    source,
    /const \[\{ stdout \}\] = await Promise\.all\(\[pending, authorization\]\)/,
  );
  // The finally block removes only THIS run's child, so a settled run cannot be
  // mistaken for an in-flight one and a concurrent run is not un-tracked.
  assert.match(
    source,
    /finally \{\s*this\.#busy -= 1;\s*if \(runChild\) this\.#currentChildren\.delete\(runChild\);\s*\}/,
  );
  // drain must observe #busy, which counts every run including off-queue ones,
  // rather than a queue tail that can be reassigned or bypassed.
  const drainBody = source.slice(
    source.indexOf('drain(budgetMs) {'),
    source.indexOf('killCurrentAutomation()'),
  );
  assert.match(drainBody, /this\.#busy === 0/);
  assert.doesNotMatch(
    drainBody,
    /this\.#queue\.then/,
    'drain must not resolve on a captured queue tail',
  );
});

test('the transport actually runs, which a source-text assertion cannot prove', async () => {
  // The assertions above read accessibility.mjs as TEXT. That is why a change
  // to the child tracking that threw ReferenceError on every single send left
  // this whole file green. This one executes the real module against a target
  // that is guaranteed absent, so it exercises #run end to end (including the
  // finally block that untracks the child) without touching Conductor.
  const { AccessibilityTransport } = await import('../src/accessibility.mjs');
  const transport = new AccessibilityTransport();
  const result = await transport.send({
    workspaceName: `pocket-test-absent-${process.pid}`,
    sessionTitle: `pocket-test-absent-${process.pid}`,
    sessionOrdinal: 1,
    message: 'shutdown tracking smoke test',
    timeoutMs: 20_000,
  });
  // Any structured outcome proves #run completed. What must NOT happen is an
  // exception escaping, which is exactly the regression this catches.
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.code, 'string');
  assert.equal(result.ok, false);
  // The finally block must have untracked the child, so the transport reports
  // idle and drain resolves true rather than hanging on a stale tail.
  assert.equal(transport.busy, false);
  assert.equal(await transport.drain(1_000), true);
})
