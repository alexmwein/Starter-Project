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
const SEND_ACTIVE_CLASSES = [
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
// Conductor renders workspace chrome (branch pickers, status pills, agent
// selectors) between the tab group and the transcript. This budget was 1, and
// the live window measures exactly 1, so a single added control failed every
// send before a character was typed, deterministically, for as long as that
// control stayed on screen. Retrying could not clear it. The band carries no
// safety weight: the composer is proven by its own AXDescription, and the
// queued-edit scan happens after the transcript boundary. So it is budgeted
// like its sibling band rather than pinned to the exact shape of one release.
const MAX_PRE_TRANSCRIPT_CONTROLS = 8;
const MAX_QUEUED_EDIT_CONTEXT_SIBLINGS = 12;
const MAX_QUEUED_EDIT_CONTEXT_CHILDREN = 8;
const MAX_QUEUED_EDIT_CONTEXT_NODES = 96;
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
const KEY_T = 17;
const KEY_W = 13;
const CERTIFIABLE_PRE_SEND_CODES = [
  'composer_focus_changed',
  'composer_update_failed',
  'draft_changed',
  'route_changed',
  'send_unavailable',
];

// send_unavailable is thrown from roughly fifteen separate assertions here, and
// once typing has started the outer catch collapses all of them into
// send_not_confirmed. The relay therefore logged the same opaque string no
// matter which invariant actually broke, so a failing send could never be
// traced to a cause. This records the throwing function chain to a side file
// and deliberately does not touch the strings the AppleScript and relay parse,
// so the wire contract is unchanged and diagnostics can never alter a send.
let lastFailure = null;

function diagnosticsPath() {
  return `${ObjC.unwrap($.NSHomeDirectory())}/.config/conductor-pocket/send-diagnostics.jsonl`;
}

function recordDiagnostic(entry) {
  try {
    const path = diagnosticsPath();
    const data = $(`${JSON.stringify(entry)}\n`).dataUsingEncoding(
      $.NSUTF8StringEncoding,
    );
    if (!data) return;
    if ($.NSFileManager.defaultManager.fileExistsAtPath(path)) {
      const handle = $.NSFileHandle.fileHandleForWritingAtPath(path);
      handle.seekToEndOfFile;
      handle.writeData(data);
      handle.closeFile;
    } else {
      data.writeToFileAtomically(path, true);
    }
  } catch {
    // Diagnostics are best effort and must never fail a send.
  }
}

function fail(code, tag = null, { transientRead = false } = {}) {
  const error = new Error(code);
  error.pocketCode = code;
  if (transientRead) error.pocketTransientRead = true;
  lastFailure = {
    code,
    tag,
    via:
      typeof error.stack === 'string'
        ? error.stack.split('\n').map((frame) => frame.replace(/@$/, ''))
            .filter(Boolean).slice(0, 6).join(' < ')
        : null,
  };
  throw error;
}

// The transport's kill only reaches the outer osascript, so this helper must
// bound its own lifetime: check the deadline in every polling loop and refuse
// to press past it. Null when the relay did not provide one (unit tests).
function automationDeadline() {
  const at = Number(environmentValue('POCKET_DEADLINE_AT'));
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

function assertDeadline(deadlineAt) {
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    fail('deadline_exceeded');
  }
}

const TRANSIENT_READ_ATTEMPTS = 5;
const TRANSIENT_READ_DELAY_SECONDS = 0.05;
const SEND_CONTROL_RECOVERY_WINDOW_MS = 6_000;
const SEND_CONTROL_AUTHORITATIVE_DELAY_MS = 750;
const SEND_CONTROL_AUTHORITATIVE_INTERVAL_MS = 3_000;
const SEND_CONTROL_CERTIFICATION_RESERVE_MS = 8_000;
const PRE_COMPOSER_BUDGET_RESERVE_MS = 15_000;

function assertPreComposerBudget(deadlineAt) {
  if (
    deadlineAt !== null &&
    deadlineAt - Date.now() < PRE_COMPOSER_BUDGET_RESERVE_MS
  ) {
    fail('automation_budget_exhausted');
  }
}

function assertRouteAcquisitionDeadline() {
  let rawDeadline = null;
  try {
    rawDeadline = environmentValue('POCKET_ROUTE_DEADLINE_AT');
  } catch {
    return;
  }
  if (rawDeadline === null) return;
  const deadlineAt = Number(rawDeadline);
  if (
    !Number.isSafeInteger(deadlineAt) ||
    deadlineAt <= 0 ||
    Date.now() >= deadlineAt
  ) {
    fail('automation_budget_exhausted');
  }
}

// Conductor re-renders its transcript continuously while an agent streams, so
// an AX element is routinely replaced between the moment a walk enumerates it
// and the moment an attribute is read off it. Those reads throw, and every
// check in this file treats a throw as proof that an invariant broke, which
// aborted otherwise healthy sends: send_unavailable out of
// assertNotQueuedEditMode before typing, route_changed out of assertRouteLease
// after it.
//
// Re-running a READ-ONLY check against a settled tree separates the two cases:
// a genuine structural change fails every attempt and still aborts the send,
// while a re-render blip passes on the next one. This never relaxes what a
// check asserts and never re-runs a mutation, so it cannot send twice. Only
// wrap read-only inspection with it. assertInputLease and assertSessionUnlocked
// are deliberately excluded: those report real physical-input and lock state,
// and retrying them would erase the signal they exist to carry.
function withTransientReadRetry(readOnlyCheck, shouldRetry = () => true) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return readOnlyCheck();
    } catch (error) {
      if (!shouldRetry(error) || attempt >= TRANSIENT_READ_ATTEMPTS) throw error;
      delay(TRANSIENT_READ_DELAY_SECONDS);
    }
  }
}

function environmentValue(name) {
  const value = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  if (!value) return null;
  const unwrapped = ObjC.unwrap(value);
  return unwrapped === undefined || unwrapped === null ? null : unwrapped;
}

function recordPressProvenance(attemptStartedAt, pressedAt) {
  const markerPath = environmentValue('POCKET_PRESS_MARKER_PATH');
  if (
    typeof markerPath !== 'string' ||
    !markerPath.startsWith('/') ||
    markerPath.length > 4096 ||
    markerPath.includes('\0') ||
    !markerPath.endsWith('/pressed-at') ||
    !Number.isSafeInteger(attemptStartedAt) ||
    attemptStartedAt <= 0 ||
    !Number.isSafeInteger(pressedAt) ||
    pressedAt < attemptStartedAt ||
    pressedAt > Date.now()
  ) {
    fail('press_marker_unavailable');
  }
  const markerText = `${attemptStartedAt}\n${pressedAt}\n`;
  const markerData = $(markerText).dataUsingEncoding(
    $.NSUTF8StringEncoding,
  );
  const fileManager = $.NSFileManager.defaultManager;
  if (
    !markerData ||
    Number(markerData.length) > 64 ||
    fileManager.fileExistsAtPath($(markerPath)) ||
    !fileManager.createFileAtPathContentsAttributes(
      $(markerPath),
      markerData,
      $.NSDictionary.dictionary,
    )
  ) {
    fail('press_marker_unavailable');
  }
}

function prepressMarkerPath(name, suffix) {
  const markerPath = environmentValue(name);
  if (markerPath === null) return null;
  if (
    typeof markerPath !== 'string' ||
    !markerPath.startsWith('/') ||
    markerPath.length > 4096 ||
    markerPath.includes('\0') ||
    !markerPath.endsWith(suffix)
  ) {
    fail('input_helper_unavailable');
  }
  return markerPath;
}

function writePrepressReady(markerPath, attemptStartedAt) {
  const value = `${attemptStartedAt}\n`;
  const data = $(value).dataUsingEncoding($.NSUTF8StringEncoding);
  const fileManager = $.NSFileManager.defaultManager;
  if (
    !data ||
    Number(data.length) > 128 ||
    fileManager.fileExistsAtPath($(markerPath)) ||
    !fileManager.createFileAtPathContentsAttributes(
      $(markerPath),
      data,
      $.NSDictionary.dictionary,
    )
  ) {
    fail('input_helper_unavailable');
  }
}

function readPrepressDecision(markerPath) {
  const data = $.NSData.dataWithContentsOfFile($(markerPath));
  if (!data || Number(data.length) > 128) return null;
  const value = $.NSString.alloc.initWithDataEncoding(
    data,
    $.NSUTF8StringEncoding,
  );
  return value ? ObjC.unwrap(value) : null;
}

