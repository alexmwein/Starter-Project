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

export function mapAutomationError(error, markerContext) {
  const details = `${error?.stderr || ''}\n${error?.message || ''}`.toLowerCase();
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
    };
  }
  return result;
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

  doctor() {
    return this.#run({ operation: 'doctor' });
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
    const task = () =>
      this.#run({
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
    this.#queue = this.#queue.then(task, task);
    return this.#queue;
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
    try {
      const { stdout } = await execFileAsync('/usr/bin/osascript', [scriptPath], {
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
          POCKET_ATTEMPT_STARTED_AT: String(attemptStartedAt),
          POCKET_EXPECTED_DRAFT_BASE64: Buffer.from(
            expectedMacDraft,
            'utf8',
          ).toString('base64'),
          POCKET_EXPECTED_INPUT_COUNTERS: expectedInputCounters,
        },
      });
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
      if (pressMarkerDirectory) {
        await rm(pressMarkerDirectory, {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
    }
  }
}
