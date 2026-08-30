import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { AccessibilityTransport } from '../src/accessibility.mjs';
import { createConfig } from '../src/config.mjs';
import { createPocketServer } from '../src/server.mjs';

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

test('shutdown seals mutations and gates exit on every accepted request', async () => {
  const source = await fs.readFile(
    new URL('../src/cli.mjs', import.meta.url),
    'utf8',
  );
  const shutdownStart = source.indexOf('const shutdown = () => {');
  assert.ok(shutdownStart >= 0);
  const block = source.slice(shutdownStart, shutdownStart + 1700);
  // Both gates, checked in one place, so a phone that abandoned its
  // connection early cannot let the relay exit under a live automation.
  assert.match(
    block,
    /if \(!serverClosed \|\| !transportDrained \|\| !requestsDrained\) return/,
  );
  assert.match(block, /server\.beginPocketShutdown\(\);/);
  assert.match(
    block,
    /server\.closePocketEventStreams\?\.\(\);\s*server\.close\(/,
  );
  assert.match(block, /transport\s*\n?\s*\.drain\(SHUTDOWN_DRAIN_MS\)/);
  assert.match(
    block,
    /server\s*\n?\s*\.drainPocketRequests\(SHUTDOWN_DRAIN_MS\)/,
  );
  // The drain budget covers the 45s automation timeout plus confirmation,
  // and the force deadline sits above the drain, below launchd's SIGKILL.
  assert.match(source, /const SHUTDOWN_DRAIN_MS = 55_000/);
  assert.match(source, /const SHUTDOWN_FORCE_EXIT_MS = 60_000/);
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

test('shutdown drains an active send and rejects a queued tab before it can act', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  let releaseTransport;
  let transportStartedResolve;
  const transportStarted = new Promise((resolve) => {
    transportStartedResolve = resolve;
  });
  const transportGate = new Promise((resolve) => {
    releaseTransport = resolve;
  });
  let closeTabCalls = 0;
  const server = createPocketServer({
    configStore: { value: config },
    security: {
      assertOrigin() {},
      session() {
        return {
          device: { id: 'shutdown-device' },
          csrfToken: 'shutdown-csrf',
          unlocked: true,
        };
      },
    },
    database: {
      getSessionRoute() {
        return {
          id: 'shutdown-session',
          repositoryName: 'Starter-Project',
          workspaceId: 'shutdown-workspace-id',
          workspaceName: 'Shutdown',
          workspacePath: process.cwd(),
          sandboxProvider: null,
          title: 'Drain test',
          titleOrdinal: 1,
        };
      },
      getSessionMessageCursor() {
        return 0;
      },
      listUserMessagesAfter() {
        return [];
      },
      listLocalWorkspacePaths() {
        return [];
      },
    },
    watcher: {
      subscribe() {
        return () => {};
      },
      stop() {},
    },
    attachmentManager: {
      async sweepWorkspaces() {},
      async resolveForSend() {
        return [];
      },
      stop() {},
    },
    transport: {
      async send() {
        transportStartedResolve();
        await transportGate;
        return {
          ok: false,
          code: 'draft_conflict',
          safeToRetry: true,
          draftBase64: Buffer.from('Mac draft').toString('base64'),
        };
      },
      async closeTab() {
        closeTabCalls += 1;
        return { ok: true, code: 'tab_closed' };
      },
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(
    () =>
      new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(resolve);
      }),
  );
  const port = server.address().port;
  const responsePromise = new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ message: 'wait for me' }));
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/sessions/shutdown-session/messages',
        method: 'POST',
        headers: {
          Host: '127.0.0.1:4317',
          Origin: 'http://127.0.0.1:4317',
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-CSRF-Token': 'shutdown-csrf',
          'Idempotency-Key': 'shutdown-drain-test-key',
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end(body);
  });

  await transportStarted;
  const tabResponsePromise = new Promise((resolve, reject) => {
    const body = Buffer.from(
      JSON.stringify({ action: 'close', confirm: true }),
    );
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/sessions/shutdown-session/tab',
        method: 'POST',
        headers: {
          Host: '127.0.0.1:4317',
          Origin: 'http://127.0.0.1:4317',
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-CSRF-Token': 'shutdown-csrf',
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end(body);
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  server.beginPocketShutdown();
  assert.equal(await server.drainPocketRequests(5), false);
  releaseTransport();
  assert.equal(await responsePromise, 409);
  assert.equal(await tabResponsePromise, 503);
  assert.equal(closeTabCalls, 0);
  assert.equal(await server.drainPocketRequests(1_000), true);
});

test('the LaunchAgent tells launchd to outlast the force deadline', async () => {
  const source = await fs.readFile(
    new URL('../scripts/install-relay.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /<key>ExitTimeOut<\/key>[\s\S]{0,400}<integer>65<\/integer>/,
  );
});

test('every relay removal wait outlasts the protected shutdown window', async () => {
  const [sidecar, installer, verifier, cutover] = await Promise.all([
    fs.readFile(new URL('../scripts/lib/sidecar.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/install-relay.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/verify-live.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/cutover-sidecar.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(
    sidecar,
    /export const RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS = 70_000;/,
  );
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
  assert.match(source, /const \{ stdout \} = await pending/);
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
