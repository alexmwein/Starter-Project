import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = new URL('../public/session-lifecycle.js', import.meta.url);

async function lifecycleModule() {
  const source = await fs.readFile(moduleUrl, 'utf8').catch(() => '');
  assert.match(source, /export function connectionLifecycleState/);
  return import(moduleUrl);
}

test('connection lifecycle keeps unreachable, unauthenticated, and authenticated distinct', async () => {
  const { connectionLifecycleState } = await lifecycleModule();

  assert.equal(
    connectionLifecycleState({ relayReachable: false, authenticated: false }),
    'unreachable',
  );
  assert.equal(
    connectionLifecycleState({ relayReachable: true, authenticated: false }),
    'unauthenticated',
  );
  assert.equal(
    connectionLifecycleState({ relayReachable: true, authenticated: true }),
    'authenticated',
  );
});

test('expired authentication errors select Face ID instead of network recovery', async () => {
  const { bootstrapFailureState } = await lifecycleModule();

  for (const code of ['authentication_required', 'device_session_expired']) {
    assert.deepEqual(
      bootstrapFailureState({ status: 401, code }),
      {
        state: 'unauthenticated',
        title: 'Session expired',
        body: 'Unlock with Face ID to reconnect this iPhone.',
        action: 'Unlock with Face ID',
      },
    );
  }
  assert.equal(
    bootstrapFailureState({ status: 503, code: 'relay_unavailable' }).state,
    'unreachable',
  );
});

test('session notice warns inside five days and clears after renewal', async () => {
  const { sessionExpiryNotice } = await lifecycleModule();
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const near = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString();
  const far = new Date(now + 20 * 24 * 60 * 60 * 1000).toISOString();

  assert.deepEqual(
    sessionExpiryNotice({
      now,
      device: { trustedUntil: near, sessionExpiresAt: far },
    }),
    {
      daysRemaining: 2,
      text: 'This iPhone session expires in 2 days. Unlock with Face ID before then.',
    },
  );
  assert.equal(
    sessionExpiryNotice({
      now,
      device: { trustedUntil: far, sessionExpiresAt: far },
    }),
    null,
  );
});

test('phone UI gives an unauthenticated relay a Face ID recovery path and renders the warning', async () => {
  const application = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const stylesheet = await fs.readFile(
    new URL('../public/app.css', import.meta.url),
    'utf8',
  );

  assert.match(application, /function renderExpiredSession\(/);
  assert.match(application, /title: 'Session expired'/);
  assert.match(application, /text: 'Unlock with Face ID'/);
  assert.match(application, /request\('\/api\/auth\/recover\/options'/);
  assert.match(application, /request\('\/api\/auth\/recover\/verify'/);
  assert.match(application, /className: 'session-expiry-notice'/);
  assert.match(application, /state\.auth = \{ \.\.\.state\.auth, \.\.\.result \}/);
  assert.match(stylesheet, /\.session-expiry-notice \{/);
});

test('server exposes the bounded Face ID recovery endpoints', async () => {
  const server = await fs.readFile(
    new URL('../src/server.mjs', import.meta.url),
    'utf8',
  );

  assert.match(server, /\/api\/auth\/recover\/options/);
  assert.match(server, /security\.recoveryAuthenticationOptions/);
  assert.match(server, /\/api\/auth\/recover\/verify/);
  assert.match(server, /security\.verifyRecoveryAuthentication/);
});

test('UI fixture can render unreachable, expired, and expiry-warning states', async () => {
  const fixture = await fs.readFile(
    new URL('../scripts/ui-fixture.mjs', import.meta.url),
    'utf8',
  );
  assert.match(fixture, /fixtureMode === 'unreachable'/);
  assert.match(fixture, /fixtureMode === 'expired'/);
  assert.match(fixture, /fixtureMode === 'warning'/);
  assert.match(fixture, /new HttpError\(401, 'device_session_expired'\)/);
});
