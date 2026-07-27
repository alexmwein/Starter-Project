import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { AccessibilityTransport, parseResult } from '../src/accessibility.mjs';

const execFileAsync = promisify(execFile);

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
  assert.deepEqual(
    await transport.send({
      workspaceName: 'Workspace',
      sessionTitle: 'Chat',
      sessionOrdinal: 1,
      message: 'tab\tchanges focus',
    }),
    { ok: false, code: 'message_invalid', safeToRetry: true },
  );
  assert.deepEqual(
    await transport.send({
      workspaceName: 'Workspace',
      sessionTitle: 'Chat',
      sessionOrdinal: 1,
      message: '\ud800',
    }),
    { ok: false, code: 'message_invalid', safeToRetry: true },
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
  assert.deepEqual(parseResult('{"ok":false,"code":"session_locked"}'), {
    ok: false,
    code: 'session_locked',
    safeToRetry: true,
  });
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
    parseResult(
      '{"ok":true,"code":"sent","pressedAt":1785093000000,"composerOwned":true}',
    ),
    {
      ok: true,
      code: 'sent',
      pressedAt: 1785093000000,
      composerOwned: true,
    },
  );
  assert.deepEqual(
    parseResult(
      '{"ok":false,"code":"send_interrupted","pressedAt":1785093000000,"composerOwned":true}',
    ),
    {
      ok: false,
      code: 'send_interrupted',
      pressedAt: 1785093000000,
      composerOwned: true,
    },
  );
  assert.deepEqual(parseResult('{"ok":true,"code":"sent"}'), {
    ok: false,
    code: 'automation_invalid_response',
  });
  assert.deepEqual(
    parseResult('{"ok":false,"code":"send_not_confirmed"}'),
    {
      ok: false,
      code: 'automation_invalid_response',
    },
  );
  assert.deepEqual(parseResult('{"ok":false,"code":"send_interrupted"}'), {
    ok: false,
    code: 'automation_invalid_response',
  });
  assert.deepEqual(parseResult('not-json'), {
    ok: false,
    code: 'automation_invalid_response',
  });
});

