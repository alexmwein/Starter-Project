import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MAX_MESSAGE_BYTES } from './constants.mjs';
import { normalizeText } from './encoding.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./conductor-send.applescript', import.meta.url));
const inputScriptPath = fileURLToPath(new URL('./conductor-input.js', import.meta.url));
const PHYSICAL_INPUT_COUNTER_COUNT = 16;
const PRESS_MARKER_MAX_BYTES = 64;
const PRESS_MARKER_PREFIX = 'conductor-pocket-press-';
const safeToRetryCodes = new Set([
  'accessibility_disabled',
  'composer_changed_pre_send',
  'composer_unavailable',
  'conductor_not_running',
  'conductor_window_unavailable',
  'draft_conflict',
  'input_helper_unavailable',
  'session_locked',
  'send_unavailable',
  'session_not_visible',
  'user_input_active',
  'workspace_list_unavailable',
  'workspace_not_visible',
  // Control-operation outcomes. None of these touch the composer text or the
  // Send control, so a retry can never duplicate a message.
  'close_not_confirmed',
  'control_not_found',
  'control_press_failed',
  'menu_item_not_found',
  'menu_item_required',
  'new_tab_control_unavailable',
  'menu_not_readable',
  'menu_did_not_open',
]);

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function safeToRetry(code) {
  return { ok: false, code, safeToRetry: true };
}

export function parseResult(stdout) {
  const trimmed = stdout.trim();
  try {
    const result = JSON.parse(trimmed);
    if (!result || typeof result.ok !== 'boolean' || typeof result.code !== 'string') {
      throw new Error('Unexpected result shape');
    }
    const attributionCode =
      result.code === 'sent' ||
      result.code === 'send_not_confirmed' ||
      result.code === 'send_interrupted';
    if (
      attributionCode &&
      (!Number.isSafeInteger(result.pressedAt) ||
        result.pressedAt <= 0 ||
        typeof result.composerOwned !== 'boolean')
    ) {
      throw new Error('Missing ambiguous-send attribution');
    }
    if (
      !attributionCode &&
      (Object.hasOwn(result, 'pressedAt') ||
        Object.hasOwn(result, 'composerOwned'))
    ) {
      throw new Error('Unexpected ambiguous-send attribution');
    }
    if (
      result.code === 'composer_changed_pre_send' &&
      (result.ok ||
        typeof result.retryCertificate !== 'string' ||
        result.retryCertificate.length === 0 ||
        result.retryCertificate.length > 48 * 1024 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          result.retryCertificate,
        ))
    ) {
      throw new Error('Missing composer retry certificate');
    }
    if (!result.ok && safeToRetryCodes.has(result.code)) {
      result.safeToRetry = true;
    }
    return result;
  } catch {
    return { ok: false, code: 'automation_invalid_response' };
  }
}

// Message text and transcript content are protected assets (SECURITY.md),
// and the audit log deliberately carries codes, never content. osascript
// error text can quote the exact value it choked on, so before any of it may
// leave this module as a diagnostic, quoted spans and base64-looking runs
// (how the message and draft travel to the script) are redacted. The code
// recovery below runs on the unredacted text, so redaction never costs a
// recognized code.
function sanitizeAutomationDetail(raw) {
  return raw
    .replace(/[A-Za-z0-9+/=]{20,}/g, '[b64]')
    .replace(/"[^"\n]*"/g, '"[redacted]"')
    .replace(/\u201c[^\u201d\n]*\u201d/g, '"[redacted]"')
    .slice(0, 500);
}