function waitForPrepressAuthorization(
  pid,
  inputLease,
  routeLease,
  attemptStartedAt,
) {
  const readyPath = prepressMarkerPath(
    'POCKET_PREPRESS_READY_PATH',
    '/prepress-ready',
  );
  const decisionPath = prepressMarkerPath(
    'POCKET_PREPRESS_DECISION_PATH',
    '/prepress-decision',
  );
  if (readyPath === null && decisionPath === null) return;
  if (readyPath === null || decisionPath === null) {
    fail('input_helper_unavailable');
  }
  const heldDraft = focusedDraft(validateFocusedComposer(pid));
  writePrepressReady(readyPath, attemptStartedAt);
  while (true) {
    assertDeadline(automationDeadline());
    assertInputLease(inputLease);
    assertSessionUnlocked();
    const process = validateFocusedComposer(pid, heldDraft);
    assertRouteLease(process, routeLease);
    if ($.NSFileManager.defaultManager.fileExistsAtPath($(decisionPath))) {
      const decision = readPrepressDecision(decisionPath);
      if (decision === 'allow\n') return;
      const denied = /^deny:([a-z][a-z0-9_]{0,63})\n$/.exec(
        decision || '',
      );
      if (denied) fail(denied[1]);
      fail('input_helper_unavailable');
    }
    delay(0.02);
  }
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

function encodeBase64(value) {
  const data = $(value).dataUsingEncoding($.NSUTF8StringEncoding);
  if (!data) fail('invalid_encoding');
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}

function workspaceMatches(workspaceName, candidateName) {
  return (
    candidateName === workspaceName ||
    candidateName.startsWith(`${workspaceName} +`) ||
    candidateName.startsWith(`${workspaceName} -`) ||
    candidateName.endsWith(`/${workspaceName}`) ||
    candidateName.includes(`/${workspaceName} +`) ||
    candidateName.includes(`/${workspaceName} -`)
  );
}

function workspaceNameAppearsInRoute(workspaceName, candidateName) {
  return workspaceMatches(workspaceName, candidateName);
}

const PROJECT_HEADER_SUFFIX = ' Repo settings New workspace';

function repositoryHeaderMatches(repositoryName, candidateName) {
  if (
    typeof repositoryName !== 'string' ||
    repositoryName.length === 0 ||
    typeof candidateName !== 'string' ||
    !candidateName.endsWith(PROJECT_HEADER_SUFFIX)
  ) {
    return false;
  }
  const label = candidateName.slice(0, -PROJECT_HEADER_SUFFIX.length);
  return (
    label === repositoryName ||
    label === `${repositoryName} ${repositoryName}` ||
    label === `💀 ${repositoryName}`
  );
}

function workspaceBelongsToRepository(
  containerElements,
  workspaceIndex,
  repositoryName,
) {
  if (!repositoryName) return true;
  for (let index = workspaceIndex - 1; index >= 0; index -= 1) {
    assertRouteAcquisitionDeadline();
    const candidate = containerElements[index];
    if (routeRole(candidate) !== 'AXButton') continue;
    const candidateName = routeName(candidate);
    if (!candidateName.endsWith(PROJECT_HEADER_SUFFIX)) continue;
    return repositoryHeaderMatches(repositoryName, candidateName);
  }
  return false;
}

// Conductor exposes a collapsed project as one AXButton row whose flattened
// title is "project project COUNT ...", followed immediately by the next
// project row instead of by AXLink workspace rows. There is no AXExpanded
// attribute to read. Require the repeated project name and a positive integer
// count so an ordinary sidebar button can never masquerade as this diagnosis.
function countedProjectName(rowTitle) {
  if (typeof rowTitle !== 'string' || rowTitle.length > 500) return null;
  const match = /^(.+?)\s+\1\s+([1-9][0-9]*)\b/u.exec(rowTitle.trim());
  if (!match) return null;
  const projectName = match[1].trim();
  if (
    !projectName ||
    projectName.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(projectName)
  ) {
    return null;
  }
  return projectName;
}

// Read-only post-failure diagnosis. This never presses the project row: AXPress
// navigates to repo Settings in Conductor 0.82.6 instead of expanding it. The
// target-link count is checked across every root first, so an unselected or
// duplicate visible route keeps the old generic failure rather than blaming an
// unrelated collapsed project.
function diagnoseWorkspaceFailure(
  process,
  workspaceName,
  repositoryName = '',
) {
  const generic = Object.freeze({
    ok: false,
    code: 'workspace_list_unavailable',
  });
  if (typeof workspaceName !== 'string' || !workspaceName) return generic;

  const collapsedProjects = [];
  let targetLinkCount = 0;
  const rootElements = webAreaRootElements(process);
  for (const root of rootElements) {
    const containers = routeElements(root);
    for (const container of containers) {
      const rows = routeElements(container);
      let currentProject = null;
      const finishProject = () => {
        if (
          typeof currentProject?.name === 'string' &&
          currentProject.workspaceLinks === 0
        ) {
          collapsedProjects.push(currentProject.name);
        }
      };
      for (const row of rows) {
        const role = routeRole(row);
        if (role === 'AXButton') {
          const rowName = routeName(row);
          const legacyName = countedProjectName(rowName);
          const isCurrentProjectHeader =
            typeof rowName === 'string' &&
            rowName.endsWith(PROJECT_HEADER_SUFFIX);
          if (legacyName || isCurrentProjectHeader) {
            finishProject();
            const targetProjectName = repositoryName
              ? repositoryHeaderMatches(repositoryName, rowName)
                ? repositoryName
                : null
              : legacyName;
            currentProject = {
              name: targetProjectName,
              workspaceLinks: 0,
            };
          }
          continue;
        }
        if (role !== 'AXLink') continue;
        const linkName = routeName(row);
        if (
          typeof currentProject?.name === 'string' &&
          typeof linkName === 'string' &&
          workspaceNameAppearsInRoute(workspaceName, linkName)
        ) {
          targetLinkCount += 1;
        }
        if (currentProject) currentProject.workspaceLinks += 1;
      }
      finishProject();
    }
  }

  if (targetLinkCount !== 0 || collapsedProjects.length === 0) {
    return generic;
  }
  return Object.freeze({
    ok: false,
    code: 'workspace_project_collapsed',
    projectName: collapsedProjects[0],
  });
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
  if (rootElements.length < 2) fail('route_changed');
  return rootElements;
}

function routeElements(element) {
  try {
    const elements = element.uiElements();
    if (!elements || typeof elements.length !== 'number') {
      fail('route_changed');
    }
    return elements;
  } catch (error) {
    if (error?.pocketCode === 'route_changed') throw error;
    fail('route_changed');
  }
}

function routeTarget() {
  const repositoryName = environmentValue('POCKET_REPOSITORY_NAME') || '';
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
  const hintValues = [
    environmentValue('POCKET_WORKSPACE_CONTAINER_INDEX'),
    environmentValue('POCKET_WORKSPACE_LINK_INDEX'),
    environmentValue('POCKET_WORKSPACE_SIDEBAR_CHILD_COUNT'),
    environmentValue('POCKET_WORKSPACE_CONTAINER_CHILD_COUNT'),
  ];
  const hintProvided = hintValues.some(
    (value) => value !== null && value !== '',
  );
  let workspaceHint = null;
  if (hintProvided) {
    if (hintValues.some((value) => value === null)) {
      fail('route_changed');
    }
    const [
      containerIndex,
      linkIndex,
      sidebarChildCount,
      containerChildCount,
    ] = hintValues.map(Number);
    if (
      !Number.isSafeInteger(containerIndex) ||
      containerIndex < 0 ||
      !Number.isSafeInteger(linkIndex) ||
      linkIndex < 0 ||
      !Number.isSafeInteger(sidebarChildCount) ||
      sidebarChildCount <= 0 ||
      !Number.isSafeInteger(containerChildCount) ||
      containerChildCount <= 0
    ) {
      fail('route_changed');
    }
    workspaceHint = {
      containerChildCount,
      path: [containerIndex, linkIndex],
      sidebarChildCount,
    };
  }
  return {
    repositoryName,
    sessionOrdinal,
    sessionTitle,
    workspaceHint,
    workspaceName,
  };
}

// Reads one attribute across an ENTIRE collection in a single Apple Event
// instead of one round trip per element. Measured against the live window: each
// individual read costs ~8.5ms regardless of which attribute it is, because the
// cost is the IPC round trip into Conductor's web renderer, not the value. The
// three nested reads this enables over the whole sidebar cost ~39ms where the
// equivalent per-element reads cost ~515ms, and the bulk cost is FLAT in the
// number of workspaces while the per-element cost grows linearly with it.
//
// This is also strictly safer than the per-element loop it replaces: a bulk read
// is one call, so it is a more atomic snapshot than N sequential reads, which
// narrows the Conductor re-render race rather than widening it.
//
// The bulk specifier chain is an optimisation, never a requirement. If it is
// unavailable or returns anything malformed, this falls back to the exact
// per-element reads it replaced, so behaviour is identical and merely slower.
// That keeps the fast path from ever becoming a new way to fail, and it keeps
// the unit tests that model AX nodes as plain objects meaningful.
function bulkRead(collection, elements, bulkReader, elementReader) {
  const values = tryBulk(collection, elements.length, bulkReader);
  if (values) return values;
  return elements.map((element) => elementReader(element));
}

// Bulk with NO fallback: returns the array or null. Callers use this when the
// per-element equivalent would read attributes the original code never touched.
// A blanket fallback there would widen the read set, and a read that HEAD never
// performed is a new way to throw, which on this path means a spurious
// route_changed that strands a send.
function tryBulk(collection, expectedLength, bulkReader) {
  try {
    const values = bulkReader(collection);
    if (Array.isArray(values) && values.length === expectedLength) {
      return values;
    }
  } catch {
    // No bulk specifier chain available (unit-test AX doubles, or a changed API).
  }
  return null;
}

function routeRole(element) {
  try {
    return element.role();
  } catch {
    fail('route_changed');
  }
}

function routeName(element) {
  try {
    return element.name();
  } catch {
    fail('route_changed');
  }
}

function routeDescription(element) {
  try {
    return element.description();
  } catch {
    fail('route_changed');
  }
}

function routeClasses(element) {
  try {
    const classes = element.attributes.byName('AXDOMClassList').value();
    if (!Array.isArray(classes)) fail('route_changed');
    return classes;
  } catch (error) {
    if (error?.pocketCode === 'route_changed') throw error;
    fail('route_changed');
  }
}

function routeSelected(element) {
  try {
    return Boolean(element.value());
  } catch {
    fail('route_changed');
  }
}

function sessionRadioTopology(tabGroup) {
  assertRouteAcquisitionDeadline();
  const topology = [];
  const tabChildren = routeElements(tabGroup);
  // Six Apple Events for the whole tab strip instead of three per tab plus
  // three per nested tab. Only name, path and selected are ever consumed
  // downstream (acquireRouteLease and assertRouteLease), so the element handle
  // the old shape carried is deliberately not rebuilt: reading it back would
  // cost one round trip per tab and nothing reads it.
  // Roles are read for every child by HEAD too, so a per-element fallback here
  // is read-for-read identical. Names and selections are NOT: HEAD only reads
  // them once a child is known to be an AXRadioButton, so those use tryBulk and
  // stay lazy when the bulk chain is unavailable. Widening the read set would
  // invent throws on elements HEAD never touched.
  const roles = bulkRead(tabGroup, tabChildren, (group) => group.uiElements.role(), (element) => routeRole(element));
  const nestedRoles = bulkRead(tabGroup, tabChildren, (group) => group.uiElements.uiElements.role(), (element) => routeElements(element).map((nested) => routeRole(nested)));
  const names = tryBulk(tabGroup, tabChildren.length, (group) => group.uiElements.name());
  const selections = tryBulk(tabGroup, tabChildren.length, (group) => group.uiElements.value());
  const nestedNames = tryBulk(tabGroup, tabChildren.length, (group) => group.uiElements.uiElements.name());
  const nestedSelections = tryBulk(tabGroup, tabChildren.length, (group) => group.uiElements.uiElements.value());
  const nestedChildrenOf = (childIndex) => routeElements(tabChildren[childIndex]);
  for (
    let childIndex = 0;
    childIndex < tabChildren.length;
    childIndex += 1
  ) {
    assertRouteAcquisitionDeadline();
    if (roles[childIndex] === 'AXRadioButton') {
      const tabChild = tabChildren[childIndex];
      topology.push({
        name: names ? names[childIndex] : routeName(tabChild),
        path: [childIndex],
        selected: Boolean(
          selections ? selections[childIndex] : routeSelected(tabChild),
        ),
      });
      continue;
    }
    const childRoles = nestedRoles[childIndex];
    // A tab child whose nested roles cannot be resolved must ABORT, not be
    // skipped. Silently omitting one shifts every later sessionOrdinal, and with
    // two identically titled sessions that can hand the lease the WRONG one.
    if (!Array.isArray(childRoles)) fail('route_changed');
    const childNames = nestedNames ? nestedNames[childIndex] : null;
    const childSelections = nestedSelections ? nestedSelections[childIndex] : null;
    for (const group of [childNames, childSelections]) {
      if (group === null) continue;
      if (!Array.isArray(group) || group.length !== childRoles.length) {
        fail('route_changed');
      }
    }
    let nestedElements = null;
    for (
      let nestedIndex = 0;
      nestedIndex < childRoles.length;
      nestedIndex += 1
    ) {
      assertRouteAcquisitionDeadline();
      if (childRoles[nestedIndex] !== 'AXRadioButton') continue;
      if ((!childNames || !childSelections) && nestedElements === null) {
        nestedElements = nestedChildrenOf(childIndex);
      }
      const nested = nestedElements ? nestedElements[nestedIndex] : null;
      topology.push({
        name: childNames ? childNames[nestedIndex] : routeName(nested),
        path: [childIndex, nestedIndex],
        selected: Boolean(
          childSelections ? childSelections[nestedIndex] : routeSelected(nested),
        ),
      });
    }
  }
  return topology;
}

function resolveMainRoot(rootElements) {
  const candidates = [];
  for (let rootIndex = 0; rootIndex < rootElements.length; rootIndex += 1) {
    assertRouteAcquisitionDeadline();
    const elements = routeElements(rootElements[rootIndex]);
    // Two Apple Events instead of two per child. Same values, same checks.
    const roles = bulkRead(
      rootElements[rootIndex],
      elements,
      (root) => root.uiElements.role(),
      (element) => routeRole(element),
    );
    const descriptions = bulkRead(
      rootElements[rootIndex],
      elements,
      (root) => root.uiElements.description(),
      (element) => routeDescription(element),
    );
    let composerCount = 0;
    let tabGroupCount = 0;
    let tabGroupIndex = -1;
    for (let index = 0; index < elements.length; index += 1) {
      if (roles[index] === 'AXTabGroup') {
        tabGroupCount += 1;
        tabGroupIndex = index;
      }
      if (descriptions[index] === 'composer') {
        composerCount += 1;
      }
    }
    if (tabGroupCount !== 1) continue;
    if (composerCount === 1) {
      candidates.push({
        descriptions,
        elements,
        roles,
        rootIndex,
        tabGroupIndex,
      });
    }
  }
  if (candidates.length !== 1) fail('route_changed');
  return candidates[0];
}

function resolveWorkspaceRoot(rootElements, target, excludedRootIndex = -1) {
  const candidates = [];
  if (target.workspaceHint) {
    const {
      containerChildCount,
      path,
      sidebarChildCount,
    } = target.workspaceHint;
    if (!Array.isArray(path) || path.length !== 2) {
      fail('route_changed');
    }
    for (
      let rootIndex = 0;
      rootIndex < rootElements.length;
      rootIndex += 1
    ) {
      assertRouteAcquisitionDeadline();
      if (rootIndex === excludedRootIndex) continue;
      const sidebarElements = routeElements(rootElements[rootIndex]);
      if (sidebarElements.length !== sidebarChildCount) continue;
      const container = sidebarElements[path[0]];
      if (!container) continue;
      const links = routeElements(container);
      const link = links[path[1]];
      if (
        links.length !== containerChildCount ||
        !link ||
        routeRole(link) !== 'AXLink' ||
        !workspaceBelongsToRepository(
          links,
          path[1],
          target.repositoryName,
        ) ||
        !workspaceMatches(target.workspaceName, routeName(link))
      ) {
        continue;
      }
      const classes = routeClasses(link);
      if (!classes.includes('bg-sidebar-accent')) continue;
      candidates.push({
        classes,
        containerChildCount,
        path: path.slice(),
        rootIndex,
        sidebarChildCount,
      });
    }
  } else {
    for (
      let rootIndex = 0;
      rootIndex < rootElements.length;
      rootIndex += 1
    ) {
      assertRouteAcquisitionDeadline();
      if (rootIndex === excludedRootIndex) continue;
      const sidebarElements = routeElements(rootElements[rootIndex]);
      const rootMatches = [];
      for (
        let containerIndex = 0;
        containerIndex < sidebarElements.length;
        containerIndex += 1
      ) {
        assertRouteAcquisitionDeadline();
        const links = routeElements(sidebarElements[containerIndex]);
        for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
          assertRouteAcquisitionDeadline();
          const link = links[linkIndex];
          if (routeRole(link) !== 'AXLink') continue;
          if (
            !workspaceBelongsToRepository(
              links,
              linkIndex,
              target.repositoryName,
            )
          ) {
            continue;
          }
          if (!workspaceMatches(target.workspaceName, routeName(link))) continue;
          const classes = routeClasses(link);
          rootMatches.push({
            classes,
            containerChildCount: links.length,
            path: [containerIndex, linkIndex],
            rootIndex,
            sidebarChildCount: sidebarElements.length,
          });
        }
      }
      const selectedMatches = rootMatches.filter((candidate) =>
        candidate.classes.includes('bg-sidebar-accent'),
      );
      if (
        selectedMatches.length > 1 ||
        (selectedMatches.length === 1 && rootMatches.length !== 1)
      ) {
        fail('route_changed');
      }
      if (selectedMatches.length === 1) {
        candidates.push(selectedMatches[0]);
      }
    }
  }
  if (
    candidates.length !== 1 ||
    !candidates[0].classes.includes('bg-sidebar-accent')
  ) {
    fail('route_changed');
  }
  return candidates[0];
}

