import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { AccessibilityTransport } from '../src/accessibility.mjs';

test('accessibility transport rejects invalid messages before UI automation', async () => {
  const transport = new AccessibilityTransport();
  assert.deepEqual(
    await transport.send({
      workspaceName: 'Workspace',
      sessionTitle: 'Chat',
      sessionOrdinal: 1,
      message: '   ',
    }),
    { ok: false, code: 'message_empty' },
  );
  assert.deepEqual(
    await transport.send({
      workspaceName: 'Workspace',
      sessionTitle: 'Chat',
      sessionOrdinal: 1,
      message: 'a'.repeat(17 * 1024),
    }),
    { ok: false, code: 'message_too_large' },
  );
  assert.deepEqual(
    await transport.send({
      workspaceName: 'Workspace',
      sessionTitle: 'Chat',
      sessionOrdinal: 1,
      message: 'replacement',
      replaceDraft: true,
    }),
    { ok: false, code: 'draft_recheck_required' },
  );
});

test('draft ownership and replacement checks are case-sensitive', async () => {
  const source = await fs.readFile(
    new URL('../src/conductor-send.applescript', import.meta.url),
    'utf8',
  );
  assert.equal(source.match(/considering case/g)?.length, 3);
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
  assert.equal(source.match(/my normalizedDraft/g)?.length, 4);
});