export function mapAutomationError(error, markerContext) {
  const rawDetail = `${error?.stderr || ''}\n${error?.message || ''}`.trim();
  const details = rawDetail.toLowerCase();
  // detail is additive diagnostics: absent when there is nothing to carry,
  // never an empty string a deep-equal consumer must know about.
  const detailProps =
    rawDetail === '' ? {} : { detail: sanitizeAutomationDetail(rawDetail) };
  const pressedAt = validatedPressedAt(markerContext);
  const permissionDenied =
    details.includes('not authorized to send apple events') ||
    details.includes('not allowed assistive access') ||
    details.includes('(-1743)') ||
    details.includes('(-25211)');
  if (
    pressedAt === null && permissionDenied
  ) {
    return {
      ok: false,
      code: 'accessibility_disabled',
      safeToRetry: true,
    };
  }
  const result =
    error?.killed || error?.signal === 'SIGTERM'
      ? { ok: false, code: 'automation_timeout' }
      : { ok: false, code: 'automation_failed' };
  if (pressedAt !== null) {
    return {
      ...result,
      pressedAt,
      composerOwned: true,
      ...detailProps,
    };
  }
  // No proven press. The helpers throw typed pocket codes whose text survives
  // into osascript's stderr even when the run dies before the AppleScript can
  // map them. Recover the code rather than collapsing every distinct failure
  // into automation_failed, which is undiagnosable and always treated as
  // maybe-sent. Only codes from the proven safe-to-retry set are recovered, so
  // this can never loosen delivery semantics for an unrecognized failure, and
  // never for an attempt whose press marker exists (handled above).
  for (const code of safeToRetryCodes) {
    if (details.includes(code)) {
      return {
        ok: false,
        code,
        safeToRetry: true,
        ...detailProps,
      };
    }
  }
  return { ...result, ...detailProps };
}

function validatedPressedAt({
  markerContent,
  attemptStartedAt,
  observedAt,
} = {}) {
  if (
    typeof markerContent !== 'string' ||
    Buffer.byteLength(markerContent, 'utf8') > PRESS_MARKER_MAX_BYTES ||
    !Number.isSafeInteger(attemptStartedAt) ||
    attemptStartedAt <= 0 ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < attemptStartedAt
  ) {
    return null;
  }
  const match = /^([1-9][0-9]*)\n([1-9][0-9]*)\n$/.exec(markerContent);
  if (!match) return null;
  const markerAttemptStartedAt = Number(match[1]);
  const pressedAt = Number(match[2]);
  if (
    !Number.isSafeInteger(markerAttemptStartedAt) ||
    markerAttemptStartedAt !== attemptStartedAt ||
    !Number.isSafeInteger(pressedAt) ||
    pressedAt < attemptStartedAt ||
    pressedAt > observedAt
  ) {
    return null;
  }
  return pressedAt;
}

