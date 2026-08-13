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
const SEND_POSITION_CLASS = 'ml-1';
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
const MAX_PRE_TRANSCRIPT_CONTROLS = 1;
const MAX_QUEUED_EDIT_CONTEXT_SIBLINGS = 8;
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

function fail(code, tag = null) {
  const error = new Error(code);
  error.pocketCode = code;
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

const TRANSIENT_READ_ATTEMPTS = 5;
const TRANSIENT_READ_DELAY_SECONDS = 0.05;

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
function withTransientReadRetry(readOnlyCheck) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return readOnlyCheck();
    } catch (error) {
      if (attempt >= TRANSIENT_READ_ATTEMPTS) throw error;
      delay(TRANSIENT_READ_DELAY_SECONDS);
    }
  }
}

function environmentValue(name) {
  const value = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return value ? ObjC.unwrap(value) : null;
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
  const hintProvided = hintValues.some((value) => value !== null);
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
        elements,
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
      if (rootIndex === excludedRootIndex) continue;
      const sidebarElements = routeElements(rootElements[rootIndex]);
      const rootMatches = [];
      for (
        let containerIndex = 0;
        containerIndex < sidebarElements.length;
        containerIndex += 1
      ) {
        const links = routeElements(sidebarElements[containerIndex]);
        for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
          const link = links[linkIndex];
          if (routeRole(link) !== 'AXLink') continue;
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
  const rootElements = webAreaRootElements(process);
  const sessionName = `Close chat ${target.sessionTitle}`;
  const main = resolveMainRoot(rootElements);
  const workspace = resolveWorkspaceRoot(rootElements, target, main.rootIndex);
  if (main.rootIndex === workspace.rootIndex) fail('route_changed');
  const mainElements = main.elements;
  const tabGroupIndex = main.tabGroupIndex;

  const sessionTopology = sessionRadioTopology(
    mainElements[tabGroupIndex],
  );
  const matchingSessions = sessionTopology.filter(
    (entry) => entry.name === sessionName,
  );
  if (matchingSessions.length < target.sessionOrdinal) {
    fail('route_changed');
  }
  const targetSession = matchingSessions[target.sessionOrdinal - 1];
  if (
    !targetSession.selected ||
    sessionTopology.filter((entry) => entry.selected).length !== 1
  ) {
    fail('route_changed');
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
  if (mainElements.length !== lease.mainChildCount) {
    fail('route_changed', `mainChildCount ${mainElements.length}!=${lease.mainChildCount}`);
  }
  const tabGroup = mainElements[lease.tabGroupIndex];
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
    fail('composer_focus_changed');
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
    fail('send_unavailable');
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
    if (!nameReadable || !valueReadable) fail('send_unavailable');
  }

  let children;
  try {
    children = element.uiElements();
  } catch {
    fail('send_unavailable');
  }
  if (!children || typeof children.length !== 'number') {
    fail('send_unavailable');
  }
  for (const child of children) {
    if (hasStaticTextInBoundedTree(child, expectedTexts, budget)) return true;
  }
  return false;
}

function composerSendContext(process) {
  let mainElements;
  try {
    mainElements = resolveMainRoot(webAreaRootElements(process)).elements;
  } catch {
    fail('send_unavailable');
  }
  let composer = null;
  let composerIndex = -1;
  let tabGroupCount = 0;
  let tabGroupIndex = -1;
  const mainRoles = [];
  for (let index = 0; index < mainElements.length; index += 1) {
    const candidate = mainElements[index];
    let role;
    let description;
    try {
      role = candidate.role();
      description = candidate.description();
    } catch {
      fail('send_unavailable');
    }
    mainRoles.push(role);
    if (role === 'AXTabGroup') {
      tabGroupCount += 1;
      tabGroupIndex = index;
    }
    if (description !== 'composer') continue;
    if (composer) fail('send_unavailable');
    composer = candidate;
    composerIndex = index;
  }
  if (
    !composer ||
    tabGroupCount !== 1 ||
    tabGroupIndex < 0 ||
    tabGroupIndex >= composerIndex - 1
  ) {
    fail('send_unavailable');
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
    let candidateChildren;
    let pressActionCount;
    try {
      candidateChildren = mainElements[index].uiElements();
      pressActionCount = mainElements[index]
        .actions()
        .filter((action) => action.name() === 'AXPress')
        .length;
    } catch {
      fail('send_unavailable');
    }
    if (
      mainRoles[index] !== 'AXPopUpButton' ||
      !candidateChildren ||
      typeof candidateChildren.length !== 'number' ||
      candidateChildren.length !== 0 ||
      pressActionCount !== 1
    ) {
      fail('send_unavailable');
    }
  }
  if (
    transcriptBoundaryIndex < 0 ||
    transcriptBoundaryIndex - tabGroupIndex - 1 >
      MAX_PRE_TRANSCRIPT_CONTROLS
  ) {
    fail('send_unavailable');
  }

  const contextElements = mainElements.slice(
    transcriptBoundaryIndex + 1,
    composerIndex + 1,
  );
  if (
    contextElements.length < 1 ||
    contextElements.length > MAX_QUEUED_EDIT_CONTEXT_SIBLINGS + 1
  ) {
    fail('send_unavailable');
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
      fail('send_unavailable');
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
function assertNotQueuedEditMode(process) {
  return withTransientReadRetry(() => {
    const { composer, contextElements } = composerSendContext(process);
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
    return composer;
  });
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

function isComposerSendButton(candidate, preceding) {
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
      classes.includes(SEND_POSITION_CLASS) &&
      SEND_ACTIVE_CLASSES.every((name) => classes.includes(name)) &&
      NON_SEND_CLASSES.every((name) => !classes.includes(name)) &&
      isSpeechControl(preceding) &&
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
  if (textAreas.length !== 1) fail('send_unavailable');

  const buttons = composerElements.filter((candidate, index) =>
    isComposerSendButton(candidate, composerElements[index - 1]),
  );
  if (buttons.length !== 1) fail('send_unavailable');
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

function waitForComposerSend(
  pid,
  expectedDraft,
  inputLease,
  routeLease,
) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    assertInputLease(inputLease);
    const refreshed = withTransientReadRetry(() => {
      const process = validateFocusedComposer(pid, expectedDraft);
      assertRouteLease(process, routeLease);
      return validateFocusedComposer(pid, expectedDraft);
    });
    try {
      return resolveComposerSend(refreshed, expectedDraft);
    } catch (error) {
      if (error?.pocketCode !== 'send_unavailable') throw error;
    }
    delay(0.02);
  }
  fail('send_unavailable');
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

  // Allocate and round-trip every event before clearing an owned draft.
  const prepared = prepareInput(message);
  let inputLease = null;
  let routeLease = null;
  let lastProvenPrefix = null;
  let lastAttemptedPrefix = null;
  let exactDraftExposedAt = 0;
  let pressInvokedAt = 0;
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
    assertNotQueuedEditMode(process);
    process = validateFocusedComposer(pid);
    const draftReadStartedAt = Date.now();
    const currentDraft = focusedDraft(process);
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
    assertInputLease(inputLease);
    waitForComposerSend(pid, message, inputLease, routeLease);
    delay(0.02);
    process = validateFocusedComposer(pid, message);
    assertRouteLease(process, routeLease);
    process = validateFocusedComposer(pid, message);
    const sendButton = resolveComposerSend(process, message);
    const pressAction = resolveComposerPressAction(sendButton);
    assertRouteLease(process, routeLease);
    assertInputLease(inputLease);
    assertSessionUnlocked();
    pressInvokedAt = Date.now();
    pressAction.perform();
    recordPressProvenance(attemptStartedAt, pressInvokedAt);
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
    // attemptStartedAt joins this row to the relay's traceId in relay.out.log,
    // so a send_not_confirmed there can be resolved to the assertion that
    // actually broke rather than the phase that swallowed it.
    recordDiagnostic({
      at: new Date().toISOString(),
      attemptStartedAt,
      failure: lastFailure,
      draftFullyTyped: exactDraftExposedAt > 0,
      pressInvoked: pressInvokedAt > 0,
      provenPrefixLength:
        typeof lastProvenPrefix === 'string' ? lastProvenPrefix.length : null,
      messageLength: message.length,
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
    return 'ready';
  }
  if (operation === 'input-check') {
    assertSessionUnlocked();
    return waitForInputIdle() ? 'ready' : 'busy';
  }
  if (operation === 'type-and-send') return typeAndSendMessage(pid);
  fail('invalid_operation');
}
