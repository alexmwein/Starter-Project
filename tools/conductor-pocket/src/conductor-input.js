ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.import('Foundation');

// JXA exposes NSData.bytes as a generic pointer. Rebind the ABI-compatible C
// signature so CoreGraphics accepts the UTF-16 backing buffer without a
// shared paste state or globally posted keyboard event.
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', [
  'void',
  ['pointer', 'unsigned long', 'pointer'],
]);

const CONDUCTOR_BUNDLE_ID = 'com.conductor.app';
const COMPOSER_CLASSES = [
  'tiptap',
  'ProseMirror',
  'composer-tiptap-editor',
];
const SEND_CLASSES = [
  'ml-1',
  'bg-foreground',
  'hover:bg-foreground/80',
];
const NON_SEND_CLASSES = [
  'bg-foreground/50',
  'cursor-not-allowed',
  'hover:bg-muted',
  'border',
];
const QUEUED_EDIT_MARKER = 'Editing queued message';
const QUEUED_EDIT_PLACEHOLDER = 'Edit queued message';
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_CHUNK_UTF16 = 256;
const MIN_PHYSICAL_IDLE_SECONDS = 1;
const PHYSICAL_INPUT_EVENT_TYPES = [
  $.kCGEventLeftMouseDown,
  $.kCGEventLeftMouseUp,
  $.kCGEventRightMouseDown,
  $.kCGEventRightMouseUp,
  $.kCGEventMouseMoved,
  $.kCGEventLeftMouseDragged,
  $.kCGEventRightMouseDragged,
  $.kCGEventKeyDown,
  $.kCGEventKeyUp,
  $.kCGEventFlagsChanged,
  $.kCGEventScrollWheel,
  $.kCGEventTabletPointer,
  $.kCGEventTabletProximity,
  $.kCGEventOtherMouseDown,
  $.kCGEventOtherMouseUp,
  $.kCGEventOtherMouseDragged,
];
const KEY_A = 0;
const KEY_DELETE = 51;
const KEY_RETURN = 36;

function fail(code) {
  const error = new Error(code);
  error.pocketCode = code;
  throw error;
}

function environmentValue(name) {
  const value = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return value ? ObjC.unwrap(value) : null;
}

function decodeBase64Environment(name) {
  const encoded = environmentValue(name);
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    fail('invalid_encoding');
  }
  if (!encoded) return '';
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(encoded), 0);
  if (!data) fail('invalid_encoding');
  const decoded = $.NSString.alloc.initWithDataEncoding(
    data,
    $.NSUTF8StringEncoding,
  );
  if (!decoded) fail('invalid_encoding');
  const value = ObjC.unwrap(decoded);
  if (!isWellFormed(value)) fail('invalid_encoding');
  return value;
}

function workspaceMatches(workspaceName, candidateName) {
  return (
    candidateName === workspaceName ||
    candidateName.startsWith(`${workspaceName} +`)
  );
}

function isWellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizedDraft(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue : '';
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function assertSessionUnlocked() {
  const sessionRef = $.CGSessionCopyCurrentDictionary();
  if (!sessionRef) fail('session_locked');
  const state = ObjC.deepUnwrap(ObjC.castRefToObject(sessionRef));
  if (
    !state ||
    state.kCGSessionLoginDoneKey !== true ||
    state.kCGSSessionOnConsoleKey !== true ||
    state.CGSSessionScreenIsLocked === true
  ) {
    fail('session_locked');
  }
}

function childElements(element) {
  try {
    return element.uiElements();
  } catch {
    return [];
  }
}

function webAreaRootElements(process) {
  let webArea;
  try {
    webArea = process.windows[0]
      .groups[0]
      .groups[0]
      .scrollAreas[0]
      .uiElements[0];
  } catch {
    fail('route_changed');
  }
  const rootElements = childElements(webArea);
  if (rootElements.length < 3) fail('route_changed');
  return rootElements;
}

function validateRoute(process) {
  const workspaceName = environmentValue('POCKET_WORKSPACE_NAME');
  const sessionTitle = environmentValue('POCKET_SESSION_TITLE');
  const sessionOrdinal = Number(environmentValue('POCKET_SESSION_ORDINAL'));
  if (
    typeof workspaceName !== 'string' ||
    !workspaceName ||
    typeof sessionTitle !== 'string' ||
    !sessionTitle ||
    !Number.isSafeInteger(sessionOrdinal) ||
    sessionOrdinal <= 0
  ) {
    fail('route_changed');
  }

  const rootElements = webAreaRootElements(process);

  const sidebarElements = childElements(rootElements[1]);
  let workspaceSelected = false;
  for (const candidate of sidebarElements) {
    for (const child of childElements(candidate)) {
      if (child.role() !== 'AXLink') continue;
      const candidateName = child.name();
      if (!workspaceMatches(workspaceName, candidateName)) continue;
      const classes = child.attributes.byName('AXDOMClassList').value();
      workspaceSelected =
        Array.isArray(classes) && classes.includes('bg-sidebar-accent');
      break;
    }
    if (workspaceSelected) break;
  }
  if (!workspaceSelected) fail('route_changed');

  let sessionTabs = [];
  for (const candidate of childElements(rootElements[2])) {
    if (candidate.role() !== 'AXTabGroup') continue;
    for (const tabGroupChild of childElements(candidate)) {
      if (tabGroupChild.role() === 'AXRadioButton') {
        sessionTabs.push(tabGroupChild);
      } else {
        sessionTabs = sessionTabs.concat(
          childElements(tabGroupChild).filter(
            (element) => element.role() === 'AXRadioButton',
          ),
        );
      }
    }
    break;
  }

  let matchedCount = 0;
  for (const candidate of sessionTabs) {
    if (candidate.name() !== `Close chat ${sessionTitle}`) continue;
    matchedCount += 1;
    if (matchedCount === sessionOrdinal) {
      if (!Boolean(candidate.value())) fail('route_changed');
      return;
    }
  }
  fail('route_changed');
}

function validateFocusedComposer(pid, expectedDraft = null) {
  assertSessionUnlocked();
  const conductor = $.NSRunningApplication.runningApplicationWithProcessIdentifier(
    pid,
  );
  if (!conductor || ObjC.unwrap(conductor.bundleIdentifier) !== CONDUCTOR_BUNDLE_ID) {
    fail('invalid_target_process');
  }
  if (!Boolean(conductor.active)) fail('target_not_active');

  const systemEvents = Application('System Events');
  const process = systemEvents.processes.byName('Conductor');
  if (!process.exists() || Number(process.unixId()) !== pid || !process.frontmost()) {
    fail('invalid_target_process');
  }
  const focusedElement = process.attributes
    .byName('AXFocusedUIElement')
    .value();
  const classes = focusedElement.attributes
    .byName('AXDOMClassList')
    .value();
  if (
    focusedElement.role() !== 'AXTextArea' ||
    !Array.isArray(classes) ||
    !COMPOSER_CLASSES.every((name) => classes.includes(name))
  ) {
    fail('composer_focus_changed');
  }
  if (
    typeof expectedDraft === 'string' &&
    normalizedDraft(focusedElement.value()) !== expectedDraft
  ) {
    fail('draft_changed');
  }
  return process;
}

function eventPair(source, virtualKey, flags = 0) {
  const keyDown = $.CGEventCreateKeyboardEvent(source, virtualKey, true);
  const keyUp = $.CGEventCreateKeyboardEvent(source, virtualKey, false);
  if (!keyDown || !keyUp) fail('event_create_failed');
  $.CGEventSetFlags(keyDown, flags);
  $.CGEventSetFlags(keyUp, flags);
  return [keyDown, keyUp];
}

function buildUnicodeEvents(source, chunk) {
  if (
    typeof chunk !== 'string' ||
    !chunk.length ||
    chunk.length > MAX_CHUNK_UTF16 ||
    !isWellFormed(chunk) ||
    chunk.includes('\0') ||
    /[\u0001-\u001f\u007f]/.test(chunk)
  ) {
    fail('invalid_chunk');
  }

  const [keyDown, keyUp] = eventPair(source, KEY_A);

  const utf16 = $(chunk).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
  if (!utf16 || Number(utf16.length) !== chunk.length * 2) {
    fail('utf16_encode_failed');
  }
  $.CGEventKeyboardSetUnicodeString(keyDown, chunk.length, utf16.bytes);
  const roundTrip = $.NSEvent.eventWithCGEvent(keyDown);
  if (!roundTrip || ObjC.unwrap(roundTrip.characters) !== chunk) {
    fail('unicode_roundtrip_failed');
  }
  return { keyDown, keyUp, utf16 };
}

function physicalIdleSeconds() {
  return Number(
    $.CGEventSourceSecondsSinceLastEventType(
      $.kCGEventSourceStateHIDSystemState,
      $.kCGAnyInputEventType,
    ),
  );
}

function physicalInputCounters() {
  return PHYSICAL_INPUT_EVENT_TYPES.map((eventType) =>
    Number(
      $.CGEventSourceCounterForEventType(
        $.kCGEventSourceStateHIDSystemState,
        eventType,
      ),
    ),
  );
}

function sameCounters(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function physicalInputSnapshot() {
  const countersBefore = physicalInputCounters();
  const idleSeconds = physicalIdleSeconds();
  const countersAfter = physicalInputCounters();
  if (
    !Number.isFinite(idleSeconds) ||
    countersBefore.some(
      (counter) => !Number.isSafeInteger(counter) || counter < 0,
    ) ||
    countersAfter.some(
      (counter) => !Number.isSafeInteger(counter) || counter < 0,
    ) ||
    !sameCounters(countersBefore, countersAfter)
  ) {
    fail('user_input_active');
  }
  return { idleSeconds, inputCounters: countersAfter };
}

function acquireInputLease() {
  const snapshot = physicalInputSnapshot();
  if (snapshot.idleSeconds < MIN_PHYSICAL_IDLE_SECONDS) {
    fail('user_input_active');
  }
  return {
    inputCounters: snapshot.inputCounters,
    syntheticInputPosted: false,
  };
}

function waitForInputIdle(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      acquireInputLease();
      return true;
    } catch (error) {
      if (error?.pocketCode !== 'user_input_active') throw error;
    }
    delay(0.1);
  } while (Date.now() < deadline);
  return false;
}

