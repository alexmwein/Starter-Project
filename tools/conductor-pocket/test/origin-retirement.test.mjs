import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

// A revoked or expired session runs purgeLocalData(). That used to persist
// cp:origin-retired:v1, and nothing ever removed it, so cacheDatabase()
// rejected every read and write with origin_retired from then on. Every send
// failed with secure_delivery_storage_unavailable, permanently, and because the
// flag lived in the phone's localStorage no relay reinstall could clear it.
// Observed live 2026-09-01: a fresh browser profile loading the healthy live
// origin had the flag set at boot while IndexedDB itself opened and wrote fine.

const source = await fs.readFile(
  new URL('../public/app.js', import.meta.url),
  'utf8',
);

test('retirement is never persisted, and a stale flag is cleared at boot', () => {
  // The single lock that matters: the key may only be declared and removed.
  // Any getItem or setItem on it can permanently disable storage again.
  assert.doesNotMatch(
    source,
    /setItem\(\s*ORIGIN_RETIRED_KEY/,
    'persisting retirement outlives the purge and bricks the origin',
  );
  assert.doesNotMatch(
    source,
    /getItem\(\s*ORIGIN_RETIRED_KEY/,
    'reading a persisted retirement re-adopts the poisoned state',
  );
  assert.match(source, /removeItem\(ORIGIN_RETIRED_KEY\)/);
});

test('purgeLocalData still blocks writes for the rest of the page life', () => {
  const start = source.indexOf('async function purgeLocalData()');
  assert.ok(start >= 0);
  const body = source.slice(start, start + 400);
  // In-memory guard stays: a purge in progress must not race a cache write.
  assert.match(body, /originRetired = true;/);
});

test('cacheDatabase gates on the in-memory flag alone', () => {
  const start = source.indexOf('function cacheDatabase()');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('async function closeCacheDatabase'));
  assert.match(body, /if \(originRetired\) \{/);
  assert.doesNotMatch(body, /localStorage/);
  assert.match(body, /reject\(new Error\('origin_retired'\)\)/);
});

test('boot does not adopt a retirement left by a previous session', () => {
  assert.match(source, /let originRetired = false;/);
  assert.doesNotMatch(
    source,
    /let originRetired = localStorage/,
    'boot must not resurrect a persisted retirement',
  );
});