function acquireRouteLease(process, target = routeTarget()) {
  assertRouteAcquisitionDeadline();
  const rootElements = webAreaRootElements(process);
  const sessionName = `Close chat ${target.sessionTitle}`;
  assertRouteAcquisitionDeadline();
  const main = resolveMainRoot(rootElements);
  assertRouteAcquisitionDeadline();
  const workspace = resolveWorkspaceRoot(rootElements, target, main.rootIndex);
  if (main.rootIndex === workspace.rootIndex) {
    fail('route_changed', 'rootOverlap');
  }
  const mainElements = main.elements;
  const tabGroupIndex = main.tabGroupIndex;

  const sessionTopology = sessionRadioTopology(
    mainElements[tabGroupIndex],
  );
  assertRouteAcquisitionDeadline();
  const matchingSessions = sessionTopology.filter(
    (entry) => entry.name === sessionName,
  );
  if (matchingSessions.length < target.sessionOrdinal) {
    fail(
      'route_changed',
      `ordinal ${matchingSessions.length}<${target.sessionOrdinal}`,
    );
  }
  const targetSession = matchingSessions[target.sessionOrdinal - 1];
  if (
    !targetSession.selected ||
    sessionTopology.filter((entry) => entry.selected).length !== 1
  ) {
    fail(
      'route_changed',
      `initialSelected target=${Boolean(targetSession.selected)} count=${sessionTopology.filter((entry) => entry.selected).length}`,
    );
  }

  return Object.freeze({
    mainChildCount: mainElements.length,
    mainRootIndex: main.rootIndex,
    rootCount: rootElements.length,
    sessionName,
    sessionOrdinal: target.sessionOrdinal,
    sessionTopology: Object.freeze(
      sessionTopology.map((entry) =>
        Object.freeze({
          name: entry.name,
          path: Object.freeze(entry.path.slice()),
        }),
      ),
    ),
    sidebarChildCount: workspace.sidebarChildCount,
    sidebarRootIndex: workspace.rootIndex,
    tabGroupIndex,
    targetSessionPath: Object.freeze(targetSession.path.slice()),
    workspaceContainerChildCount: workspace.containerChildCount,
    repositoryName:
      typeof target.repositoryName === 'string'
        ? target.repositoryName
        : '',
    workspaceName: target.workspaceName,
    workspacePath: Object.freeze(workspace.path.slice()),
  });
}