function assertInputLease(lease) {
  const snapshot = physicalInputSnapshot();
  if (
    !sameCounters(snapshot.inputCounters, lease.inputCounters) ||
    (!lease.syntheticInputPosted &&
      snapshot.idleSeconds < MIN_PHYSICAL_IDLE_SECONDS)
  ) {
    fail('user_input_active');
  }
}

function exposureError(error, exposedAt) {
  const result =
    error && typeof error === 'object'
      ? error
      : new Error(String(error));
  result.pocketExactDraftExposedAt = exposedAt;
  return result;
}

function postToConductor(
  pid,
  lease,
  events,
  exactDraftMayBeExposedAt = 0,
) {
  assertInputLease(lease);
  assertSessionUnlocked();
  let eventPosted = false;
  try {
    for (const event of events) {
      $.CGEventPostToPid(pid, event);
      eventPosted = true;
      // The aggregate HID idle timer includes the first targeted synthetic
      // event on macOS. Per-type HID counters do not, so they remain the
      // physical-input proof after this point.
      lease.syntheticInputPosted = true;
    }
    delay(0.03);
    assertSessionUnlocked();
    assertInputLease(lease);
  } catch (error) {
    if (eventPosted && exactDraftMayBeExposedAt > 0) {
      throw exposureError(error, exactDraftMayBeExposedAt);
    }
    throw error;
  }
}

