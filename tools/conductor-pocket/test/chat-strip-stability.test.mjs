import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (name) => fs.readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');

function rule(css, selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `missing ${selector}`);
  const end = css.indexOf('}', start);
  return css.slice(start, end + 1);
}

test('chat status markers never change chip geometry', async () => {
  const css = await source('app.css');

  assert.match(rule(css, '.chat-chip {'), /position:\s*relative/);
  assert.match(rule(css, '.chat-chip {'), /padding:\s*6px\s+38px\s+6px\s+12px/);
  assert.match(rule(css, '.chip-indicator {'), /position:\s*absolute/);
  assert.match(rule(css, '.chip-indicator {'), /right:\s*6px/);
  assert.match(rule(css, '.chip-indicator {'), /width:\s*28px/);
  assert.match(rule(css, '.chip-indicator .chip-dot {'), /margin-right:\s*0/);
  assert.match(rule(css, '.chip-indicator .chip-unread {'), /margin-right:\s*0/);
});

test('status and unread refreshes preserve the mounted chat buttons', async () => {
  const js = await source('app.js');
  const start = js.indexOf('function renderChatStrip()');
  const end = js.indexOf('function renderTranscript()', start);
  const body = js.slice(start, end);

  assert.match(js, /function syncChatStripChip\(/);
  assert.match(body, /syncChatStripChip\(chip,/);
  assert.match(body, /reconcileChatStripChildren\(strip,/);
  assert.doesNotMatch(body, /strip\.replaceChildren\(\.\.\.chips\)/);
  assert.match(js, /chip\.dataset\.renderKey === renderKey/);
});

test('newest order changes keep the selected chat at the same screen position', async () => {
  const js = await source('app.js');
  const start = js.indexOf('function renderChatStrip()');
  const end = js.indexOf('function renderTranscript()', start);
  const body = js.slice(start, end);

  assert.match(body, /previousActiveOffset/);
  assert.match(body, /previousScrollLeft/);
  assert.match(
    body,
    /previousScrollLeft \+ activeChip\.offsetLeft - previousActiveOffset/,
  );
  assert.match(body, /lastCentredSessionId !== state\.route\.sessionId/);
});

test('background activity follows newest order without replacing chat buttons', async () => {
  const js = await source('app.js');
  const start = js.indexOf('function stableChatStripSessions(');
  assert.notEqual(start, -1, 'missing stableChatStripSessions');
  const end = js.indexOf('\n}\n', start) + 2;
  const stableChatStripSessions = vm.runInNewContext(
    `(${js.slice(start, end)})`,
  );
  const session = (id) => ({ id });

  const initial = stableChatStripSessions(
    [session('a'), session('b'), session('c')],
    [],
  );
  assert.deepEqual(Array.from(initial, (item) => item.id), ['a', 'b', 'c']);

  const refreshed = stableChatStripSessions(
    [session('b'), session('a'), session('c')],
    initial.map((item) => item.id),
  );
  assert.deepEqual(Array.from(refreshed, (item) => item.id), ['b', 'a', 'c']);

  const changed = stableChatStripSessions(
    [session('d'), session('a'), session('c')],
    refreshed.map((item) => item.id),
  );
  assert.deepEqual(Array.from(changed, (item) => item.id), ['d', 'a', 'c']);
});

test('manual strip scrolling anchors the visible chip instead of an offscreen selection', async () => {
  const module = await import('../public/transcript-focus.js');
  assert.equal(typeof module.captureHorizontalScrollAnchor, 'function');
  assert.equal(typeof module.restoreHorizontalScrollAnchor, 'function');

  const strip = {
    scrollLeft: 700,
    clientWidth: 390,
    scrollWidth: 1_300,
    getBoundingClientRect() {
      return { left: 0, right: this.clientWidth };
    },
  };
  const chip = (id, offsetLeft, left, right) => ({
    id,
    offsetLeft,
    getBoundingClientRect() {
      return { left, right };
    },
  });
  const offscreenActive = chip('active', 100, -600, -480);
  const visible = chip('visible', 720, 20, 120);
  const trailing = chip('trailing', 830, 130, 250);
  const anchor = module.captureHorizontalScrollAnchor(
    strip,
    [offscreenActive, visible, trailing],
    { preferred: offscreenActive, manual: true },
  );

  visible.offsetLeft = 905;
  strip.scrollWidth = 1_500;
  module.restoreHorizontalScrollAnchor(strip, anchor);
  assert.equal(
    strip.scrollLeft,
    885,
    'the same visible chip must keep its screen coordinate after reordering',
  );
});
