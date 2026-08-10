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
  const block = source.slice(heartbeat, heartbeat + 1600);
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

test('the on-screen backstop refresh exists, skips a hidden app, and is cleared with the stream', () => {
  assert.match(source, /const TRANSCRIPT_BACKSTOP_MS = 8 \* 1000/);
  const backstop = source.indexOf('state.backstopTimer = setInterval');
  assert.ok(backstop >= 0);
  const block = source.slice(backstop, backstop + 400);
  assert.match(
    block,
    /if \(document\.hidden \|\| !state\.auth \|\| !state\.shell\) return/,
  );
  // stopEvents must clear it: startEvents calls stopEvents first, so leaking
  // this timer would stack a second backstop on every stream revive.
  assert.match(
    source,
    /if \(state\.backstopTimer\) clearInterval\(state\.backstopTimer\)/,
  );
  assert.match(source, /state\.backstopTimer = null/);
});