function sameRoutePath(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertRouteLease(process, lease) {
  if (
    !lease ||
    typeof lease.repositoryName !== 'string' ||
    typeof lease.workspaceName !== 'string' ||
    !Array.isArray(lease.workspacePath) ||
    !Array.isArray(lease.targetSessionPath) ||
    !Array.isArray(lease.sessionTopology) ||
    !Number.isSafeInteger(lease.rootCount) ||
    lease.rootCount < 2 ||
    !Number.isSafeInteger(lease.mainRootIndex) ||
    lease.mainRootIndex < 0 ||
    !Number.isSafeInteger(lease.sidebarRootIndex) ||
    lease.sidebarRootIndex < 0 ||
    lease.mainRootIndex >= lease.rootCount ||
    lease.sidebarRootIndex >= lease.rootCount ||
    lease.mainRootIndex === lease.sidebarRootIndex
  ) {
    fail('route_changed', 'leaseShape');
  }

  const rootElements = webAreaRootElements(process);
  if (rootElements.length !== lease.rootCount) {
    fail('route_changed', `rootCount ${rootElements.length}!=${lease.rootCount}`);
  }
  const sidebarRoot = rootElements[lease.sidebarRootIndex];
  if (!sidebarRoot || !rootElements[lease.mainRootIndex]) {
    fail('route_changed', 'rootHandleMissing');
  }
  resolveWorkspaceRoot([sidebarRoot], {
    repositoryName: lease.repositoryName,
    workspaceHint: {
      containerChildCount: lease.workspaceContainerChildCount,
      path: lease.workspacePath,
      sidebarChildCount: lease.sidebarChildCount,
    },
    workspaceName: lease.workspaceName,
  });
  const main = resolveMainRoot(rootElements);
  if (main.rootIndex !== lease.mainRootIndex) {
    fail('route_changed', `mainRootIndex ${main.rootIndex}!=${lease.mainRootIndex}`);
  }
  const mainElements = main.elements;
  // Conductor's toolbar gains and loses chrome while a send is in flight, as git
  // diff counts and check badges update. Both the child count and the tab-group
  // index drift with it: observed at 17, 18, 19 and 20 children, and the index
  // moving from 11 to 13, inside one session. Requiring the count to still equal
  // the value captured at lease time therefore turned unrelated chrome into a
  // PERMANENT route_changed. Evidence: a send whose message was already fully
  // delivered died on "mainChildCount 19!=20", then burned the transport timeout
  // because the mismatch could never resolve.
  //
  // Session identity does not live in the toolbar. It is proven by the workspace
  // root check above and by the tab topology below (names, paths, ordinal, and
  // exactly one selected), every one of which is kept. So take the tab group
  // from the FRESH resolution, which resolveMainRoot already proved unique by
  // requiring exactly one AXTabGroup, instead of trusting a stale index guarded
  // by a brittle count.
  const tabGroup = mainElements[main.tabGroupIndex];
  if (!tabGroup || routeRole(tabGroup) !== 'AXTabGroup') {
    fail('route_changed', 'tabGroupRole');
  }
  const currentTopology = sessionRadioTopology(tabGroup);
  if (currentTopology.length !== lease.sessionTopology.length) {
    fail('route_changed', `topologyLength ${currentTopology.length}!=${lease.sessionTopology.length}`);
  }
  for (let index = 0; index < currentTopology.length; index += 1) {
    const current = currentTopology[index];
    const expected = lease.sessionTopology[index];
    if (current.name !== expected.name) {
      fail(
        'route_changed',
        `tabName[${index}] "${String(current.name).slice(0, 40)}"!="${String(expected.name).slice(0, 40)}"`,
      );
    }
    if (!sameRoutePath(current.path, expected.path)) {
      fail(
        'route_changed',
        `tabPath[${index}] ${JSON.stringify(current.path)}!=${JSON.stringify(expected.path)}`,
      );
    }
  }
  const matchingSessions = currentTopology.filter(
    (entry) => entry.name === lease.sessionName,
  );
  if (matchingSessions.length < lease.sessionOrdinal) {
    fail(
      'route_changed',
      `ordinal ${matchingSessions.length}<${lease.sessionOrdinal}`,
    );
  }
  const targetSession = matchingSessions[lease.sessionOrdinal - 1];
  if (!sameRoutePath(targetSession.path, lease.targetSessionPath)) {
    fail('route_changed', 'targetPath');
  }
  if (!targetSession.selected) {
    fail('route_changed', 'targetDeselected');
  }
  const selectedCount = currentTopology.filter((entry) => entry.selected).length;
  if (selectedCount !== 1) {
    fail('route_changed', `selectedCount ${selectedCount}`);
  }
}

function validatedConductorProcess(pid) {
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
  return process;
}

function conductorProcessForReadOnlyDiagnosis(pid) {
  const conductor = $.NSRunningApplication.runningApplicationWithProcessIdentifier(
    pid,
  );
  if (!conductor || ObjC.unwrap(conductor.bundleIdentifier) !== CONDUCTOR_BUNDLE_ID) {
    fail('invalid_target_process');
  }
  const systemEvents = Application('System Events');
  const process = systemEvents.processes.byName('Conductor');
  if (!process.exists() || Number(process.unixId()) !== pid) {
    fail('invalid_target_process');
  }
  return process;
}

function validateFocusedComposer(pid, expectedDraft = null) {
  const process = validatedConductorProcess(pid);
  let focusedElement;
  let classes;
  try {
    focusedElement = process.attributes
      .byName('AXFocusedUIElement')
      .value();
    classes = focusedElement.attributes
      .byName('AXDOMClassList')
      .value();
  } catch {
    // A focused AX node can be replaced between these two attribute reads while
    // Conductor re-renders. Mark only that bridge failure as retryable. A real
    // role, class, draft, lock, process or route mismatch remains unmarked and
    // therefore still fails on its first readiness sample.
    fail('composer_focus_changed', null, { transientRead: true });
  }
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

function expectedInputCounters() {
  const encoded = environmentValue('POCKET_EXPECTED_INPUT_COUNTERS');
  if (encoded === null || encoded === '') return null;
  const counters = encoded.split(',');
  if (
    counters.length !== PHYSICAL_INPUT_EVENT_TYPES.length ||
    counters.some((counter) => !/^(?:0|[1-9][0-9]*)$/.test(counter))
  ) {
    fail('user_input_active');
  }
  const parsed = counters.map(Number);
  if (
    parsed.some(
      (counter) => !Number.isSafeInteger(counter) || counter < 0,
    )
  ) {
    fail('user_input_active');
  }
  return parsed;
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
  try {
    const focusedElement = process.attributes
      .byName('AXFocusedUIElement')
      .value();
    return normalizedDraft(focusedElement.value());
  } catch {
    fail('composer_focus_changed');
  }
}

function hasStaticTextInBoundedTree(element, expectedTexts, budget) {
  if (budget.remaining <= 0) fail('send_unavailable');
  budget.remaining -= 1;
  let role;
  try {
    role = element.role();
  } catch {
    fail('composer_tree_transient', null, { transientRead: true });
  }
  if (role === 'AXStaticText') {
    let nameReadable = false;
    let valueReadable = false;
    try {
      const elementName = element.name();
      nameReadable = true;
      if (expectedTexts.includes(elementName)) return true;
    } catch {
      // Try the value independently.
    }
    try {
      const elementValue = element.value();
      valueReadable = true;
      if (expectedTexts.includes(elementValue)) return true;
    } catch {
      // Fail below unless the name was independently readable.
    }
    if (!nameReadable || !valueReadable) {
      fail('composer_tree_transient', null, { transientRead: true });
    }
  }

  let children;
  try {
    children = element.uiElements();
  } catch {
    fail('composer_tree_transient', null, { transientRead: true });
  }
  if (!children || typeof children.length !== 'number') {
    fail('composer_tree_transient', null, { transientRead: true });
  }
  for (const child of children) {
    if (hasStaticTextInBoundedTree(child, expectedTexts, budget)) return true;
  }
  return false;
}

function composerSendContext(process) {
  let mainElements;
  // resolveMainRoot has already bulk-read the role and description of every
  // main child in two Apple Events. Re-deriving them one element at a time
  // below costs ~40 round trips, and this function runs three times per send
  // (the queued-edit check, the press-wait decision point, and the pre-press
  // proof), so the duplication was ~1s of every send. Same values, same
  // checks, and the per-element loop is kept verbatim as the fallback for any
  // resolution that could not supply them.
  let bulkRoles = null;
  let bulkDescriptions = null;
  try {
    const main = resolveMainRoot(webAreaRootElements(process));
    mainElements = main.elements;
    if (
      Array.isArray(main.roles) &&
      Array.isArray(main.descriptions) &&
      main.roles.length === mainElements.length &&
      main.descriptions.length === mainElements.length
    ) {
      bulkRoles = main.roles;
      bulkDescriptions = main.descriptions;
    }
  } catch {
    fail('send_unavailable', 'main-root-unresolved');
  }
  let composer = null;
  let composerIndex = -1;
  let tabGroupCount = 0;
  let tabGroupIndex = -1;
  const mainRoles = [];
  for (let index = 0; index < mainElements.length; index += 1) {
    if (bulkRoles) {
      const bulkRole = bulkRoles[index];
      mainRoles.push(bulkRole);
      if (bulkRole === 'AXTabGroup') {
        tabGroupCount += 1;
        tabGroupIndex = index;
      }
      if (bulkDescriptions[index] === 'composer') {
        if (composer) {
          fail('send_unavailable', `two-composers bulk@${index}`);
        }
        composer = mainElements[index];
        composerIndex = index;
      }
      continue;
    }
    const candidate = mainElements[index];
    let role;
    let description;
    try {
      role = candidate.role();
      description = candidate.description();
    } catch {
      fail('send_unavailable', `main-child-unreadable@${index}`);
    }
    mainRoles.push(role);
    if (role === 'AXTabGroup') {
      tabGroupCount += 1;
      tabGroupIndex = index;
    }
    if (description !== 'composer') continue;
    if (composer) fail('send_unavailable', `two-composers@${index}`);
    composer = candidate;
    composerIndex = index;
  }
  if (
    !composer ||
    tabGroupCount !== 1 ||
    tabGroupIndex < 0 ||
    tabGroupIndex >= composerIndex - 1
  ) {
    // Named individually: "no composer" and "two tab groups" are different
    // outages with different fixes, and a bare send_unavailable hid that
    // difference for three failed retries of the same message.
    fail(
      'send_unavailable',
      `layout composer=${composerIndex} tabGroups=${tabGroupCount} ` +
        `tabGroup=${tabGroupIndex} mainChildren=${mainElements.length}`,
    );
  }

  let transcriptBoundaryIndex = -1;
  for (
    let index = tabGroupIndex + 1;
    index < composerIndex;
    index += 1
  ) {
    if (mainRoles[index] === 'AXGroup') {
      transcriptBoundaryIndex = index;
      break;
    }
    // Whatever sits here is workspace chrome. Its role and action set are
    // Conductor's design decision and change between releases, so pinning
    // them (AXPopUpButton with exactly one AXPress and no children) turned
    // every redesign into a total send outage. Only size is load bearing: a
    // container here would mean the boundary found below is not the
    // transcript, and that would move the queued-edit scan off its region.
    let candidateChildren;
    try {
      candidateChildren = mainElements[index].uiElements();
    } catch {
      fail('send_unavailable', `pre-transcript-unreadable@${index}`);
    }
    if (
      !candidateChildren ||
      typeof candidateChildren.length !== 'number' ||
      candidateChildren.length > MAX_QUEUED_EDIT_CONTEXT_CHILDREN
    ) {
      fail(
        'send_unavailable',
        `pre-transcript-container@${index} role=${mainRoles[index]} ` +
          `kids=${candidateChildren ? candidateChildren.length : 'unreadable'}`,
      );
    }
  }
  if (transcriptBoundaryIndex < 0) {
    fail(
      'send_unavailable',
      `no-transcript-boundary tabGroup=${tabGroupIndex} ` +
        `composer=${composerIndex}`,
    );
  }
  if (
    transcriptBoundaryIndex - tabGroupIndex - 1 >
    MAX_PRE_TRANSCRIPT_CONTROLS
  ) {
    fail(
      'send_unavailable',
      `pre-transcript-overflow=${transcriptBoundaryIndex - tabGroupIndex - 1} ` +
        `max=${MAX_PRE_TRANSCRIPT_CONTROLS}`,
    );
  }

  const contextElements = mainElements.slice(
    transcriptBoundaryIndex + 1,
    composerIndex + 1,
  );
  if (
    contextElements.length < 1 ||
    contextElements.length > MAX_QUEUED_EDIT_CONTEXT_SIBLINGS + 1
  ) {
    fail(
      'send_unavailable',
      `context-band=${contextElements.length} ` +
        `max=${MAX_QUEUED_EDIT_CONTEXT_SIBLINGS + 1}`,
    );
  }
  for (const candidate of contextElements.slice(0, -1)) {
    let candidateChildren;
    try {
      candidateChildren = candidate.uiElements();
    } catch {
      fail('send_unavailable');
    }
    if (
      !candidateChildren ||
      typeof candidateChildren.length !== 'number' ||
      candidateChildren.length > MAX_QUEUED_EDIT_CONTEXT_CHILDREN
    ) {
      fail(
        'send_unavailable',
        `context-sibling-oversized kids=` +
          `${candidateChildren ? candidateChildren.length : 'unreadable'} ` +
          `max=${MAX_QUEUED_EDIT_CONTEXT_CHILDREN}`,
      );
    }
  }
  return { composer, contextElements };
}

// This walk reads dozens of attributes off a transcript that re-renders while
// an agent streams, and every read that throws is treated as a failed
// assertion. That made a re-render blip indistinguishable from real queued-edit
// mode and was the single largest cause of aborted sends. Each attempt re-walks
// from `process` with a fresh node budget, so a genuine queued-edit state still
// fails every attempt and still blocks the send.
// Queued-edit mode is entered only by a human clicking "edit queued message"
// in Conductor. Every step of a send is gated on assertInputLease, which aborts
// on any physical input, so once an attempt has proven the composer is not in
// queued-edit mode it cannot enter it before the press without first failing
// that lease. Re-running the bounded subtree scan on the press-wait decision
// point and again on the pre-press proof was therefore pure duplication of a
// ~400ms walk. The structural resolution above still runs every time; only the
// scan is proven once, and the flag is per-process so it cannot outlive the
// attempt that set it.
let queuedEditProven = false;

function assertNotQueuedEditMode(process) {
  return withTransientReadRetry(
    () => {
      const { composer, contextElements } = composerSendContext(process);
      if (queuedEditProven) return composer;
      const budget = { remaining: MAX_QUEUED_EDIT_CONTEXT_NODES };
      if (
        contextElements.slice(0, -1).some((candidate) =>
          hasStaticTextInBoundedTree(
            candidate,
            [QUEUED_EDIT_MARKER],
            budget,
          )
        ) ||
        hasStaticTextInBoundedTree(
          composer,
          [QUEUED_EDIT_MARKER, QUEUED_EDIT_PLACEHOLDER],
          budget,
        )
      ) {
        fail('send_unavailable');
      }
      queuedEditProven = true;
      return composer;
    },
    (error) => error?.pocketTransientRead === true,
  );
}

function uniqueComposerDraft(process) {
  const composer = assertNotQueuedEditMode(process);
  const textAreas = childElements(composer).filter((candidate) => {
    try {
      const classes = candidate.attributes
        .byName('AXDOMClassList')
        .value();
      return (
        candidate.role() === 'AXTextArea' &&
        Array.isArray(classes) &&
        COMPOSER_CLASSES.every((name) => classes.includes(name))
      );
    } catch {
      return false;
    }
  });
  if (textAreas.length !== 1) fail('send_unavailable');
  return normalizedDraft(textAreas[0].value());
}

function certifyPreSendRetry({
  error,
  pid,
  inputLease,
  routeLease,
  lastProvenPrefix,
  lastAttemptedPrefix,
  message,
  exactDraftExposedAt,
  pressInvokedAt,
}) {
  const trackedPrefixes = [
    lastProvenPrefix,
    lastAttemptedPrefix,
    exactDraftExposedAt > 0 && pressInvokedAt <= 0 ? message : null,
  ].filter(
    (prefix, index, values) =>
      typeof prefix === 'string' &&
      (prefix === '' || message.startsWith(prefix)) &&
      values.indexOf(prefix) === index,
  );
  if (
    !CERTIFIABLE_PRE_SEND_CODES.includes(error?.pocketCode) ||
    !inputLease ||
    !routeLease ||
    trackedPrefixes.length === 0
  ) {
    return null;
  }
  try {
    assertInputLease(inputLease);
    let process = validatedConductorProcess(pid);
    assertRouteLease(process, routeLease);
    const firstDraft = uniqueComposerDraft(process);
    assertInputLease(inputLease);
    process = validatedConductorProcess(pid);
    assertRouteLease(process, routeLease);
    const secondDraft = uniqueComposerDraft(process);
    assertRouteLease(process, routeLease);
    assertInputLease(inputLease);
    if (
      firstDraft !== secondDraft ||
      !trackedPrefixes.includes(firstDraft)
    ) {
      return null;
    }
    return encodeBase64(
      JSON.stringify({
        draftBase64: encodeBase64(firstDraft),
        inputCounters: inputLease.inputCounters.join(','),
        kind:
          firstDraft === message
            ? 'exact-draft-unpressed'
            : 'partial-draft-unpressed',
      }),
    );
  } catch {
    return null;
  }
}

function isSpeechControl(candidate) {
  if (!candidate) return false;
  try {
    if (candidate.role() !== 'AXButton') return false;
  } catch {
    return false;
  }
  for (const readLabel of [
    () => candidate.name(),
    () => candidate.description(),
  ]) {
    try {
      if (readLabel() === 'Speech to text') return true;
    } catch {
      // Either stable AX label is sufficient; read them independently.
    }
  }
  return false;
}

function isComposerSendButton(candidate, preceding, requireSpeechAnchor = true) {
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
      SEND_ACTIVE_CLASSES.every((name) => classes.includes(name)) &&
      NON_SEND_CLASSES.every((name) => !classes.includes(name)) &&
      (!requireSpeechAnchor || isSpeechControl(preceding)) &&
      pressActions.length === 1
    );
  } catch {
    return false;
  }
}

