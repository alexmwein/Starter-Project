import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MAX_MESSAGE_BYTES } from './constants.mjs';
import { normalizeText } from './encoding.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./conductor-send.applescript', import.meta.url));
const inputScriptPath = fileURLToPath(new URL('./conductor-input.js', import.meta.url));
const safeToRetryCodes = new Set([
  'accessibility_disabled',
  'composer_unavailable',
  'composer_update_failed',
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
    if (
      (result.code === 'sent' ||
        result.code === 'send_not_confirmed' ||
        result.code === 'send_interrupted') &&
      (!Number.isSafeInteger(result.pressedAt) ||
        result.pressedAt <= 0 ||
        typeof result.composerOwned !== 'boolean')
    ) {
      throw new Error('Missing ambiguous-send attribution');
    }
    if (!result.ok && safeToRetryCodes.has(result.code)) {
      result.safeToRetry = true;
    }
    return result;
  } catch {
    return { ok: false, code: 'automation_invalid_response' };
  }
}

function mapAutomationError(error) {
  const details = `${error?.stderr || ''}\n${error?.message || ''}`.toLowerCase();
  if (
    details.includes('not authorized to send apple events') ||
    details.includes('not allowed assistive access') ||
    details.includes('(-1743)') ||
    details.includes('(-25211)')
  ) {
    return { ok: false, code: 'accessibility_disabled' };
  }
  if (error?.killed || error?.signal === 'SIGTERM') {
    return { ok: false, code: 'automation_timeout' };
  }
  return { ok: false, code: 'automation_failed' };
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
    const task = () =>
      this.#run({
        operation: 'send',
        workspaceName,
        sessionTitle,
        sessionOrdinal,
        message: normalized,
        replaceDraft,
        expectedMacDraft: normalizedExpectedDraft || '',
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
  }) {
    const attemptStartedAt = Date.now();
    try {
      const { stdout } = await execFileAsync('/usr/bin/osascript', [scriptPath], {
        encoding: 'utf8',
        timeout: 45_000,
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
          POCKET_REPLACE_DRAFT: replaceDraft ? 'true' : 'false',
          POCKET_ATTEMPT_STARTED_AT: String(attemptStartedAt),
          POCKET_EXPECTED_DRAFT_BASE64: Buffer.from(
            expectedMacDraft,
            'utf8',
          ).toString('base64'),
        },
      });
      return parseResult(stdout);
    } catch (error) {
      return mapAutomationError(error);
    }
  }
}