async function readPressMarker(markerPath) {
  let handle;
  try {
    handle = await open(
      markerPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > PRESS_MARKER_MAX_BYTES) {
      return '';
    }
    return await handle.readFile('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function pressMarkerContext(markerPath, attemptStartedAt) {
  const markerContent = await readPressMarker(markerPath);
  return {
    markerContent,
    attemptStartedAt,
    observedAt: Date.now(),
  };
}

function attributeStructuredFailure(result, markerContext) {
  const pressedAt = validatedPressedAt(markerContext);
  if (
    pressedAt === null ||
    result.ok ||
    (result.composerOwned === true &&
      Number.isSafeInteger(result.pressedAt) &&
      result.pressedAt > 0)
  ) {
    return result;
  }
  return {
    ok: false,
    code:
      result.code === 'automation_timeout'
        ? 'automation_timeout'
        : 'automation_failed',
    pressedAt,
    composerOwned: true,
  };
}

export class AccessibilityTransport {
  #queue = Promise.resolve();
  #busy = 0;
  #currentChild = null;

  doctor() {
    return this.#run({ operation: 'doctor' });
  }

  // Serializes an operation behind everything already queued. This used to be
  // done only inside send(), while every control operation called #run
  // directly, so the comment claiming they could not interleave with a send
  // was false: a tab action arriving mid-send started a SECOND osascript
  // driving the same Conductor window, and the route proof presses the
  // workspace link and session tab, so it could move the window out from under
  // an in-flight send. It also meant a double tap on the phone ran two Cmd+T
  // concurrently and created two chats.
  //
  // doctor() stays off the queue deliberately: it takes no route, presses
  // nothing, and answers the connection endpoint, which must not block behind
  // a 45s send.
  #enqueue(args) {
    const task = () => this.#run(args);
    this.#queue = this.#queue.then(task, task);
    return this.#queue;
  }

  // Control operations reuse the send path's navigation, so each one acts on
  // exactly the workspace and session named.
  listControls(route) {
    return this.#enqueue({ ...route, operation: 'list-controls' });
  }

  openControlMenu(route, controlLabel) {
    return this.#enqueue({ ...route, operation: 'menu-open', controlLabel });
  }

  chooseControlMenuItem(route, controlLabel, menuItem) {
    return this.#enqueue({
      ...route,
      operation: 'menu-choose',
      controlLabel,
      menuItem,
    });
  }

  newTab(route) {
    return this.#enqueue({ ...route, operation: 'tab-new' });
  }

  // Irreversible. confirmClose must be explicitly true or the script refuses.
  closeTab(route, { confirmClose = false } = {}) {
    return this.#enqueue({ ...route, operation: 'tab-close', confirmClose });
  }

  // True while an osascript run is in flight. Shutdown uses this pair to
  // avoid the worst outcome of a dying relay: the parent exiting while its
  // osascript child keeps typing into Conductor with no relay left to record
  // the result.
  get busy() {
    return this.#busy > 0;
  }

  // Wait for the in-flight operation (the queue is serialized, so there is at
  // most one) to settle, up to budgetMs. Resolves true when the transport is
  // idle, false when the budget expired first.
  drain(budgetMs) {
    if (this.#busy === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.#busy === 0), budgetMs);
      timer.unref?.();
      const settle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.#queue.then(settle, settle);
    });
  }

  // Last resort for a forced exit: without this, the orphaned child survives
  // the parent and finishes the send with nobody left to observe it.
  killCurrentAutomation() {
    const child = this.#currentChild;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    try {
      child.kill('SIGKILL');
    } catch {
      return false;
    }
    return true;
  }

  send({
    workspaceName,
    sessionTitle,
    sessionOrdinal,
    message,
    replaceDraft = false,
    expectedMacDraft,
    expectedInputCounters = null,
    timeoutMs = 45_000,
  }) {
    const normalized = normalizeText(message);
    if (!normalized.trim()) {
      return Promise.resolve(safeToRetry('message_empty'));
    }
    if (normalized.includes('\0')) {
      return Promise.resolve(safeToRetry('message_invalid'));
    }
    if (
      !normalized.isWellFormed() ||
      /[\u0001-\u0009\u000b-\u001f\u007f]/.test(normalized)
    ) {
      return Promise.resolve(safeToRetry('message_invalid'));
    }
    if (byteLength(normalized) > MAX_MESSAGE_BYTES) {
      return Promise.resolve(safeToRetry('message_too_large'));
    }
    const normalizedExpectedDraft =
      typeof expectedMacDraft === 'string'
        ? normalizeText(expectedMacDraft)
        : null;
    if (replaceDraft && normalizedExpectedDraft === null) {
      return Promise.resolve(safeToRetry('draft_recheck_required'));
    }
    if (
      normalizedExpectedDraft !== null &&
      byteLength(normalizedExpectedDraft) > MAX_MESSAGE_BYTES
    ) {
      return Promise.resolve(safeToRetry('draft_recheck_required'));
    }
    if (
      expectedInputCounters !== null &&
      (typeof expectedInputCounters !== 'string' ||
        expectedInputCounters.split(',').length !==
          PHYSICAL_INPUT_COUNTER_COUNT ||
        expectedInputCounters
          .split(',')
          .some(
            (counter) =>
              !/^(?:0|[1-9][0-9]*)$/.test(counter) ||
              !Number.isSafeInteger(Number(counter)),
          ))
    ) {
      return Promise.resolve({
        ok: false,
        code: 'automation_invalid_response',
      });
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 45_000
    ) {
      return Promise.resolve({
        ok: false,
        code: 'automation_invalid_response',
      });
    }
    return this.#enqueue({
      operation: 'send',
      workspaceName,
      sessionTitle,
      sessionOrdinal,
      message: normalized,
      replaceDraft,
      expectedMacDraft: normalizedExpectedDraft || '',
      expectedInputCounters: expectedInputCounters || '',
      timeoutMs,
    });
  }

  async #run({
    operation,
    workspaceName = '',
    sessionTitle = '',
    sessionOrdinal = 1,
    message = '',
    replaceDraft = false,
    expectedMacDraft = '',
    expectedInputCounters = '',
    controlLabel = '',
    menuItem = '',
    confirmClose = false,
    timeoutMs = 45_000,
  }) {
    let pressMarkerDirectory = '';
    let pressMarkerPath = '';
    if (operation === 'send') {
      try {
        pressMarkerDirectory = await mkdtemp(
          join(tmpdir(), PRESS_MARKER_PREFIX),
        );
        await chmod(pressMarkerDirectory, 0o700);
        pressMarkerPath = join(pressMarkerDirectory, 'pressed-at');
      } catch {
        if (pressMarkerDirectory) {
          await rm(pressMarkerDirectory, {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
        return safeToRetry('input_helper_unavailable');
      }
    }
    const attemptStartedAt = Date.now();
    this.#busy += 1;
    try {
    try {
      const pending = execFileAsync('/usr/bin/osascript', [scriptPath], {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          POCKET_OPERATION: operation,
          POCKET_WORKSPACE_NAME: workspaceName,
          POCKET_WORKSPACE_NAME_BASE64: Buffer.from(
            workspaceName,
            'utf8',
          ).toString('base64'),
          POCKET_SESSION_TITLE: sessionTitle,
          POCKET_SESSION_TITLE_BASE64: Buffer.from(
            sessionTitle,
            'utf8',
          ).toString('base64'),
          POCKET_SESSION_ORDINAL: String(sessionOrdinal),
          POCKET_MESSAGE_BASE64: Buffer.from(message, 'utf8').toString(
            'base64',
          ),
          POCKET_INPUT_SCRIPT: inputScriptPath,
          POCKET_PRESS_MARKER_PATH: pressMarkerPath,
          POCKET_REPLACE_DRAFT: replaceDraft ? 'true' : 'false',
          POCKET_CONTROL_LABEL_BASE64: Buffer.from(
            controlLabel,
            'utf8',
          ).toString('base64'),
          POCKET_MENU_ITEM_BASE64: Buffer.from(menuItem, 'utf8').toString(
            'base64',
          ),
          // Explicit and positive: closing a chat is irreversible, so the
          // script refuses unless this exact token is present.
          POCKET_CONFIRM_CLOSE: confirmClose === true ? 'yes' : 'no',
          POCKET_ATTEMPT_STARTED_AT: String(attemptStartedAt),
          // The execFile timeout kills the OUTER osascript; the inner JXA
          // helper it spawned survives as an orphan. One was observed still
          // walking the tree 2.5 minutes after the transport had already
          // reported automation_timeout, which is both wasted work and a
          // phantom-press risk. Give the helper its own deadline safely inside
          // the transport's, so it terminates itself with a structured code
          // and nothing outlives the send.
          POCKET_DEADLINE_AT: String(
            Date.now() + Math.max(timeoutMs - 5_000, 5_000),
          ),
          POCKET_EXPECTED_DRAFT_BASE64: Buffer.from(
            expectedMacDraft,
            'utf8',
          ).toString('base64'),
          POCKET_EXPECTED_INPUT_COUNTERS: expectedInputCounters,
        },
      });
      this.#currentChild = pending.child;
      const { stdout } = await pending;
      const result = parseResult(stdout);
      if (!pressMarkerPath) return result;
      return attributeStructuredFailure(
        result,
        await pressMarkerContext(pressMarkerPath, attemptStartedAt),
      );
    } catch (error) {
      return mapAutomationError(
        error,
        pressMarkerPath
          ? await pressMarkerContext(pressMarkerPath, attemptStartedAt)
          : undefined,
      );
    } finally {
      this.#busy -= 1;
      this.#currentChild = null;
    }
    } finally {
      if (pressMarkerDirectory) {
        await rm(pressMarkerDirectory, {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
    }
  }
}