function resolveComposerSend(process, expectedDraft) {
  const composer = assertNotQueuedEditMode(process);
  const composerElements = childElements(composer);
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
  if (textAreas.length !== 1) {
    // Name WHY zero (or several) qualified, or every send failure here reads
    // as the same opaque word. Focus and draft state are the two that actually
    // vary at runtime.
    const states = composerElements
      .filter((candidate) => {
        try {
          return candidate.role() === 'AXTextArea';
        } catch {
          return false;
        }
      })
      .map((candidate) => {
        try {
          const draft = normalizedDraft(candidate.value());
          return `focused=${candidate.focused()},draftLen=${draft.length},want=${expectedDraft.length}`;
        } catch {
          return 'unreadable';
        }
      });
    fail('send_unavailable', `textAreas=${textAreas.length} [${states.join(' | ')}]`);
  }

  let buttons = composerElements.filter((candidate, index) =>
    isComposerSendButton(candidate, composerElements[index - 1]),
  );
  if (buttons.length === 0) {
    // The speech anchor requires the sibling before Send to be an AXButton
    // labeled "Speech to text". Conductor stopped exposing that label (it now
    // reads name=null, description=""), so the anchored matcher found ZERO
    // buttons and every send died at the press step: proven live by a fully
    // delivered draft failing with `buttons=0` until the deadline. The anchor
    // still runs first so it keeps working the moment the label returns; the
    // fallback drops ONLY the label requirement and keeps every discriminating
    // condition (active classes, none of the disabled-state classes, enabled,
    // exactly one press action), and it is accepted ONLY when it identifies
    // exactly one candidate, so ambiguity still fails closed rather than
    // pressing a guess. Conductor 0.83 removed the old ml-1 layout class from
    // this control, so layout is deliberately not part of the identity proof.
    buttons = composerElements.filter((candidate, index) =>
      isComposerSendButton(candidate, composerElements[index - 1], false),
    );
  }
  if (buttons.length !== 1) fail('send_unavailable', `buttons=${buttons.length}`);
  return buttons[0];
}

