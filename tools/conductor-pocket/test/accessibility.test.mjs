import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';
import {
  AccessibilityTransport,
  mapAutomationError,
  parseResult,
} from '../src/accessibility.mjs';

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
  assert.deepEqual(parseResult('{"ok":false,"code":"user_input_active"}'), {
    ok: false,
    code: 'user_input_active',
    safeToRetry: true,
  });
  assert.deepEqual(
    parseResult(
      '{"ok":false,"code":"composer_changed_pre_send","retryCertificate":"e30="}',
    ),
    {
      ok: false,
      code: 'composer_changed_pre_send',
      retryCertificate: 'e30=',
      safeToRetry: true,
    },
  );
  assert.deepEqual(
    parseResult(
      '{"ok":false,"code":"composer_changed_pre_send"}',
    ),
    {
      ok: false,
      code: 'automation_invalid_response',
    },
  );
  assert.deepEqual(
    parseResult('{"ok":false,"code":"composer_update_failed"}'),
    {
      ok: false,
      code: 'composer_update_failed',
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
  assert.deepEqual(
    parseResult(
      '{"ok":false,"code":"send_interrupted","pressedAt":1785093000000,"composerOwned":false}',
    ),
    {
      ok: false,
      code: 'send_interrupted',
      pressedAt: 1785093000000,
      composerOwned: false,
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
  assert.deepEqual(
    parseResult(
      '{"ok":false,"code":"automation_failed","pressedAt":1785093000000,"composerOwned":true}',
    ),
    { ok: false, code: 'automation_invalid_response' },
  );
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
    /normalizedDraft\(focusedElement\.value\(\)\) !== expectedDraft/,
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
  assert.match(inputHelper, /normalizedDraft\(focusedElement\.value\(\)\)/);
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

test('a denied Accessibility permission is provably pre-send while unknown automation failures stay ambiguous', () => {
  assert.deepEqual(
    mapAutomationError({
      stderr: 'Not authorized to send Apple events. (-1743)',
    }),
    {
      ok: false,
      code: 'accessibility_disabled',
      safeToRetry: true,
    },
  );
  assert.deepEqual(
    mapAutomationError({ killed: true, signal: 'SIGTERM' }),
    { ok: false, code: 'automation_timeout' },
  );
  assert.deepEqual(
    mapAutomationError({ message: 'Unexpected automation failure' }),
    {
      ok: false,
      code: 'automation_failed',
      detail: 'Unexpected automation failure',
    },
  );

  const attemptStartedAt = 1_785_093_000_000;
  const pressedAt = attemptStartedAt + 250;
  const markerContext = {
    markerContent: `${attemptStartedAt}\n${pressedAt}\n`,
    attemptStartedAt,
    observedAt: pressedAt + 10,
  };
  assert.deepEqual(
    mapAutomationError(
      { killed: true, signal: 'SIGTERM' },
      markerContext,
    ),
    {
      ok: false,
      code: 'automation_timeout',
      pressedAt,
      composerOwned: true,
    },
  );
  assert.deepEqual(
    mapAutomationError(
      { message: 'Unexpected automation failure' },
      markerContext,
    ),
    // A proven press still refuses to be called anything but maybe-sent, and
    // now also carries the sanitized underlying text. A duplicated early
    // return used to shadow that, silently dropping the diagnostic on exactly
    // the ambiguous failures where it is most needed.
    {
      ok: false,
      code: 'automation_failed',
      pressedAt,
      composerOwned: true,
      detail: 'Unexpected automation failure',
    },
  );
  assert.deepEqual(
    mapAutomationError(
      { stderr: 'Not authorized to send Apple events. (-1743)' },
      markerContext,
    ),
    {
      ok: false,
      code: 'automation_failed',
      detail: 'Not authorized to send Apple events. (-1743)',
      pressedAt,
      composerOwned: true,
    },
  );
  assert.deepEqual(
    mapAutomationError(
      { killed: true, signal: 'SIGTERM' },
      {
        ...markerContext,
        markerContent: `${attemptStartedAt - 1}\n${pressedAt}\n`,
      },
    ),
    { ok: false, code: 'automation_timeout' },
  );
  assert.deepEqual(
    mapAutomationError(
      { message: 'Unexpected automation failure' },
      {
        ...markerContext,
        markerContent: `${attemptStartedAt}\n${markerContext.observedAt + 1}\n`,
      },
    ),
    // The marker is invalid so no press may be attributed; the underlying
    // text still travels as sanitized detail per the diagnostics contract.
    {
      ok: false,
      code: 'automation_failed',
      detail: 'Unexpected automation failure',
    },
  );
});

test('AXPress provenance is timestamp-only, attempt-bound, and cleaned after each transport attempt', async () => {
  const [transport, appleScript, inputHelper] = await Promise.all([
    fs.readFile(new URL('../src/accessibility.mjs', import.meta.url), 'utf8'),
    fs.readFile(
      new URL('../src/conductor-send.applescript', import.meta.url),
      'utf8',
    ),
    fs.readFile(new URL('../src/conductor-input.js', import.meta.url), 'utf8'),
  ]);

  assert.match(
    transport,
    /mkdtemp\(\s*join\(tmpdir\(\), PRESS_MARKER_PREFIX\)/,
  );
  assert.match(transport, /chmod\(pressMarkerDirectory, 0o700\)/);
  assert.match(transport, /pressMarkerPath = join\(pressMarkerDirectory, 'pressed-at'\)/);
  assert.match(transport, /POCKET_PRESS_MARKER_PATH: pressMarkerPath/);
  assert.match(
    transport,
    /const result = parseResult\(stdout\);[\s\S]*attributeStructuredFailure\([\s\S]*await pressMarkerContext\(pressMarkerPath, attemptStartedAt\)/,
  );
  assert.match(
    transport,
    /markerAttemptStartedAt !== attemptStartedAt[\s\S]*pressedAt < attemptStartedAt[\s\S]*pressedAt > observedAt/,
  );
  assert.match(
    transport,
    /open\(\s*markerPath,[\s\S]*O_RDONLY \| fsConstants\.O_NOFOLLOW/,
  );
  assert.match(
    transport,
    /finally \{[\s\S]*rm\(pressMarkerDirectory,[\s\S]*recursive: true,[\s\S]*force: true/,
  );
  const markerSetup = transport.slice(
    transport.indexOf("if (operation === 'send')"),
    transport.indexOf('const attemptStartedAt = Date.now()'),
  );
  assert.match(markerSetup, /catch \{[\s\S]*safeToRetry\('input_helper_unavailable'\)/);
  assert.match(
    appleScript,
    /POCKET_PRESS_MARKER_PATH=" & quoted form of pressMarkerPath & " POCKET_OPERATION=type-and-send/,
  );
  assert.match(
    inputHelper,
    /const markerText = `\$\{attemptStartedAt\}\\n\$\{pressedAt\}\\n`/,
  );
  assert.match(
    inputHelper,
    /const pressAction = resolveComposerPressAction\(sendButton\);[\s\S]*pressInvokedAt = Date\.now\(\);\s*pressAction\.perform\(\);\s*recordPressProvenance\(attemptStartedAt, pressInvokedAt\);/,
  );
  const markerWriter = inputHelper.slice(
    inputHelper.indexOf('function recordPressProvenance'),
    inputHelper.indexOf('function decodeBase64Environment'),
  );
  assert.doesNotMatch(markerWriter, /message|draft|base64/i);
});


test('the workspace matcher accepts owner-prefixed sidebar titles', async () => {
  // Conductor titles some workspaces "Owner/name" while the relay-side name
  // is just "name"; every send then fails workspace resolution. The matcher
  // must accept the slash-anchored form (with or without a diff badge) and
  // stay anchored so partial names can never cross-match.
  const source = await fs.readFile(
    new URL('../src/conductor-send.applescript', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('on workspaceMatches');
  const block = source.slice(start, source.indexOf('end workspaceMatches'));
  assert.ok(block.includes('ends with ("/" & workspaceName)'));
  assert.ok(block.includes('contains ("/" & workspaceName & " +")'));
});

test('workspace matching routes every diff-badge label Conductor renders', async () => {
  // Executes the real handler text rather than asserting it contains a
  // string. Labels observed live in the sidebar on 2026-08-16: "the plan",
  // "Finance +8", "daemon +3.7k -165". A deletions-only workspace renders
  // "name -165" with no plus, and matching only the plus form made that
  // workspace unroutable, a total send outage no retry can clear.
  const source = await fs.readFile(
    new URL('../src/conductor-send.applescript', import.meta.url),
    'utf8',
  );
  const handlers = source.slice(
    source.indexOf('on hasDiffBadge'),
    source.indexOf('end workspaceMatches') + 'end workspaceMatches'.length,
  );
  const cases = [
    ['daemon', 'daemon', true],
    ['daemon', 'daemon +3.7k -165', true],
    ['Finance', 'Finance +8', true],
    ['daemon', 'daemon -165', true],
    ['daemon', 'Owner/daemon', true],
    ['daemon', 'Owner/daemon +8', true],
    ['daemon', 'Owner/daemon -165', true],
    // Still anchored: a prefix must not cross-match a different workspace.
    ['daemon', 'daemon two', false],
    ['daemon', 'daemonics +8', false],
    ['plan', 'the plan', false],
  ];
  const probes = cases
    .map(
      ([base, candidate]) =>
        `(my workspaceMatches(${JSON.stringify(base)}, ` +
        `${JSON.stringify(candidate)}) as text)`,
    )
    .join(' & "," & ');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(
    '/usr/bin/osascript',
    ['-e', `${handlers}\nreturn ${probes}`],
    { timeout: 20_000 },
  );
  const actual = stdout.trim().split(',');
  cases.forEach(([base, candidate, expected], index) => {
    assert.equal(
      actual[index],
      String(expected),
      `workspaceMatches(${base}, ${candidate}) should be ${expected}`,
    );
  });
});

test('a typed pocket code in osascript stderr survives instead of collapsing to automation_failed', () => {
  const mapped = mapAutomationError({
    stderr:
      'conductor-input.js: execution error: Error: send_unavailable (-2700)',
  });
  assert.equal(mapped.code, 'send_unavailable');
  assert.equal(mapped.safeToRetry, true);
  assert.ok(mapped.detail.includes('send_unavailable (-2700)'));
});

test('an unrecognized automation failure keeps its underlying text as detail', () => {
  const mapped = mapAutomationError({
    stderr: 'execution error: Error: route_lookup exploded at depth 3 (-1719)',
  });
  assert.equal(mapped.code, 'automation_failed');
  assert.equal(mapped.safeToRetry, undefined);
  assert.ok(mapped.detail.includes('exploded at depth 3'));
});

test('automation detail redacts quoted content and base64 runs before it can reach a log', () => {
  // Message text and transcript content are protected assets. AppleScript
  // error text quotes the value it choked on, and the message travels to the
  // script as base64, so both shapes must never survive into the audit log.
  const secret = Buffer.from('the private message body', 'utf8').toString('base64');
  const mapped = mapAutomationError({
    stderr: `execution error: Can't make "the private message body" into type integer. env ${secret} (-1700)`,
  });
  assert.equal(mapped.code, 'automation_failed');
  assert.ok(!mapped.detail.includes('the private message body'));
  assert.ok(!mapped.detail.includes(secret));
  assert.ok(mapped.detail.includes('"[redacted]"'));
  assert.ok(mapped.detail.includes('[b64]'));
  assert.ok(mapped.detail.includes('(-1700)'));
});

test('redaction never costs a recognized code recovery', () => {
  const mapped = mapAutomationError({
    stderr: 'execution error: Error: user_input_active while typing "something private" (-2700)',
  });
  assert.equal(mapped.code, 'user_input_active');
  assert.equal(mapped.safeToRetry, true);
  assert.ok(!mapped.detail.includes('something private'));
});

test('message submission waits for and presses Conductor’s unique enabled Send control', async () => {
  const [source, inputHelper] = await Promise.all([
    fs.readFile(
      new URL('../src/conductor-send.applescript', import.meta.url),
      'utf8',
    ),
    fs.readFile(new URL('../src/conductor-input.js', import.meta.url), 'utf8'),
  ]);
  assert.match(
    inputHelper,
    /const SEND_POSITION_CLASS = 'ml-1'[\s\S]*const SEND_ACTIVE_CLASSES = \[[\s\S]*'bg-foreground'[\s\S]*'hover:bg-foreground\/80'/,
  );
  assert.match(
    inputHelper,
    /const NON_SEND_CLASSES = \[[\s\S]*'bg-foreground\/50'[\s\S]*'cursor-not-allowed'[\s\S]*'hover:bg-muted'[\s\S]*'border'/,
  );
  assert.match(
    inputHelper,
    /function composerSendContext[\s\S]*role = candidate\.role\(\)[\s\S]*description = candidate\.description\(\)[\s\S]*catch \{[\s\S]*fail\('send_unavailable'\)/,
  );
  assert.match(
    inputHelper,
    /function resolveComposerSend[\s\S]*candidate\.focused\(\) === true[\s\S]*isComposerSendButton\(candidate, composerElements\[index - 1\]\)/,
  );
  assert.match(
    inputHelper,
    /function isComposerSendButton[\s\S]*classes\.includes\(SEND_POSITION_CLASS\)[\s\S]*SEND_ACTIVE_CLASSES\.every[\s\S]*NON_SEND_CLASSES\.every[\s\S]*isSpeechControl\(preceding\)[\s\S]*pressActions\.length === 1/,
  );
  assert.match(
    inputHelper,
    /QUEUED_EDIT_MARKER = 'Editing queued message'/,
  );
  assert.match(
    inputHelper,
    /QUEUED_EDIT_PLACEHOLDER = 'Edit queued message'/,
  );
  // Deliberately not 1. At 1 the budget exactly equalled what Conductor 0.81
  // renders, so one added control failed every send before any text was typed.
  // Behavior is covered in accessibility-layout.regression-2.test.mjs.
  assert.match(
    inputHelper,
    /const MAX_PRE_TRANSCRIPT_CONTROLS = (?![01];)\d+;/,
  );
  assert.match(
    inputHelper,
    /const MAX_QUEUED_EDIT_CONTEXT_SIBLINGS = 8/,
  );
  assert.match(
    inputHelper,
    /const MAX_QUEUED_EDIT_CONTEXT_CHILDREN = 8/,
  );
  assert.match(
    inputHelper,
    /const MAX_QUEUED_EDIT_CONTEXT_NODES = 96/,
  );
  assert.match(
    inputHelper,
    // The chrome band no longer pins role, child count or action set. What
    // stays: one tab group, the transcript boundary found by role, a bounded
    // band, and the queued-edit scan region taken from that boundary.
    /function composerSendContext[\s\S]*tabGroupCount !== 1[\s\S]*mainRoles\[index\] === 'AXGroup'[\s\S]*transcriptBoundaryIndex = index[\s\S]*candidateChildren\.length > MAX_QUEUED_EDIT_CONTEXT_CHILDREN[\s\S]*transcriptBoundaryIndex < 0[\s\S]*MAX_PRE_TRANSCRIPT_CONTROLS[\s\S]*mainElements\.slice\(\s*transcriptBoundaryIndex \+ 1,\s*composerIndex \+ 1[\s\S]*contextElements\.length > MAX_QUEUED_EDIT_CONTEXT_SIBLINGS \+ 1[\s\S]*candidateChildren\.length > MAX_QUEUED_EDIT_CONTEXT_CHILDREN/,
  );
  assert.match(
    inputHelper,
    /function hasStaticTextInBoundedTree[\s\S]*budget\.remaining <= 0[\s\S]*role = element\.role\(\)[\s\S]*role === 'AXStaticText'[\s\S]*!nameReadable \|\| !valueReadable[\s\S]*fail\('send_unavailable'\)[\s\S]*hasStaticTextInBoundedTree\(child, expectedTexts, budget\)[\s\S]*function assertNotQueuedEditMode[\s\S]*remaining: MAX_QUEUED_EDIT_CONTEXT_NODES[\s\S]*contextElements\.slice\(0, -1\)\.some\([\s\S]*\[QUEUED_EDIT_MARKER\][\s\S]*hasStaticTextInBoundedTree\(\s*composer,\s*\[QUEUED_EDIT_MARKER, QUEUED_EDIT_PLACEHOLDER\][\s\S]*fail\('send_unavailable'\)/,
  );
  assert.doesNotMatch(
    inputHelper,
    /hasStaticTextInBoundedTree\(main, QUEUED_EDIT_MARKER\)/,
  );
  const firstEditCheck = inputHelper.indexOf(
    'assertNotQueuedEditMode(process);',
    inputHelper.indexOf('function typeAndSendMessage'),
  );
  const firstInputPost = inputHelper.indexOf(
    'postToConductor(',
    inputHelper.indexOf('function typeAndSendMessage'),
  );
  assert.ok(firstEditCheck >= 0);
  assert.ok(firstInputPost > firstEditCheck);
  assert.match(
    inputHelper,
    /function waitForComposerSend[\s\S]*attempt < 250[\s\S]*assertRouteLease\(process, routeLease\)[\s\S]*resolveComposerSend\(refreshed, expectedDraft\)/,
  );
  assert.match(
    inputHelper,
    /routeLease = acquireRouteLease\(process\)[\s\S]*assertNotQueuedEditMode\(process\)[\s\S]*waitForComposerSend\(pid, message, inputLease, routeLease\)[\s\S]*validateFocusedComposer\(pid, message\)[\s\S]*assertRouteLease\(process, routeLease\)[\s\S]*resolveComposerSend\(process, message\)/,
  );
  const finalResolve = inputHelper.lastIndexOf(
    'const sendButton = resolveComposerSend(process, message);',
  );
  const finalRouteProof = inputHelper.indexOf(
    'assertRouteLease(process, routeLease);',
    finalResolve,
  );
  const finalActionResolve = inputHelper.indexOf(
    'const pressAction = resolveComposerPressAction(sendButton);',
    finalResolve,
  );
  const pressBoundary = inputHelper.indexOf(
    'pressInvokedAt = Date.now();',
    finalActionResolve,
  );
  const finalPress = inputHelper.indexOf(
    'pressAction.perform();',
    pressBoundary,
  );
  assert.ok(finalResolve >= 0);
  assert.ok(finalActionResolve > finalResolve);
  assert.ok(pressBoundary > finalActionResolve);
  assert.ok(finalRouteProof > finalResolve);
  assert.ok(finalPress > pressBoundary);
  assert.doesNotMatch(inputHelper, /validateRoute\(/);
  assert.match(inputHelper, /exactDraftExposedAt = draftReadStartedAt/);
  assert.match(inputHelper, /exactDraftExposedAt = possibleExposureAt/);
  assert.match(
    inputHelper,
    /resolveComposerPressAction\(sendButton\)[\s\S]*assertInputLease\(inputLease\)[\s\S]*pressInvokedAt = Date\.now\(\)[\s\S]*pressAction\.perform\(\)[\s\S]*assertInputLease\(inputLease\)/,
  );
  assert.doesNotMatch(inputHelper, /submitEvents: eventPair\(source, KEY_RETURN\)/);
  assert.match(
    inputHelper,
    /if \(pressInvokedAt > 0\) return `ambiguous:\$\{pressInvokedAt\}`/,
  );
  assert.match(
    inputHelper,
    /if \(inputInterrupted\) return `interrupted:\$\{attemptStartedAt\}`/,
  );
  assert.match(
    inputHelper,
    /function certifyPreSendRetry[\s\S]*trackedPrefixes = \[[\s\S]*lastProvenPrefix[\s\S]*lastAttemptedPrefix[\s\S]*exactDraftExposedAt > 0[\s\S]*CERTIFIABLE_PRE_SEND_CODES\.includes\(error\?\.pocketCode\)[\s\S]*assertInputLease\(inputLease\)[\s\S]*assertRouteLease\(process, routeLease\)[\s\S]*!trackedPrefixes\.includes\(firstDraft\)[\s\S]*kind:[\s\S]*'exact-draft-unpressed'[\s\S]*'partial-draft-unpressed'/,
  );
  assert.match(
    inputHelper,
    /carriedInputCounters[\s\S]*sameCounters\(\s*inputLease\.inputCounters,\s*carriedInputCounters[\s\S]*fail\('user_input_active'\)/,
  );
  assert.match(
    inputHelper,
    /if \(pressInvokedAt > 0\)[\s\S]*return `ambiguous:[\s\S]*certifyPreSendRetry/,
  );
  assert.match(source, /POCKET_OPERATION=type-and-send/);
  assert.match(source, /commitResult starts with "pressed:"/);
  assert.match(source, /commitResult starts with "ambiguous:"/);
  assert.match(source, /commitResult starts with "interrupted:"/);
  assert.match(source, /commitResult starts with "retryable:"/);
  assert.match(source, /composer_changed_pre_send/);
  assert.match(source, /send_interrupted/);
  assert.match(
    source,
    /commitResult starts with "interrupted:"[\s\S]*\\"composerOwned\\":false/,
  );
  assert.match(
    source,
    /set routeAlreadySelected to my sessionIsSelected\(sessionTitle, sessionOrdinal\)/,
  );
  assert.match(
    source,
    /set sessionFound to routeAlreadySelected[\s\S]*if sessionFound is false then[\s\S]*repeat with waitIndex from 1 to 50/,
  );
  assert.match(
    source,
    /on workspaceLinkIsSelected\(workspaceLink, workspaceName\)[\s\S]*AXDOMClassList[\s\S]*bg-sidebar-accent/,
  );
  assert.match(
    source,
    /on getWorkspaceRoute\(workspaceName, sidebarGroup\)[\s\S]*if \(count of matchingRoutes\) is not 1 or selectedWorkspaceCount is not 1 then return missing value/,
  );
  const initialWorkspaceLookup = source.indexOf(
    'set workspaceRoute to my getWorkspaceRoute(workspaceName, sidebarGroup)',
  );
  const refreshedWorkspaceLookup = source.indexOf(
    'set workspaceRoute to my getWorkspaceRoute(workspaceName, sidebarGroup)',
    initialWorkspaceLookup + 1,
  );
  const routeStabilization = source.indexOf('set stableRouteChecks to 0');
  const routeRefreshBlock = source.lastIndexOf(
    'if routeAlreadySelected is false then',
    refreshedWorkspaceLookup,
  );
  assert.ok(initialWorkspaceLookup >= 0);
  assert.ok(refreshedWorkspaceLookup > initialWorkspaceLookup);
  assert.ok(routeRefreshBlock > initialWorkspaceLookup);
  assert.ok(routeStabilization > refreshedWorkspaceLookup);
  assert.match(
    source.slice(routeRefreshBlock, routeStabilization),
    /workspace_list_unavailable[\s\S]*workspace_not_visible/,
  );
  assert.match(
    source,
    /POCKET_WORKSPACE_CONTAINER_INDEX=[\s\S]*POCKET_WORKSPACE_LINK_INDEX=[\s\S]*POCKET_WORKSPACE_SIDEBAR_CHILD_COUNT=[\s\S]*POCKET_WORKSPACE_CONTAINER_CHILD_COUNT=[\s\S]*POCKET_OPERATION=type-and-send/,
  );
  assert.match(
    source,
    /set stableRouteChecks to 0[\s\S]*repeat with waitIndex from 1 to 50[\s\S]*workspaceLinkIsSelected\(workspaceLink, workspaceName\)[\s\S]*set stableRouteChecks to stableRouteChecks \+ 1[\s\S]*if stableRouteChecks is 3 then exit repeat/,
  );
  assert.doesNotMatch(
    source,
    /if routeAlreadySelected is true then[\s\S]*set stableRouteChecks to 3/,
  );
  assert.match(
    source,
    /if retryInputCounters is not "" and routeAlreadySelected is false then return "\{\\"ok\\":false,\\"code\\":\\"user_input_active\\"\}"/,
  );
  assert.match(
    source,
    /if my workspaceLinkIsSelected\(workspaceLink, workspaceName\) is false then return "\{\\"ok\\":false,\\"code\\":\\"workspace_not_visible\\"\}"/,
  );
  assert.match(
    source,
    /commitResult starts with "pressed:"[\s\S]*return "\{\\"ok\\":true,\\"code\\":\\"sent\\"/,
  );
  const postCommit = source.slice(
    source.indexOf('set commitResult to my commitAndPressMessage'),
  );
  assert.doesNotMatch(postCommit, /repeat with waitIndex from 1 to 40/);
  assert.doesNotMatch(source, /set bestX to/);
  assert.doesNotMatch(source, /\/bin\/date \+%s/);
});

test('Conductor 0.80 send-control policy accepts send/queue and rejects stop transitions', async () => {
  const source = await fs.readFile(
    new URL('../src/conductor-input.js', import.meta.url),
    'utf8',
  );
  const dollar = new Proxy(() => null, { get: () => 0 });
  const sandbox = {
    $: dollar,
    Application: () => {
      throw new Error('Application must not be called in this unit test');
    },
    ObjC: { bindFunction() {}, import() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}\nglobalThis.__isComposerSendButton = isComposerSendButton; globalThis.__resolveComposerPressAction = resolveComposerPressAction;`,
    sandbox,
  );
  const candidate = (classes, { enabled = true } = {}) => ({
    attributes: {
      byName() {
        return { value: () => classes };
      },
    },
    actions() {
      return [{ name: () => 'AXPress' }];
    },
    enabled() {
      return enabled;
    },
    role() {
      return 'AXButton';
    },
  });
  const speech = {
    role: () => 'AXButton',
    name: () => 'Speech to text',
    description() {
      throw new Error('description unavailable');
    },
  };
  const active = [
    'ml-1',
    'bg-foreground',
    'hover:bg-foreground/80',
  ];
  assert.equal(sandbox.__isComposerSendButton(candidate(active), speech), true);
  const pressAction = { name: () => 'AXPress', perform() {} };
  assert.equal(
    sandbox.__resolveComposerPressAction({ actions: () => [pressAction] }),
    pressAction,
  );
  assert.throws(
    () =>
      sandbox.__resolveComposerPressAction({
        actions() {
          throw new Error('stale action proxy');
        },
      }),
    (error) => error?.pocketCode === 'send_unavailable',
  );
  assert.equal(sandbox.__isComposerSendButton(candidate(active), speech), true);
  assert.equal(
    sandbox.__isComposerSendButton(
      candidate(['ml-1', 'border', 'border-border', 'hover:bg-muted']),
      speech,
    ),
    false,
  );
  assert.equal(
    sandbox.__isComposerSendButton(candidate(['ml-1']), speech),
    false,
  );
  assert.equal(
    sandbox.__isComposerSendButton(candidate(active, { enabled: false }), speech),
    false,
  );
  assert.equal(
    sandbox.__isComposerSendButton(candidate(active), {
      role: () => 'AXButton',
      name: () => 'Attach file',
      description: () => 'Attach file',
    }),
    false,
  );
});

test('route leases revalidate fresh AX nodes in constant workspace time and fail closed', async () => {
  const source = await fs.readFile(
    new URL('../src/conductor-input.js', import.meta.url),
    'utf8',
  );
  const dollar = new Proxy(() => null, {
    get: () => 0,
  });
  const sandbox = {
    $: dollar,
    Application: () => {
      throw new Error('Application must not be called in this unit test');
    },
    ObjC: {
      bindFunction() {},
      import() {},
    },
    delay() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}
globalThis.__routeLeaseTest = {
  acquireRouteLease,
  assertNotQueuedEditMode,
  assertRouteLease,
  composerSendContext,
};`,
    sandbox,
  );
  const {
    acquireRouteLease,
    assertNotQueuedEditMode,
    assertRouteLease,
    composerSendContext,
  } =
    sandbox.__routeLeaseTest;

  const target = {
    workspaceName: 'Workspace 31',
    sessionTitle: 'Same title',
    sessionOrdinal: 2,
  };
  const makeNode = ({
    actionNames = [],
    role = 'AXGroup',
    description = '',
    name = '',
    value = false,
    classes = [],
    children = [],
    throwOnChildren = false,
    throwOnName = false,
    throwOnValue = false,
  } = {}) => {
    let retired = false;
    const assertLive = () => {
      if (retired) throw new Error('stale AX node used');
    };
    return {
      actions() {
        assertLive();
        return actionNames.map((actionName) => ({
          name() {
            assertLive();
            return actionName;
          },
        }));
      },
      attributes: {
        byName(attributeName) {
          assertLive();
          return {
            value() {
              assertLive();
              if (attributeName === 'AXDOMClassList') return classes;
              return '';
            },
          };
        },
      },
      description() {
        assertLive();
        return description;
      },
      name() {
        assertLive();
        if (throwOnName) throw new Error('non-target workspace inspected');
        return name;
      },
      retire() {
        retired = true;
      },
      role() {
        assertLive();
        return role;
      },
      uiElements() {
        assertLive();
        if (throwOnChildren) throw new Error('children must stay opaque');
        return children;
      },
      value() {
        assertLive();
        if (throwOnValue) throw new Error('value unavailable');
        return value;
      },
    };
  };
  const makeTree = ({
    duplicateWorkspace = false,
    shiftWorkspace = false,
    targetSelected = true,
    throwOnNonTargetNames = false,
    selectedSession = 2,
    insertSession = false,
  } = {}) => {
    const nodes = [];
    const node = (options) => {
      const result = makeNode(options);
      nodes.push(result);
      return result;
    };
    const workspaceLinks = Array.from({ length: 49 }, (_, index) =>
      node({
        role: 'AXLink',
        name:
          duplicateWorkspace && index === 7
            ? target.workspaceName
            : `Workspace ${index}`,
        classes:
          index === 31 && targetSelected ? ['bg-sidebar-accent'] : [],
        throwOnName: throwOnNonTargetNames && index !== 31,
      }),
    );
    if (shiftWorkspace) {
      workspaceLinks.unshift(
        node({ role: 'AXLink', name: 'Inserted workspace' }),
      );
    }
    const workspaceContainer = node({ children: workspaceLinks });
    const sidebar = node({ children: [workspaceContainer] });

    const radioDefinitions = [
      { name: 'Close chat Same title', ordinal: 1 },
      { name: 'Close chat Different title', ordinal: 0 },
      { name: 'Close chat Same title', ordinal: 2 },
    ];
    if (insertSession) {
      radioDefinitions.unshift({
        name: 'Close chat Inserted title',
        ordinal: 0,
      });
    }
    const radios = radioDefinitions.map((definition) =>
      node({
        role: 'AXRadioButton',
        name: definition.name,
        value:
          definition.ordinal > 0 &&
          definition.ordinal === selectedSession,
      }),
    );
    const tabChildren = node({ children: radios });
    const tabGroup = node({
      role: 'AXTabGroup',
      children: [tabChildren],
    });
    const main = node({
      children: [
        node({ role: 'AXButton' }),
        tabGroup,
        node({ role: 'AXGroup' }),
        node({ description: 'composer' }),
      ],
    });
    const webArea = node({
      children: [node(), sidebar, main],
    });
    return { nodes, webArea };
  };
  const state = { webArea: null };
  const process = {
    windows: [
      {
        groups: [
          {
            groups: [
              {
                scrollAreas: [
                  {
                    get uiElements() {
                      return [state.webArea];
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const routeChanged = (error) => error?.pocketCode === 'route_changed';

  const initial = makeTree();
  state.webArea = initial.webArea;
  const lease = acquireRouteLease(process, target);
  initial.nodes.forEach((element) => element.retire());

  const fresh = makeTree({ throwOnNonTargetNames: true });
  state.webArea = fresh.webArea;
  assert.doesNotThrow(() => assertRouteLease(process, lease));

  state.webArea = makeTree({ shiftWorkspace: true }).webArea;
  assert.throws(() => assertRouteLease(process, lease), routeChanged);

  state.webArea = makeTree({ targetSelected: false }).webArea;
  assert.throws(() => assertRouteLease(process, lease), routeChanged);

  state.webArea = makeTree({ selectedSession: 1 }).webArea;
  assert.throws(() => assertRouteLease(process, lease), routeChanged);

  state.webArea = makeTree({ insertSession: true }).webArea;
  assert.throws(() => assertRouteLease(process, lease), routeChanged);

  state.webArea = makeTree({ duplicateWorkspace: true }).webArea;
  assert.throws(
    () => acquireRouteLease(process, target),
    routeChanged,
  );

  const hintedTree = makeTree({ throwOnNonTargetNames: true });
  state.webArea = hintedTree.webArea;
  const hintedLease = acquireRouteLease(process, {
    ...target,
    workspaceHint: {
      containerChildCount: 49,
      path: [0, 31],
      sidebarChildCount: 1,
    },
  });
  assert.doesNotThrow(() => assertRouteLease(process, hintedLease));

  const makeGuardTree = ({
    directMarker = '',
    highFanoutContext = false,
    includePopup = true,
    popupActionNames = ['AXPress', 'AXShowMenu'],
    popupChildCount = 0,
    popupRole = 'AXPopUpButton',
    transcriptChildCount = 0,
    transcriptThrows = false,
  } = {}) => {
    const guardNode = (options) => makeNode(options);
    const composer = guardNode({
      role: 'AXGroup',
      description: 'composer',
      children: Array.from({ length: 9 }, () => guardNode()),
    });
    const transcript = guardNode({
      role: 'AXGroup',
      children: Array.from(
        { length: transcriptChildCount },
        () => guardNode(),
      ),
      throwOnChildren: transcriptThrows,
    });
    const firstContext = directMarker
      ? guardNode({
          role: 'AXStaticText',
          name:
            directMarker === 'name'
              ? 'Editing queued message'
              : 'not the marker',
          throwOnValue: directMarker === 'unreadable-value',
          value:
            directMarker === 'value'
              ? 'Editing queued message'
              : 'not the marker',
        })
      : guardNode({
          children: Array.from(
            { length: highFanoutContext ? 9 : 1 },
            () => guardNode(),
          ),
        });
    const preTranscript = includePopup
      ? [
          guardNode({
            actionNames: popupActionNames,
            children: Array.from(
              { length: popupChildCount },
              () => guardNode(),
            ),
            role: popupRole,
          }),
        ]
      : [];
    const guardMain = guardNode({
      children: [
        guardNode({ role: 'AXTabGroup' }),
        ...preTranscript,
        transcript,
        firstContext,
        guardNode(),
        guardNode({ children: [guardNode()] }),
        guardNode({ children: [guardNode()] }),
        composer,
      ],
    });
    return {
      composer,
      webArea: guardNode({
        children: [guardNode(), guardNode(), guardMain],
      }),
    };
  };

  for (const transcriptChildCount of [0, 1]) {
    const guardTree = makeGuardTree({ transcriptChildCount });
    state.webArea = guardTree.webArea;
    const guardContext = composerSendContext(process);
    assert.equal(guardContext.composer, guardTree.composer);
    assert.equal(guardContext.contextElements.length, 5);
  }

  state.webArea = makeGuardTree({ includePopup: false }).webArea;
  assert.doesNotThrow(() => composerSendContext(process));

  state.webArea = makeGuardTree({ transcriptThrows: true }).webArea;
  assert.doesNotThrow(() => composerSendContext(process));

  // These three shapes used to fail closed, pinning the chrome band to the
  // exact role, child count and action set Conductor 0.81 happened to render.
  // That is not a safety property: the composer is proven by its own
  // AXDescription, and the queued-edit scan reads the band after the
  // transcript boundary, which is still found by role. Pinning it did cause a
  // real outage, on 2026-08-16 a single added control failed every send before
  // any text was typed, identically across three retries of one message. So
  // unknown chrome is now tolerated here.
  for (const options of [
    { popupRole: 'AXButton' },
    { popupChildCount: 1 },
    { popupActionNames: [] },
  ]) {
    state.webArea = makeGuardTree(options).webArea;
    assert.doesNotThrow(() => composerSendContext(process));
  }

  // What remains load bearing: a container in the band would mean the element
  // taken as the transcript is not the transcript, which would move the
  // queued-edit scan off its region. That still fails closed.
  state.webArea = makeGuardTree({ popupChildCount: 9 }).webArea;
  assert.throws(
    () => composerSendContext(process),
    (error) => error?.pocketCode === 'send_unavailable',
  );

  for (const directMarker of ['name', 'value', 'unreadable-value']) {
    state.webArea = makeGuardTree({ directMarker }).webArea;
    assert.throws(
      () => assertNotQueuedEditMode(process),
      (error) => error?.pocketCode === 'send_unavailable',
    );
  }

  state.webArea = makeGuardTree({ highFanoutContext: true }).webArea;
  assert.throws(
    () => composerSendContext(process),
    (error) => error?.pocketCode === 'send_unavailable',
  );
});

test('Pocket waits for physical input to go idle before changing the Conductor route', async () => {
  const [appleScript, inputHelper] = await Promise.all([
    fs.readFile(
      new URL('../src/conductor-send.applescript', import.meta.url),
      'utf8',
    ),
    fs.readFile(new URL('../src/conductor-input.js', import.meta.url), 'utf8'),
  ]);
  const readiness = appleScript.indexOf(
    'set inputReadiness to my waitForInputIdle',
  );
  const workspaceLookup = appleScript.indexOf(
    'set sidebarGroup to getSidebarGroup()',
    readiness,
  );

  assert.match(inputHelper, /function waitForInputIdle\(timeoutMs = 3000\)/);
  assert.match(inputHelper, /return waitForInputIdle\(\) \? 'ready' : 'busy'/);
  assert.match(
    appleScript,
    /POCKET_OPERATION=input-check \/usr\/bin\/osascript -l JavaScript/,
  );
  assert.ok(readiness >= 0);
  assert.ok(workspaceLookup > readiness);
  assert.match(
    appleScript,
    /inputReadiness is "busy" then return "\{\\"ok\\":false,\\"code\\":\\"user_input_active\\"\}"/,
  );
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
  assert.match(inputHelper, /acquireRouteLease/);
  assert.match(inputHelper, /assertRouteLease/);
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
    /resolveComposerPressAction\(sendButton\)[\s\S]*pressInvokedAt = Date\.now\(\)[\s\S]*pressAction\.perform\(\)[\s\S]*return `pressed:\$\{pressInvokedAt\}`/,
  );
  assert.match(appleScript, /session_locked/);

  assert.doesNotMatch(`${appleScript}\n${inputHelper}`, /clipboard|NSPasteboard/i);
  assert.match(inputHelper, /exactDraftExposedAt = possibleExposureAt/);
});

test('Pocket makes code and primary replies directly copyable on iPhone', async () => {
  const [application, styles] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);

  assert.match(application, /copy: 'i-copy'/);
  assert.match(
    application,
    /navigator\.clipboard[\s\S]*writeText\(text\)/,
  );
  assert.match(
    application,
    /function legacyCopyText[\s\S]*try \{[\s\S]*document\.execCommand\('copy'\)[\s\S]*finally \{[\s\S]*field\.remove\(\)/,
  );
  assert.match(
    application,
    /function addCodeCopyControls[\s\S]*querySelectorAll\('pre'\)[\s\S]*code\.textContent/,
  );
  assert.match(application, /label: 'Copy code'/);
  assert.match(
    application,
    /message\.importance !== 'progress'[\s\S]*Copy response[\s\S]*message\.text/,
  );
  assert.match(
    application,
    /announce\('Copied to clipboard'\)[\s\S]*Copy failed/,
  );
  assert.match(
    styles,
    /\.message-copy-button[\s\S]*min-height: 44px/,
  );
  assert.match(
    styles,
    /\.code-copy-button[\s\S]*width: 44px[\s\S]*height: 44px/,
  );
  assert.match(
    styles,
    /\.message\.assistant[\s\S]*-webkit-touch-callout: default[\s\S]*-webkit-user-select: text[\s\S]*user-select: text/,
  );
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

test('a transient accessibility read is retried instead of aborting the send', async () => {
  const inputHelper = await fs.readFile(
    new URL('../src/conductor-input.js', import.meta.url),
    'utf8',
  );

  const fnStart = inputHelper.indexOf('function withTransientReadRetry');
  assert.ok(fnStart >= 0);
  const fnEnd = inputHelper.indexOf('\n}\n', fnStart) + 2;
  const readAttempts = Number(
    inputHelper.match(/const TRANSIENT_READ_ATTEMPTS = (\d+)/)[1],
  );
  const readDelaySeconds = Number(
    inputHelper.match(/const TRANSIENT_READ_DELAY_SECONDS = ([\d.]+)/)[1],
  );
  assert.ok(readAttempts >= 3);
  assert.ok(readDelaySeconds > 0);
  const sandbox = {
    delays: 0,
    TRANSIENT_READ_ATTEMPTS: readAttempts,
    TRANSIENT_READ_DELAY_SECONDS: readDelaySeconds,
  };
  sandbox.delay = () => {
    sandbox.delays += 1;
  };
  vm.createContext(sandbox);
  const withTransientReadRetry = vm.runInContext(
    `(${inputHelper.slice(fnStart, fnEnd)})`,
    sandbox,
  );

  // A re-render blip resolves once the tree settles.
  let reads = 0;
  const recovered = withTransientReadRetry(() => {
    reads += 1;
    if (reads < 3) throw new Error('transient');
    return 'settled';
  });
  assert.equal(recovered, 'settled');
  assert.equal(reads, 3);
  assert.equal(sandbox.delays, 2);

  // A genuine structural mismatch still fails, and still fails closed.
  let attempts = 0;
  assert.throws(
    () =>
      withTransientReadRetry(() => {
        attempts += 1;
        const error = new Error('send_unavailable');
        error.pocketCode = 'send_unavailable';
        throw error;
      }),
    /send_unavailable/,
  );
  assert.equal(attempts, readAttempts);

  // The read-only checks that were aborting healthy sends now re-walk.
  const queuedEditMode = inputHelper.slice(
    inputHelper.indexOf('function assertNotQueuedEditMode'),
  );
  assert.match(
    queuedEditMode.slice(0, queuedEditMode.indexOf('\n}\n')),
    /withTransientReadRetry\(\(\) => \{[\s\S]*composerSendContext\(process\)[\s\S]*remaining: MAX_QUEUED_EDIT_CONTEXT_NODES/,
  );
  for (const waiter of ['waitForExactDraft', 'waitForComposerSend']) {
    const body = inputHelper.slice(inputHelper.indexOf(`function ${waiter}`));
    assert.match(
      body.slice(0, body.indexOf('\n}\n')),
      /withTransientReadRetry\(\(\) => \{[\s\S]*assertRouteLease\(process, routeLease\)/,
    );
  }

  // The typing hot loop must poll with the cheap focused read and prove the
  // route ONCE at the decision point. A measured assertRouteLease walk costs
  // ~1990ms against ~90ms for the focused read, so proving it per poll spent
  // seconds per chunk re-deriving something that cannot change between two
  // 20ms samples. That was the bulk of a 26 to 45 second send.
  const exactDraft = inputHelper.slice(
    inputHelper.indexOf('function waitForExactDraft'),
  );
  const exactDraftBody = exactDraft.slice(0, exactDraft.indexOf('\n}\n'));
  assert.match(
    exactDraftBody,
    /withTransientReadRetry\(\(\) => validateFocusedComposer\(pid\)\)[\s\S]*focusedDraft\(polled\) === expectedDraft[\s\S]*assertRouteLease\(process, routeLease\)/,
  );
  assert.equal(exactDraftBody.match(/assertRouteLease/g).length, 1);

  // Physical-input and lock state report real conditions, so retrying them
  // would erase the signal. They must never be wrapped.
  assert.doesNotMatch(
    inputHelper,
    /withTransientReadRetry\([^)]*assertInputLease/,
  );
  assert.doesNotMatch(
    inputHelper,
    /withTransientReadRetry\([^)]*assertSessionUnlocked/,
  );
});

test('the send path does not re-derive work it already has', async () => {
  const inputHelper = await fs.readFile(
    new URL('../src/conductor-input.js', import.meta.url),
    'utf8',
  );

  // resolveMainRoot bulk-reads role and description for every main child, so
  // composerSendContext must consume those arrays instead of spending ~40
  // Apple Events re-deriving them. It runs three times per send, so this was
  // about a second of every send.
  assert.match(
    inputHelper,
    /candidates\.push\(\{[\s\S]*descriptions,[\s\S]*roles,[\s\S]*\}\)/,
  );
  const context = inputHelper.slice(
    inputHelper.indexOf('function composerSendContext'),
  );
  const contextBody = context.slice(0, context.indexOf('\n}\n'));
  assert.match(contextBody, /main\.roles[\s\S]*main\.descriptions/);
  assert.match(contextBody, /bulkRoles\[index\]/);
  // The pinned per-element loop must survive as the fallback.
  assert.match(contextBody, /role = candidate\.role\(\)/);
  assert.match(contextBody, /description = candidate\.description\(\)/);

  // The press wait polls with the cheap probe, never the full resolution.
  const wait = inputHelper.slice(
    inputHelper.indexOf('function waitForComposerSend'),
  );
  const waitBody = wait.slice(0, wait.indexOf('\n}\n'));
  assert.match(waitBody, /sendControlLikelyReady\(pid, expectedDraft\)/);
  // A cheap false positive must keep polling, never fail the send.
  assert.match(waitBody, /pocketCode !== 'send_unavailable'\) throw error/);

  // The probe is a hint: it must not be what authorizes a press. The full
  // resolveComposerSend plus route proof still gates the decision point.
  const probe = inputHelper.slice(
    inputHelper.indexOf('function sendControlLikelyReady'),
  );
  const probeBody = probe.slice(0, probe.indexOf('\n}\n'));
  assert.doesNotMatch(probeBody, /AXPress|perform\(\)/);
  assert.match(waitBody, /assertRouteLease\(process, routeLease\)[\s\S]*resolveComposerSend/);

  // The queued-edit scan is proven once per attempt, and only the scan: the
  // structural resolution still runs on every call.
  const queued = inputHelper.slice(
    inputHelper.indexOf('function assertNotQueuedEditMode'),
  );
  const queuedBody = queued.slice(0, queued.indexOf('\n}\n'));
  assert.match(queuedBody, /composerSendContext\(process\)/);
  assert.match(queuedBody, /if \(queuedEditProven\) return composer/);
  assert.match(queuedBody, /queuedEditProven = true/);
  // It must sit AFTER the structural resolution, never short-circuit it.
  assert.ok(
    queuedBody.indexOf('composerSendContext(process)') <
      queuedBody.indexOf('if (queuedEditProven)'),
  );
});

test('a missing Conductor window is recovered before the send gives up', async () => {
  // conductor_window_unavailable is classified retry-safe, so the phone offered
  // Retry, and the retry asked the same absent window again and failed again in
  // under a second. Observed 2026-08-17: four such failures, each under 1.2s,
  // each clearing only once a window came back on its own. The window is also
  // absent for a moment while the Mac wakes and while Conductor relaunches,
  // which is exactly when a phone send arrives.
  const source = await fs.readFile(
    new URL('../src/conductor-send.applescript', import.meta.url),
    'utf8',
  );
  assert.match(source, /on restoreConductorWindow\(\)/);
  assert.match(source, /tell application "Conductor" to activate/);
  // The send path must attempt recovery, not report the failure immediately.
  assert.match(
    source,
    /if not \(exists front window\) then\s*\n\s*if my restoreConductorWindow\(\) is false then return "\{\\"ok\\":false,\\"code\\":\\"conductor_window_unavailable\\"\}"/,
  );
  // Bounded: recovery must not be able to eat the whole automation budget.
  const handler = source.slice(
    source.indexOf('on restoreConductorWindow()'),
    source.indexOf('end restoreConductorWindow'),
  );
  const repeatMatch = handler.match(/repeat with waitIndex from 1 to (\d+)/);
  const delayMatch = handler.match(/delay ([\d.]+)/);
  assert.ok(repeatMatch && delayMatch, 'recovery must be a bounded poll');
  const budgetSeconds = Number(repeatMatch[1]) * Number(delayMatch[1]);
  assert.ok(
    budgetSeconds > 2 && budgetSeconds <= 10,
    `recovery budget ${budgetSeconds}s must outlast a wake but stay well inside the 45s automation timeout`,
  );
});
