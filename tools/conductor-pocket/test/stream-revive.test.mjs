import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

// The event stream is the only thing that refreshes the transcript live, and
// nothing rebuilt it when it died: EventSource does not reliably reopen a
// stream iOS tore down, and startEvents was otherwise reached only from
// revealApplication. That is the "I have to background the app to see new
// output" symptom. These locks pin the two-part cure: a watchdog that
// rebuilds a detectably dead stream, and a bounded on-screen backstop for a
// stream that stays open but silently stops delivering.

const source = await fs.readFile(
  new URL('../public/app.js', import.meta.url),
  'utf8',
);

test('a detectably dead stream is rebuilt from the heartbeat watchdog', () => {
  assert.match(source, /const STREAM_REVIVE_MS = 15 \* 1000/);
  const heartbeat = source.indexOf('state.heartbeatTimer = setInterval');
  assert.ok(heartbeat >= 0);
  // Window sized to the whole watchdog body, not a guess. It was 1600 and the
  // block grew, so the last assertion fell off the end and failed while the
  // code it guards was untouched.
  const block = source.slice(heartbeat, heartbeat + 2600);
  // Gated on a heartbeat having arrived at least once (a first load that has
  // not connected is left to its original attempt), on being on screen, on a
  // signed-in shell, and on a revive throttle so a dead relay is not hammered.
  assert.match(
    block,
    /state\.lastHeartbeat &&\s*!document\.hidden &&\s*state\.auth &&\s*state\.shell &&\s*Date\.now\(\) - \(state\.lastStreamRevive \|\| 0\) > STREAM_REVIVE_MS/,
  );
  assert.match(block, /state\.lastStreamRevive = Date\.now\(\)/);
  assert.match(block, /startEvents\(\);\s*transcriptRefresh\.schedule\(\);\s*metadataRefresh\.schedule\(\)/);
});

test('a stream that never connects gets exactly one bounded restart', () => {
  assert.match(source, /const INITIAL_STREAM_RESTART_MS = \d[\d_]*;/);
  assert.match(source, /function startEventsAttempt\(\{ initialRetry = false \} = \{\}\)/);
  const start = source.indexOf('function startEventsAttempt({ initialRetry = false } = {})');
  const stop = source.indexOf('function stopEvents()', start);
  const block = source.slice(start, stop);
  assert.match(block, /state\.initialStreamTimer = setTimeout/);
  assert.match(block, /if \(!initialRetry\)[\s\S]*startEventsAttempt\(\{ initialRetry: true \}\)/);
  assert.doesNotMatch(
    block.slice(block.indexOf('if (!initialRetry)')),
    /startEventsAttempt\(\{ initialRetry: false \}\)/,
  );
  assert.match(source, /clearTimeout\(state\.initialStreamTimer\)/);
  assert.match(source, /state\.initialStreamTimer = null/);
});

test('the on-screen backstop refresh exists, skips a hidden app, and is cleared with the stream', () => {
  assert.match(source, /const TRANSCRIPT_BACKSTOP_MS = 8 \* 1000/);
  const backstop = source.indexOf('state.backstopTimer = setInterval');
  assert.ok(backstop >= 0);
  const block = source.slice(backstop, backstop + 400);
  assert.match(
    block,
    /if \(document\.hidden \|\| !state\.auth \|\| !state\.shell\) return/,
  );
  assert.match(
    block,
    /recheckAmbiguousDeliveries\(state\.route\.sessionId, \{\s*settlementOnly: true,?\s*\}\)[\s\S]*transcriptRefresh\.schedule\(\)/,
  );
  assert.match(
    source,
    /function recheckAmbiguousDeliveries\(\s*sessionId = null,\s*\{ settlementOnly = false \} = \{\},?\s*\)[\s\S]*deliveryBackstopNeedsRecovery\([\s\S]*activePost: deliveryPostsInFlight\.has\(message\.id\)/,
  );
  assert.match(
    source,
    /deliveryPostsInFlight\.add\(optimistic\.id\)[\s\S]*deliveryPostsInFlight\.delete\(optimistic\.id\)/,
  );
  // stopEvents must clear it: startEvents calls stopEvents first, so leaking
  // this timer would stack a second backstop on every stream revive.
  assert.match(
    source,
    /if \(state\.backstopTimer\) clearInterval\(state\.backstopTimer\)/,
  );
  assert.match(source, /state\.backstopTimer = null/);
});

test('a repeating update never becomes a reload loop', async () => {
  const source = await fs.readFile(
    new URL('../public/app-update.js', import.meta.url),
    'utf8',
  );
  // The document is served cache first, so a reload can land on a shell that
  // still reports the old revision and trigger the same update again. The
  // in-page reloadStarted flag cannot see that across reloads, so the attempt
  // count must persist for the tab.
  assert.match(source, /sessionStorage/);
  assert.match(source, /MAX_RELOAD_ATTEMPTS/);
  assert.match(
    source,
    /if \(reloadAttempts\(pendingRevision\) >= MAX_RELOAD_ATTEMPTS\) return false/,
  );
  // The attempt must be recorded BEFORE the reload, or the count never survives.
  const record = source.indexOf('recordReloadAttempt(pendingRevision)');
  const doReload = source.indexOf('reload(pendingRevision)', record);
  assert.ok(record >= 0);
  assert.ok(doReload > record);
  // A shell that matches the server proves the update landed, so the counter
  // must reset or a later genuine update would be refused.
  assert.match(source, /revision === clientRevision[\s\S]*clearReloadAttempts\(\)/);
});