function resolveComposerPressAction(sendButton) {
  try {
    const pressActions = sendButton
      .actions()
      .filter((action) => action.name() === 'AXPress');
    if (pressActions.length === 1) return pressActions[0];
  } catch {
    // Normalize a stale or unreadable AX action lookup as a pre-press failure.
  }
  fail('send_unavailable');
}

// This is the hot loop of a send: it runs after the draft is cleared and again
// after every typed chunk. Measured on a live window, one assertRouteLease walk
// costs ~1990ms because it re-reads the whole tree, while the focused-element
// read this loop actually needs costs ~90ms. Proving the route on every poll
// therefore spent seconds per chunk re-deriving something that cannot have
// changed between two 20ms samples, and it is the bulk of why a send took 26 to
// 45 seconds. That latency was not only slow, it was the exposure window for
// the re-render race that aborted sends.
//
// The route is still proven, once, at the decision point: nothing returns from
// here without a full route proof plus a focused-composer check, so the
// guarantee at the moment the caller proceeds is unchanged. Only the redundant
// per-poll re-derivation is gone.
function waitForExactDraft(pid, expectedDraft, routeLease) {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    const polled = withTransientReadRetry(() => validateFocusedComposer(pid));
    if (focusedDraft(polled) === expectedDraft) {
      withTransientReadRetry(() => {
        const process = validateFocusedComposer(pid, expectedDraft);
        assertRouteLease(process, routeLease);
        return validateFocusedComposer(pid, expectedDraft);
      });
      return;
    }
    delay(0.02);
  }
  fail('composer_update_failed');
}