function unicodeChunks(value) {
  const chunks = [];
  let chunk = '';
  for (const scalar of value) {
    if (chunk && chunk.length + scalar.length > MAX_CHUNK_UTF16) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += scalar;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function prepareInput(message) {
  const source = $.CGEventSourceCreate($.kCGEventSourceStatePrivate);
  if (!source) fail('event_source_failed');
  const operations = [];
  const lines = message.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    for (const chunk of unicodeChunks(lines[lineIndex])) {
      const unicodeEvents = buildUnicodeEvents(source, chunk);
      operations.push({
        text: chunk,
        events: [unicodeEvents.keyDown, unicodeEvents.keyUp],
        backing: unicodeEvents.utf16,
      });
    }
    if (lineIndex + 1 < lines.length) {
      operations.push({
        text: '\n',
        events: eventPair(source, KEY_RETURN, $.kCGEventFlagMaskShift),
        backing: null,
      });
    }
  }
  return {
    source,
    clearEvents: [
      ...eventPair(source, KEY_A, $.kCGEventFlagMaskCommand),
      ...eventPair(source, KEY_DELETE),
    ],
    operations,
  };
}

function focusedDraft(process) {
  const focusedElement = process.attributes
    .byName('AXFocusedUIElement')
    .value();
  return normalizedDraft(focusedElement.value());
}

function hasDescendantStaticText(element, expectedText, depth = 0) {
  if (depth > 4) return false;
  for (const child of childElements(element)) {
    let staticText = false;
    try {
      staticText = child.role() === 'AXStaticText';
    } catch {
      // Keep walking descendants even when one attribute is unavailable.
    }
    if (staticText) {
      try {
        if (child.name() === expectedText) return true;
      } catch {
        // Try the value independently.
      }
      try {
        if (child.value() === expectedText) return true;
      } catch {
        // Continue into any exposed descendants.
      }
    }
    if (hasDescendantStaticText(child, expectedText, depth + 1)) return true;
  }
  return false;
}

function assertNotQueuedEditMode(process) {
  const main = webAreaRootElements(process)[2];
  const mainElements = childElements(main);
  const composers = mainElements.filter((candidate) => {
    try {
      return candidate.description() === 'composer';
    } catch {
      return false;
    }
  });
  if (composers.length !== 1) fail('send_unavailable');
  if (
    hasDescendantStaticText(main, QUEUED_EDIT_MARKER) ||
    hasDescendantStaticText(
      composers[0],
      QUEUED_EDIT_PLACEHOLDER,
    )
  ) {
    fail('send_unavailable');
  }
}

function resolveComposerSend(process, expectedDraft) {
  assertNotQueuedEditMode(process);
  const mainElements = childElements(webAreaRootElements(process)[2]);
  const composers = mainElements.filter((candidate) => {
    try {
      return candidate.description() === 'composer';
    } catch {
      return false;
    }
  });
  if (composers.length !== 1) fail('send_unavailable');

  const composerElements = childElements(composers[0]);
  const textAreas = composerElements.filter((candidate) => {
    try {
      const classes = candidate.attributes
        .byName('AXDOMClassList')
        .value();
      return (
        candidate.role() === 'AXTextArea' &&
        candidate.focused() === true &&
        Array.isArray(classes) &&
        COMPOSER_CLASSES.every((name) => classes.includes(name)) &&
        normalizedDraft(candidate.value()) === expectedDraft
      );
    } catch {
      return false;
    }
  });
  if (textAreas.length !== 1) fail('send_unavailable');

  const buttons = composerElements.filter((candidate) => {
    try {
      const classes = candidate.attributes
        .byName('AXDOMClassList')
        .value();
      const pressActions = candidate
        .actions()
        .filter((action) => action.name() === 'AXPress');
      return (
        candidate.role() === 'AXButton' &&
        candidate.enabled() === true &&
        Array.isArray(classes) &&
        SEND_CLASSES.every((name) => classes.includes(name)) &&
        NON_SEND_CLASSES.every((name) => !classes.includes(name)) &&
        pressActions.length === 1
      );
    } catch {
      return false;
    }
  });
  if (buttons.length !== 1) fail('send_unavailable');
  return buttons[0];
}

function waitForExactDraft(pid, expectedDraft) {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    const process = validateFocusedComposer(pid);
    validateRoute(process);
    const refreshed = validateFocusedComposer(pid);
    if (focusedDraft(refreshed) === expectedDraft) return;
    delay(0.02);
  }
  fail('composer_update_failed');
}

function waitForComposerSend(pid, expectedDraft, inputLease) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assertInputLease(inputLease);
    const process = validateFocusedComposer(pid, expectedDraft);
    validateRoute(process);
    const refreshed = validateFocusedComposer(pid, expectedDraft);
    try {
      return resolveComposerSend(refreshed, expectedDraft);
    } catch (error) {
      if (error?.pocketCode !== 'send_unavailable') throw error;
    }
    delay(0.02);
  }
  fail('send_unavailable');
}

