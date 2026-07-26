import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { AccessibilityTransport, parseResult } from '../src/accessibility.mjs';

test('accessibility transport rejects invalid messages before UI automation', async () => {
  const transport = new AccessibilityTransport();
  assert.deepEqual(
    await transport.send({
      workspaceName: 'Workspace',
      sessionTitle: 'Chat',
      sessionOrdinal: 1,
      message: '   ',
    }),
    { ok: false, code: 'message_empty', safeToRetry: true },
  );
  assert.deepEqual(
    await transport.send({
      workspaceName: 'Workspace',
      sessionTitle: 'Chat',
      sessionOrdinal: 1,
      message: 'a'.repeat(17 * 1024),
    }),
    { ok: false, code: 'message_too_large', safeToRetry: true },
  );
  assert.deepEqual(
    await transport.send({
      workspaceName: 'Workspace',
      sessionTitle: 'Chat',
      sessionOrdinal: 1,
      message: 'replacement',
      replaceDraft: true,
    }),
    { ok: false, code: 'draft_recheck_required', safeToRetry: true },
  );
});

test('only structured pre-send automation failures are marked safe to retry', () => {
  assert.deepEqual(
    parseResult('{"ok":false,"code":"accessibility_disabled"}'),
    {
      ok: false,
      code: 'accessibility_disabled',
      safeToRetry: true,
    },
  );
  assert.deepEqual(
    parseResult(
      '{"ok":false,"code":"send_not_confirmed","pressedAt":1785093000000,"composerOwned":true}',
    ),
    {
      ok: false,
      code: 'send_not_confirmed',
      pressedAt: 1785093000000,
      composerOwned: true,
    },
  );
  assert.deepEqual(
    parseResult('{"ok":false,"code":"send_not_confirmed"}'),
    {
      ok: false,
      code: 'automation_invalid_response',
    },
  );
  assert.deepEqual(parseResult('not-json'), {
    ok: false,
    code: 'automation_invalid_response',
  });
});

test('draft ownership and replacement checks are case-sensitive', async () => {
  const source = await fs.readFile(
    new URL('../src/conductor-send.applescript', import.meta.url),
    'utf8',
  );
  assert.equal(source.match(/considering case/g)?.length, 4);
  assert.match(source, /if currentValue is expectedMessage/);
  assert.match(source, /existingDraft is not expectedDraft/);
});

test('the structural accessibility linefeed is not treated as a Mac draft', async () => {
  const source = await fs.readFile(
    new URL('../src/conductor-send.applescript', import.meta.url),
    'utf8',
  );
  assert.match(source, /on normalizedDraft\(rawValue\)/);
  assert.match(source, /if \(length of valueText\) is 1 then return ""/);
  assert.equal(source.match(/my normalizedDraft/g)?.length, 5);
});

test('session lookup scans every radio button in the Conductor tab group', async () => {
  const source = await fs.readFile(
    new URL('../src/conductor-send.applescript', import.meta.url),
    'utf8',
  );
  assert.match(source, /repeat with tabGroupChild in tabGroupChildren/);
  assert.match(source, /repeat with tabGroupElement in tabGroupElements/);
  assert.match(
    source,
    /if \(role of tabGroupElement as text\) is "AXRadioButton" then copy tabGroupElement to end of sessionTabs/,
  );
  assert.doesNotMatch(
    source,
    /return UI elements of item 1 of tabGroupChildren/,
  );
});