test('draft ownership and replacement checks are case-sensitive', async () => {
  const [source, inputHelper] = await Promise.all([
    fs.readFile(
      new URL('../src/conductor-send.applescript', import.meta.url),
      'utf8',
    ),
    fs.readFile(new URL('../src/conductor-input.js', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /considering case[\s\S]*existingDraft is not messageText/);
  assert.match(
    inputHelper,
    /normalizedDraft\(candidate\.value\(\)\) === expectedDraft/,
  );
  assert.match(source, /existingDraft is not expectedDraft/);
  assert.match(inputHelper, /currentDraft === message/);
  assert.match(inputHelper, /currentDraft !== expectedDraft/);
  assert.match(inputHelper, /validateFocusedComposer\(pid, committedPrefix\)/);
});

test('the structural accessibility linefeed is not treated as a Mac draft', async () => {
  const [source, inputHelper] = await Promise.all([
    fs.readFile(
      new URL('../src/conductor-send.applescript', import.meta.url),
      'utf8',
    ),
    fs.readFile(new URL('../src/conductor-input.js', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /on normalizedDraft\(rawValue\)/);
  assert.match(source, /if \(length of valueText\) is 1 then return ""/);
  assert.match(inputHelper, /function normalizedDraft\(rawValue\)/);
  assert.match(inputHelper, /value\.endsWith\('\\n'\)/);
  assert.match(inputHelper, /normalizedDraft\(candidate\.value\(\)\)/);
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

test('message submission presses Conductor’s unique enabled Send control', async () => {
  const [source, inputHelper] = await Promise.all([
    fs.readFile(
      new URL('../src/conductor-send.applescript', import.meta.url),
      'utf8',
    ),
    fs.readFile(new URL('../src/conductor-input.js', import.meta.url), 'utf8'),
  ]);
  assert.match(
    inputHelper,
    /const SEND_CLASSES = \[[\s\S]*'ml-1'[\s\S]*'bg-foreground'[\s\S]*'hover:bg-foreground\/80'/,
  );
  assert.match(
    inputHelper,
    /const NON_SEND_CLASSES = \[[\s\S]*'bg-foreground\/50'[\s\S]*'cursor-not-allowed'[\s\S]*'hover:bg-muted'[\s\S]*'border'/,
  );
  assert.match(
    inputHelper,
    /function resolveComposerSend[\s\S]*description\(\) === 'composer'[\s\S]*candidate\.focused\(\) === true[\s\S]*pressActions\.length === 1/,
  );
  assert.match(
    inputHelper,
    /validateRoute\(process\)[\s\S]*resolveComposerSend\(process, message\)[\s\S]*validateRoute\(process\)[\s\S]*resolveComposerSend\(process, message\)/,
  );
  assert.match(inputHelper, /exactDraftExposedAt = draftReadStartedAt/);
  assert.match(inputHelper, /exactDraftExposedAt = possibleExposureAt/);
  assert.match(
    inputHelper,
    /assertInputLease\(inputLease\)[\s\S]*pressInvokedAt = Date\.now\(\)[\s\S]*actions\.byName\('AXPress'\)\.perform\(\)[\s\S]*assertInputLease\(inputLease\)/,
  );
  assert.match(
    inputHelper,
    /return `ambiguous:\$\{[\s\S]*pressInvokedAt \|\| exactDraftExposedAt \|\| attemptStartedAt/,
  );
  assert.match(
    inputHelper,
    /if \(inputInterrupted\) return `interrupted:\$\{attemptStartedAt\}`/,
  );
  assert.match(source, /POCKET_OPERATION=type-and-send/);
  assert.match(source, /commitResult starts with "pressed:"/);
  assert.match(source, /commitResult starts with "ambiguous:"/);
  assert.match(source, /commitResult starts with "interrupted:"/);
  assert.match(source, /send_interrupted/);
  assert.doesNotMatch(source, /set bestX to/);
  assert.doesNotMatch(source, /\/bin\/date \+%s/);
});

test('Tiptap text entry uses Unicode events under a physical-input lease', async () => {
  const [appleScript, inputHelper] = await Promise.all([
    fs.readFile(
      new URL('../src/conductor-send.applescript', import.meta.url),
      'utf8',
    ),
    fs.readFile(new URL('../src/conductor-input.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(appleScript, /set value of attribute "AXValue"/);
  assert.match(appleScript, /system attribute "POCKET_INPUT_SCRIPT"/);
  assert.match(
    appleScript,
    /POCKET_OPERATION=type-and-send \/usr\/bin\/osascript -l JavaScript/,
  );
  assert.match(appleScript, /on decodeBase64\(encodedValue\)/);
  assert.match(
    appleScript,
    /base64 -D" without altering line endings/,
  );
  assert.match(appleScript, /POCKET_MESSAGE_BASE64/);
  assert.match(appleScript, /POCKET_EXPECTED_DRAFT_BASE64/);
  assert.doesNotMatch(appleScript, /system attribute "POCKET_MESSAGE"/);
  assert.doesNotMatch(appleScript, /\bkeystroke\b/);

  assert.match(inputHelper, /com\.conductor\.app/);
  assert.match(
    inputHelper,
    /ObjC\.bindFunction\('CGEventKeyboardSetUnicodeString', \[\s*'void',\s*\['pointer', 'unsigned long', 'pointer'\],\s*\]\)/,
  );
  assert.match(inputHelper, /CGEventKeyboardSetUnicodeString/);
  assert.match(inputHelper, /CGEventPostToPid\(pid, event\)/);
  assert.match(inputHelper, /CGEventSourceSecondsSinceLastEventType/);
  assert.match(inputHelper, /CGEventSourceCounterForEventType/);
  assert.match(inputHelper, /CGSessionCopyCurrentDictionary/);
  assert.match(inputHelper, /CGSSessionScreenIsLocked/);
  assert.match(inputHelper, /function assertSessionUnlocked/);
  assert.match(inputHelper, /MIN_PHYSICAL_IDLE_SECONDS = 1/);
  assert.match(inputHelper, /PHYSICAL_INPUT_EVENT_TYPES/);
  assert.match(inputHelper, /kCGEventMouseMoved/);
  assert.match(inputHelper, /kCGEventKeyDown/);
  assert.match(inputHelper, /kCGEventScrollWheel/);
  assert.match(inputHelper, /sameCounters\(countersBefore, countersAfter\)/);
  assert.match(
    inputHelper,
    /sameCounters\(snapshot\.inputCounters, lease\.inputCounters\)/,
  );
  assert.match(inputHelper, /lease\.syntheticInputPosted = true/);
  assert.match(
    inputHelper,
    /!lease\.syntheticInputPosted[\s\S]*snapshot\.idleSeconds < MIN_PHYSICAL_IDLE_SECONDS/,
  );
  assert.match(inputHelper, /acquireInputLease/);
  assert.match(inputHelper, /assertInputLease/);
  assert.match(inputHelper, /NSUTF16LittleEndianStringEncoding/);
  assert.match(inputHelper, /utf16\.bytes/);
  assert.match(inputHelper, /POCKET_MESSAGE_BASE64/);
  assert.match(inputHelper, /POCKET_EXPECTED_DRAFT_BASE64/);
  assert.match(inputHelper, /prepareInput/);
  assert.match(inputHelper, /waitForExactDraft/);
  assert.match(inputHelper, /committedPrefix = nextPrefix/);
  assert.match(inputHelper, /AXFocusedUIElement/);
  assert.match(inputHelper, /composer-tiptap-editor/);
  assert.match(inputHelper, /POCKET_WORKSPACE_NAME/);
  assert.match(inputHelper, /POCKET_SESSION_TITLE/);
  assert.match(inputHelper, /POCKET_SESSION_ORDINAL/);
  assert.match(inputHelper, /validateRoute/);
  assert.match(inputHelper, /AXIsProcessTrusted/);
  assert.doesNotMatch(inputHelper, /CGEventPost\(\$\.kCGSessionEventTap/);
  assert.match(
    inputHelper,
    /assertInputLease\(lease\)[\s\S]*assertSessionUnlocked\(\)[\s\S]*eventPosted = true[\s\S]*assertSessionUnlocked\(\)[\s\S]*assertInputLease\(lease\)/,
  );
  assert.match(
    inputHelper,
    /eventPosted && exactDraftMayBeExposedAt > 0[\s\S]*exposureError/,
  );
  assert.match(
    inputHelper,
    /postToConductor\([\s\S]*possibleExposureAt[\s\S]*exactDraftExposedAt = possibleExposureAt[\s\S]*waitForExactDraft/,
  );
  assert.match(
    inputHelper,
    /pressInvokedAt = Date\.now\(\)[\s\S]*AXPress'\)\.perform\(\)[\s\S]*return `pressed:\$\{pressInvokedAt\}`/,
  );
  assert.match(appleScript, /session_locked/);

  assert.doesNotMatch(`${appleScript}\n${inputHelper}`, /clipboard|NSPasteboard/i);
  assert.match(inputHelper, /exactDraftExposedAt = possibleExposureAt/);
});

test(
  'the macOS JXA bridge round-trips UTF-16 without posting an event',
  { skip: process.platform !== 'darwin' },
  async () => {
    const sample = 'café 東京 👩‍💻 é';
    const probe = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', [
  'void',
  ['pointer', 'unsigned long', 'pointer'],
]);
function run(argv) {
  const sample = argv[0];
  const source = $.CGEventSourceCreate($.kCGEventSourceStatePrivate);
  const event = $.CGEventCreateKeyboardEvent(source, 0, true);
  const utf16 = $(sample).dataUsingEncoding(
    $.NSUTF16LittleEndianStringEncoding,
  );
  $.CGEventKeyboardSetUnicodeString(event, sample.length, utf16.bytes);
  const roundTrip = $.NSEvent.eventWithCGEvent(event);
  return ObjC.unwrap(roundTrip.characters);
}`;
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', probe, sample],
      {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      },
    );
    assert.equal(stdout.trim(), sample);
  },
);