function typeAndSendMessage(pid) {
  const message = decodeBase64Environment('POCKET_MESSAGE_BASE64');
  const expectedDraft = decodeBase64Environment(
    'POCKET_EXPECTED_DRAFT_BASE64',
  );
  const replaceDraft = environmentValue('POCKET_REPLACE_DRAFT') === 'true';
  const attemptStartedAt = Number(
    environmentValue('POCKET_ATTEMPT_STARTED_AT'),
  );
  const messageData = $(message).dataUsingEncoding($.NSUTF8StringEncoding);
  if (
    !message.length ||
    !messageData ||
    Number(messageData.length) > MAX_MESSAGE_BYTES ||
    message.includes('\0') ||
    /[\u0001-\u0009\u000b-\u001f\u007f]/.test(message) ||
    !Number.isSafeInteger(attemptStartedAt) ||
    attemptStartedAt <= 0 ||
    attemptStartedAt > Date.now()
  ) {
    fail('invalid_message');
  }

  // Allocate and round-trip every event before clearing an owned draft.
  const prepared = prepareInput(message);
  let inputLease = null;
  let exactDraftExposedAt = 0;
  let pressInvokedAt = 0;
  try {
    inputLease = acquireInputLease();
    assertSessionUnlocked();
    let process = validateFocusedComposer(pid);
    validateRoute(process);
    assertNotQueuedEditMode(process);
    process = validateFocusedComposer(pid);
    const draftReadStartedAt = Date.now();
    const currentDraft = focusedDraft(process);
    if (currentDraft === message) {
      exactDraftExposedAt = draftReadStartedAt;
    } else {
      if (!replaceDraft && currentDraft !== '') fail('draft_conflict');
      if (replaceDraft && currentDraft !== expectedDraft) fail('draft_conflict');

      if (currentDraft !== '') {
        process = validateFocusedComposer(pid, currentDraft);
        validateRoute(process);
        validateFocusedComposer(pid, currentDraft);
        postToConductor(pid, inputLease, prepared.clearEvents);
        waitForExactDraft(pid, '');
      }

      let committedPrefix = '';
      for (const operation of prepared.operations) {
        process = validateFocusedComposer(pid, committedPrefix);
        validateRoute(process);
        validateFocusedComposer(pid, committedPrefix);
        const nextPrefix = committedPrefix + operation.text;
        const possibleExposureAt =
          nextPrefix === message ? Date.now() : 0;
        postToConductor(
          pid,
          inputLease,
          operation.events,
          possibleExposureAt,
        );
        if (possibleExposureAt > 0) {
          exactDraftExposedAt = possibleExposureAt;
        }
        committedPrefix = nextPrefix;
        waitForExactDraft(pid, committedPrefix);
        if (operation.backing) Number(operation.backing.length);
      }
    }

    if (exactDraftExposedAt <= 0) fail('draft_changed');
    assertInputLease(inputLease);
    process = validateFocusedComposer(pid, message);
    validateRoute(process);
    waitForComposerSend(pid, message, inputLease);
    process = validateFocusedComposer(pid, message);
    validateRoute(process);
    process = validateFocusedComposer(pid, message);
    const sendButton = resolveComposerSend(process, message);
    assertInputLease(inputLease);
    assertSessionUnlocked();
    pressInvokedAt = Date.now();
    sendButton.actions.byName('AXPress').perform();
    assertSessionUnlocked();
    assertInputLease(inputLease);
    return `pressed:${pressInvokedAt}`;
  } catch (error) {
    const possibleExposureAt = Number(
      error?.pocketExactDraftExposedAt,
    );
    if (
      exactDraftExposedAt <= 0 &&
      Number.isSafeInteger(possibleExposureAt) &&
      possibleExposureAt > 0
    ) {
      exactDraftExposedAt = possibleExposureAt;
    }
    let inputInterrupted = error?.pocketCode === 'user_input_active';
    if (!inputInterrupted && inputLease) {
      try {
        assertInputLease(inputLease);
      } catch (leaseError) {
        inputInterrupted =
          leaseError?.pocketCode === 'user_input_active';
      }
    }
    if (pressInvokedAt > 0 || exactDraftExposedAt > 0) {
      return `ambiguous:${
        pressInvokedAt || exactDraftExposedAt || attemptStartedAt
      }`;
    }
    if (inputInterrupted) return `interrupted:${attemptStartedAt}`;
    if (error?.pocketCode === 'session_locked') return 'session_locked';
    throw error;
  }
}

function run(argv) {
  if (!Boolean($.AXIsProcessTrusted())) fail('accessibility_disabled');

  const pid = Number(argv[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('invalid_target_pid');

  const operation = environmentValue('POCKET_OPERATION');
  if (operation === 'doctor') {
    assertSessionUnlocked();
    validateFocusedComposer(pid);
    return 'ready';
  }
  if (operation === 'route-check') {
    assertSessionUnlocked();
    const process = validateFocusedComposer(pid);
    validateRoute(process);
    validateFocusedComposer(pid);
    return 'ready';
  }
  if (operation === 'input-check') {
    assertSessionUnlocked();
    return waitForInputIdle() ? 'ready' : 'busy';
  }
  if (operation === 'type-and-send') return typeAndSendMessage(pid);
  fail('invalid_operation');
}