// A poll only needs to answer "has the Send control appeared yet", and the
// full resolveComposerSend answer costs ~1s because it re-derives the whole
// main-root structure and re-runs the bounded queued-edit scan on every
// iteration. Measured: the press wait spent 6.8s of an 18.5s send doing exactly
// that. This reaches the composer through the focused textarea's AXParent and
// bulk-reads the class lists of its children in a SINGLE Apple Event, so the
// probe costs a handful of round trips instead of a full walk.
//
// It is deliberately NOT a proof: a true result only ends the cheap wait, and
// the caller then runs the complete resolveComposerSend plus route proof at the
// decision point before anything is pressed. A false streak receives a bounded
// authoritative read in waitForComposerSend.
function sendControlLikelyReady(pid, expectedDraft) {
  let process;
  try {
    process = withTransientReadRetry(
      () => validateFocusedComposer(pid, expectedDraft),
      (error) => error?.pocketTransientRead === true,
    );
  } catch (error) {
    // Structured validation failures carry safety and recovery meaning. Do
    // not flatten draft, lock, route or target failures into 250 more polls.
    // An unstructured AX bridge throw can still be retried by the next cheap
    // sample without authorizing a press.
    if (typeof error?.pocketCode === 'string') throw error;
    return false;
  }
  try {
    const focused = process.attributes.byName('AXFocusedUIElement').value();
    const composer = focused.attributes.byName('AXParent').value();
    const children = childElements(composer);
    if (children.length === 0) return false;
    let classGroups = tryBulk(composer, children.length, (group) =>
      group.uiElements.attributes.byName('AXDOMClassList').value(),
    );
    if (!classGroups) {
      // Some Accessibility bridges cannot construct the bulk specifier even
      // though the same attribute remains readable on each child. Keep that
      // case cheap and local to the composer. An unreadable child contributes
      // no match, so an incomplete probe can never authorize the expensive
      // decision-point proof on every poll.
      let complete = true;
      classGroups = children.map((child) => {
        try {
          const classes = child.attributes
            .byName('AXDOMClassList')
            .value();
          if (Array.isArray(classes)) return classes;
        } catch {
          // Mark the snapshot incomplete below.
        }
        complete = false;
        return null;
      });
      if (!complete) return false;
    }
    if (classGroups.some((classes) => !Array.isArray(classes))) return false;
    let matches = 0;
    for (const classes of classGroups) {
      if (!Array.isArray(classes)) continue;
      if (
        SEND_ACTIVE_CLASSES.every((name) => classes.includes(name)) &&
        NON_SEND_CLASSES.every((name) => !classes.includes(name))
      ) {
        matches += 1;
      }
    }
    return matches === 1;
  } catch {
    // A later poll can retry a transient read. Only a positive class match is
    // allowed to spend the full resolver and advance to its decision proof.
    return false;
  }
}

function waitForComposerSend(
  pid,
  expectedDraft,
  inputLease,
) {
  // Split into a cheap poll and a single decision-point proof. The old shape
  // proved the whole route on EVERY iteration, so a persistent mismatch
  // multiplied into 250 iterations x 5 transient retries x a full route walk:
  // minutes of spinning, and one orphaned helper was observed still running
  // 2.5 minutes after the transport gave up at 45s. The poll now reads only
  // the focused composer and the Send control (~100ms). A rate limited full
  // Send resolution recovers an incomplete cheap Accessibility snapshot.
  // The caller then performs its two pinned route proofs immediately before
  // the press. Repeating one of those proofs here only produced a result that
  // the caller discarded, at a measured cost of about two seconds.
  const deadlineAt = automationDeadline();
  const waitStartedAt = Date.now();
  const recoveryDeadlineAt = Math.min(
    waitStartedAt + SEND_CONTROL_RECOVERY_WINDOW_MS,
    deadlineAt === null
      ? Number.POSITIVE_INFINITY
      : Math.max(
          waitStartedAt,
          deadlineAt - SEND_CONTROL_CERTIFICATION_RESERVE_MS,
        ),
  );
  let nextAuthoritativeAt =
    waitStartedAt + SEND_CONTROL_AUTHORITATIVE_DELAY_MS;
  // Each iteration's send_unavailable is swallowed by design (the button may
  // simply not be ready yet), which meant a loop that died of exhaustion or
  // deadline reported nothing about WHY no iteration ever succeeded. Carry the
  // last swallowed failure into the terminal one.
  let lastSwallowed = null;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const sampledAt = Date.now();
    if (deadlineAt !== null && sampledAt >= deadlineAt) {
      fail(
        'deadline_exceeded',
        `press-wait; last inner: ${lastSwallowed ? `${lastSwallowed.tag || ''} via ${lastSwallowed.via}` : 'none recorded'}`,
      );
    }
    if (lastSwallowed && sampledAt >= recoveryDeadlineAt) {
      fail(
        'send_unavailable',
        `press-wait recovery; last inner: ${lastSwallowed ? `${lastSwallowed.tag || ''} via ${lastSwallowed.via}` : 'none recorded'}`,
      );
    }
    assertInputLease(inputLease);
    const likelyReady = sendControlLikelyReady(pid, expectedDraft);
    const afterProbeAt = Date.now();
    if (deadlineAt !== null && afterProbeAt >= deadlineAt) {
      fail(
        'deadline_exceeded',
        `press-wait; last inner: ${lastSwallowed ? `${lastSwallowed.tag || ''} via ${lastSwallowed.via}` : 'none recorded'}`,
      );
    }
    if (!likelyReady && afterProbeAt >= recoveryDeadlineAt) {
      fail(
        'send_unavailable',
        `press-wait recovery; last inner: ${lastSwallowed ? `${lastSwallowed.tag || ''} via ${lastSwallowed.via}` : 'none recorded'}`,
      );
    }
    const authoritativeDue = afterProbeAt >= nextAuthoritativeAt;
    const firstLikelyResolution = likelyReady && lastSwallowed === null;
    if (firstLikelyResolution || authoritativeDue) {
      try {
        return withTransientReadRetry(
          () => {
            const process = validateFocusedComposer(pid, expectedDraft);
            return resolveComposerSend(process, expectedDraft);
          },
          (error) => error?.pocketTransientRead === true,
        );
      } catch (error) {
        // The probe is a hint, not a proof. When the full check disagrees the
        // control simply is not ready yet, so keep polling exactly as before
        // rather than turning a cheap false positive into a failed send.
        if (error?.pocketCode !== 'send_unavailable') throw error;
        lastSwallowed = lastFailure;
        // Schedule from the end of the authoritative read. A slow AX walk must
        // not make the next expensive read immediately overdue.
        nextAuthoritativeAt =
          Date.now() + SEND_CONTROL_AUTHORITATIVE_INTERVAL_MS;
      }
    }
    delay(0.02);
  }
  fail(
    'send_unavailable',
    `press-wait exhausted; last inner: ${lastSwallowed ? `${lastSwallowed.tag || ''} via ${lastSwallowed.via}` : 'none recorded'}`,
  );
}

// Deliver the ENTIRE message in one Accessibility write instead of typing it in
// 256-character chunks with a route and draft proof between every chunk. Each
// chunk boundary was a window where a Conductor re-render, or a single keystroke
// from the operator at the Mac, aborted a send that had already half-landed;
// every newline was its own operation with its own proof pass; and long messages
// deterministically exceeded the transport timeout.
//
// Verified against the live composer: the value sticks, reads back byte-exact,
// and the Send control appears, which proves the editor registers the write
// rather than silently ignoring it.
//
// Returns false rather than throwing on any doubt, so the caller falls back to
// the proven chunked path. The fast path can never become a new way to fail, and
// nothing here presses anything: the exact-draft proof and the route proof still
// run before the press exactly as before.
function deliverWholeMessage(pid, message) {
  try {
    const process = validateFocusedComposer(pid);
    const focused = process.attributes.byName('AXFocusedUIElement').value();
    focused.value = message;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (focusedDraft(validateFocusedComposer(pid)) === message) return true;
      delay(0.02);
    }
  } catch {
    // Fall back to chunked typing.
  }
  try {
    // Leave nothing half-written for the fallback to trip over.
    const process = validateFocusedComposer(pid);
    process.attributes.byName('AXFocusedUIElement').value().value = '';
  } catch {
    // The chunked path clears the composer itself.
  }
  return false;
}

function sendPhaseTimings({
  attemptStartedAt,
  helperStartedAt,
  routeReadyAt,
  draftReadyAt,
  sendReadyAt,
  pressInvokedAt,
  completedAt,
}) {
  const elapsed = (startedAt, finishedAt) => {
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) return null;
    const phaseFinishedAt =
      Number.isSafeInteger(finishedAt) && finishedAt > 0
        ? finishedAt
        : completedAt;
    return Math.max(0, phaseFinishedAt - startedAt);
  };
  return {
    outerNavigationMs: Math.max(0, helperStartedAt - attemptStartedAt),
    routeAcquireMs: elapsed(helperStartedAt, routeReadyAt),
    draftReadyMs:
      routeReadyAt > 0 ? elapsed(routeReadyAt, draftReadyAt) : null,
    sendReadyMs:
      draftReadyAt > 0 ? elapsed(draftReadyAt, sendReadyAt) : null,
    finalProofMs:
      sendReadyAt > 0 ? elapsed(sendReadyAt, pressInvokedAt) : null,
    postPressChecksMs:
      pressInvokedAt > 0 ? elapsed(pressInvokedAt, completedAt) : null,
    totalMs: Math.max(0, completedAt - attemptStartedAt),
  };
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
  const carriedInputCounters = expectedInputCounters();
  const helperStartedAt = Date.now();

  // Allocate and round-trip every event before clearing an owned draft.
  const prepared = prepareInput(message);
  let inputLease = null;
  let routeLease = null;
  let lastProvenPrefix = null;
  let lastAttemptedPrefix = null;
  let exactDraftExposedAt = 0;
  let pressInvokedAt = 0;
  let routeReadyAt = 0;
  let draftReadyAt = 0;
  let sendReadyAt = 0;
  try {
    inputLease = acquireInputLease();
    if (
      carriedInputCounters &&
      !sameCounters(
        inputLease.inputCounters,
        carriedInputCounters,
      )
    ) {
      fail('user_input_active');
    }
    assertSessionUnlocked();
    let process = validateFocusedComposer(pid);
    routeLease = acquireRouteLease(process);
    routeReadyAt = Date.now();
    assertNotQueuedEditMode(process);
    assertPreComposerBudget(automationDeadline());
    process = validateFocusedComposer(pid);
    const draftReadStartedAt = Date.now();
    const currentDraft = focusedDraft(process);
    waitForPrepressAuthorization(
      pid,
      inputLease,
      routeLease,
      attemptStartedAt,
    );
    if (currentDraft === message) {
      exactDraftExposedAt = draftReadStartedAt;
    } else {
      if (!replaceDraft && currentDraft !== '') fail('draft_conflict');
      if (replaceDraft && currentDraft !== expectedDraft) fail('draft_conflict');
      if (currentDraft === '') lastProvenPrefix = '';

      if (deliverWholeMessage(pid, message)) {
        lastProvenPrefix = message;
        exactDraftExposedAt = Date.now();
      } else {

      if (currentDraft !== '') {
        process = validateFocusedComposer(pid, currentDraft);
        assertRouteLease(process, routeLease);
        validateFocusedComposer(pid, currentDraft);
        postToConductor(pid, inputLease, prepared.clearEvents);
        waitForExactDraft(pid, '', routeLease);
        lastProvenPrefix = '';
      }

      let committedPrefix = '';
      for (const operation of prepared.operations) {
        process = validateFocusedComposer(pid, committedPrefix);
        assertRouteLease(process, routeLease);
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
        lastAttemptedPrefix = nextPrefix;
        if (possibleExposureAt > 0) {
          exactDraftExposedAt = possibleExposureAt;
        }
        waitForExactDraft(pid, nextPrefix, routeLease);
        committedPrefix = nextPrefix;
        lastProvenPrefix = nextPrefix;
        lastAttemptedPrefix = null;
        if (operation.backing) Number(operation.backing.length);
      }
      }
    }

    if (exactDraftExposedAt <= 0) fail('draft_changed');
    draftReadyAt = Date.now();
    assertInputLease(inputLease);
    waitForComposerSend(pid, message, inputLease);
    sendReadyAt = Date.now();
    delay(0.02);
    process = validateFocusedComposer(pid, message);
    const sendButton = resolveComposerSend(process, message);
    const pressAction = resolveComposerPressAction(sendButton);
    assertRouteLease(process, routeLease);
    assertInputLease(inputLease);
    assertSessionUnlocked();
    // Never press past the deadline: the transport has already (or is about
    // to) report this attempt failed, and a press after that report is a
    // phantom send the operator would then duplicate by retrying.
    assertDeadline(automationDeadline());
    pressInvokedAt = Date.now();
    recordPressProvenance(attemptStartedAt, pressInvokedAt);
    pressAction.perform();
    assertSessionUnlocked();
    assertInputLease(inputLease);
    const completedAt = Date.now();
    recordDiagnostic({
      at: new Date().toISOString(),
      attemptStartedAt,
      outcome: 'pressed',
      timings: sendPhaseTimings({
        attemptStartedAt,
        helperStartedAt,
        routeReadyAt,
        draftReadyAt,
        sendReadyAt,
        pressInvokedAt,
        completedAt,
      }),
    });
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
    // attemptStartedAt joins this row to the relay's traceId in relay.out.log,
    // so a send_not_confirmed there can be resolved to the assertion that
    // actually broke rather than the phase that swallowed it.
    const completedAt = Date.now();
    recordDiagnostic({
      at: new Date().toISOString(),
      attemptStartedAt,
      failure: lastFailure,
      draftFullyTyped: exactDraftExposedAt > 0,
      pressInvoked: pressInvokedAt > 0,
      provenPrefixLength:
        typeof lastProvenPrefix === 'string' ? lastProvenPrefix.length : null,
      messageLength: message.length,
      timings: sendPhaseTimings({
        attemptStartedAt,
        helperStartedAt,
        routeReadyAt,
        draftReadyAt,
        sendReadyAt,
        pressInvokedAt,
        completedAt,
      }),
    });
    let inputInterrupted = error?.pocketCode === 'user_input_active';
    if (!inputInterrupted && inputLease) {
      try {
        assertInputLease(inputLease);
      } catch (leaseError) {
        inputInterrupted =
          leaseError?.pocketCode === 'user_input_active';
      }
    }
    if (pressInvokedAt > 0) return `ambiguous:${pressInvokedAt}`;
    if (inputInterrupted) return `interrupted:${attemptStartedAt}`;
    if (error?.pocketCode === 'session_locked') return 'session_locked';
    const retryCertificate = certifyPreSendRetry({
      error,
      pid,
      inputLease,
      routeLease,
      lastProvenPrefix,
      lastAttemptedPrefix,
      message,
      exactDraftExposedAt,
      pressInvokedAt,
    });
    if (retryCertificate) return `retryable:${retryCertificate}`;
    throw error;
  }
}

// Tab shortcuts are posted as events TARGETED at Conductor's process, exactly
// like typed text, never as a global System Events keystroke. A global
// keystroke goes wherever focus happens to be, so a focus change mid-operation
// would send Cmd-W to another app; CGEventPostToPid cannot. Verified live:
// Cmd-T creates a chat in the current workspace, Cmd-W closes the SELECTED tab
// and leaves the window open, which is why the caller must prove the intended
// session is selected first.
//
// Gated exactly like a send: process identity and frontmost, screen unlocked,
// and a physical-input lease, so it can never fight the operator for the
// keyboard. It types nothing and presses no Send control.
function postTabShortcut(pid, virtualKey) {
  const inputLease = acquireInputLease();
  assertSessionUnlocked();
  validatedConductorProcess(pid);
  const source = $.CGEventSourceCreate($.kCGEventSourceStatePrivate);
  if (!source) fail('event_source_failed');
  const events = eventPair(source, virtualKey, $.kCGEventFlagMaskCommand);
  postToConductor(pid, inputLease, events);
  return 'ready';
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
    const routeLease = acquireRouteLease(process);
    const refreshed = validateFocusedComposer(pid);
    assertRouteLease(refreshed, routeLease);
    validateFocusedComposer(pid);
    return [
      'ready',
      routeLease.workspacePath[0],
      routeLease.workspacePath[1],
      routeLease.sidebarChildCount,
      routeLease.workspaceContainerChildCount,
    ].join(':');
  }
  if (operation === 'input-check') {
    assertSessionUnlocked();
    return waitForInputIdle() ? 'ready' : 'busy';
  }
  if (operation === 'workspace-failure') {
    assertSessionUnlocked();
    // Diagnosis is read-only and may run while Conductor is visible behind
    // another app. Requiring frontmost here would turn the useful collapsed
    // result back into the generic code unless Pocket first stole focus.
    const process = conductorProcessForReadOnlyDiagnosis(pid);
    return JSON.stringify(
      diagnoseWorkspaceFailure(
        process,
        environmentValue('POCKET_WORKSPACE_NAME'),
        environmentValue('POCKET_REPOSITORY_NAME') || '',
      ),
    );
  }
  if (operation === 'tab-new') return postTabShortcut(pid, KEY_T);
  if (operation === 'tab-close') return postTabShortcut(pid, KEY_W);
  if (operation === 'type-and-send') return typeAndSendMessage(pid);
  fail('invalid_operation');
}
