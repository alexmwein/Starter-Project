import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_POLL_MS } from './constants.mjs';

function workspaceDisplayName(row) {
  return (
    row.workspace_name ||
    row.secondary_directory_name?.replaceAll('-', ' ') ||
    row.placeholder_branch_name ||
    row.branch ||
    row.directory_name ||
    'Untitled workspace'
  );
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toolLabel(name) {
  if (!name || typeof name !== 'string') return 'Tool';
  return name
    .replace(/^mcp__/, '')
    .replaceAll('__', ' · ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function parseAssistantRow(row) {
  if (row.role === 'user') {
    return [
      {
        id: row.id,
        rowId: row.row_id,
        kind: 'user',
        text: row.content,
        createdAt: row.created_at,
        sentAt: row.sent_at,
        cancelledAt: row.cancelled_at,
        queued: row.sent_at == null && row.cancelled_at == null,
      },
    ];
  }

  const event = parseJson(row.content);
  if (!event || typeof event !== 'object') return [];

  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    const messages = [];
    for (let index = 0; index < event.message.content.length; index += 1) {
      const item = event.message.content[index];
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        messages.push({
          id: `${row.id}:${index}`,
          rowId: row.row_id,
          kind: 'assistant',
          text: item.text,
          createdAt: row.created_at,
          model: row.model || null,
          turnId: row.turn_id || null,
        });
      } else if (item.type === 'tool_use') {
        messages.push({
          id: `${row.id}:${index}`,
          rowId: row.row_id,
          kind: 'tool',
          toolCallId: item.id || null,
          name: toolLabel(item.name),
          state: 'running',
          createdAt: row.created_at,
          turnId: row.turn_id || null,
        });
      }
    }
    return messages;
  }

  if (event.type === 'user' && Array.isArray(event.message?.content)) {
    return event.message.content.flatMap((item, index) => {
      if (!item || item.type !== 'tool_result') return [];
      return [
        {
          id: `${row.id}:${index}`,
          rowId: row.row_id,
          kind: 'tool-result',
          toolCallId: item.tool_use_id || null,
          state: item.is_error ? 'failed' : 'completed',
          createdAt: row.created_at,
          turnId: row.turn_id || null,
        },
      ];
    });
  }

  if (event.type === 'system') {
    const subtype = typeof event.subtype === 'string' ? event.subtype : 'status';
    const status = typeof event.status === 'string' ? event.status : null;
    if (subtype === 'init') return [];
    return [
      {
        id: row.id,
        rowId: row.row_id,
        kind: 'status',
        label: status || subtype.replaceAll('_', ' '),
        createdAt: row.created_at,
      },
    ];
  }

  return [];
}

export class ConductorDatabase {
  #db;
  #dbPath;
  #statements;

  constructor(dbPath) {
    this.#dbPath = dbPath;
    this.#db = new DatabaseSync(dbPath, { readOnly: true });
    this.#db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    this.#statements = {
      workspaces: this.#db.prepare(`
        SELECT
          w.id,
          w.workspace_name,
          w.secondary_directory_name,
          w.placeholder_branch_name,
          w.branch,
          w.directory_name,
          w.state,
          w.unread,
          w.pinned_at,
          w.updated_at,
          r.name AS repository_name,
          COUNT(s.id) AS session_count,
          COALESCE(SUM(s.unread_count), 0) AS unread_count,
          MAX(COALESCE(s.last_user_message_at, s.updated_at, s.created_at)) AS activity_at,
          SUM(CASE WHEN s.status = 'working' THEN 1 ELSE 0 END) AS working_count
        FROM workspaces w
        JOIN repos r ON r.id = w.repository_id
        LEFT JOIN sessions s ON s.workspace_id = w.id AND s.is_hidden = 0
        WHERE w.state != 'archived' AND r.hidden = 0
        GROUP BY w.id
        ORDER BY
          CASE WHEN w.pinned_at IS NULL THEN 1 ELSE 0 END,
          w.pinned_at DESC,
          activity_at DESC,
          w.updated_at DESC
      `),
      sessions: this.#db.prepare(`
        SELECT
          s.id,
          s.workspace_id,
          s.title,
          s.agent_type,
          s.model,
          s.status,
          s.unread_count,
          s.created_at,
          s.updated_at,
          s.last_user_message_at,
          s.context_used_percent,
          s.queue_paused_at,
          (
            SELECT COUNT(*)
            FROM session_messages queued
            WHERE queued.session_id = s.id
              AND queued.role = 'user'
              AND queued.sent_at IS NULL
              AND queued.cancelled_at IS NULL
          ) AS queued_count
        FROM sessions s
        WHERE s.workspace_id = ? AND s.is_hidden = 0
        ORDER BY COALESCE(s.last_user_message_at, s.updated_at, s.created_at) DESC
      `),
      recentSessions: this.#db.prepare(`
        SELECT
          s.id,
          s.workspace_id,
          s.title,
          s.agent_type,
          s.model,
          s.status,
          s.unread_count,
          s.created_at,
          s.updated_at,
          s.last_user_message_at,
          w.workspace_name,
          w.secondary_directory_name,
          w.placeholder_branch_name,
          w.branch,
          w.directory_name
        FROM sessions s
        JOIN workspaces w ON w.id = s.workspace_id
        JOIN repos r ON r.id = w.repository_id
        WHERE s.is_hidden = 0 AND w.state != 'archived' AND r.hidden = 0
        ORDER BY COALESCE(s.last_user_message_at, s.updated_at, s.created_at) DESC
        LIMIT ?
      `),
      sessionRoute: this.#db.prepare(`
        WITH ranked AS (
          SELECT
            s.id,
            s.workspace_id,
            s.title,
            s.status,
            s.agent_type,
            s.model,
            w.workspace_name,
            w.secondary_directory_name,
            w.placeholder_branch_name,
            w.branch,
            w.directory_name,
            ROW_NUMBER() OVER (
              PARTITION BY s.workspace_id, s.title
              ORDER BY s.created_at, s.id
            ) AS title_ordinal
          FROM sessions s
          JOIN workspaces w ON w.id = s.workspace_id
          WHERE s.is_hidden = 0
        )
        SELECT * FROM ranked WHERE id = ?
      `),
      latestMessages: this.#db.prepare(`
        SELECT
          rowid AS row_id,
          id,
          role,
          content,
          created_at,
          sent_at,
          cancelled_at,
          model,
          turn_id
        FROM session_messages
        WHERE session_id = ?
        ORDER BY rowid DESC
        LIMIT ?
      `),
      messagesAfter: this.#db.prepare(`
        SELECT
          rowid AS row_id,
          id,
          role,
          content,
          created_at,
          sent_at,
          cancelled_at,
          model,
          turn_id
        FROM session_messages
        WHERE session_id = ? AND rowid > ?
        ORDER BY rowid
        LIMIT ?
      `),
      maxRowId: this.#db.prepare(`
        SELECT COALESCE(MAX(rowid), 0) AS row_id
        FROM session_messages
        WHERE session_id = ?
      `),
      exactUserMessageAfter: this.#db.prepare(`
        SELECT
          rowid AS row_id,
          id,
          role,
          content,
          created_at,
          sent_at,
          cancelled_at,
          model,
          turn_id
        FROM session_messages
        WHERE session_id = ?
          AND rowid > ?
          AND role = 'user'
          AND content COLLATE BINARY = ?
          AND cancelled_at IS NULL
        ORDER BY rowid
        LIMIT 1
      `),
      userMessagesAfter: this.#db.prepare(`
        SELECT
          rowid AS row_id,
          id,
          role,
          content,
          created_at,
          sent_at,
          cancelled_at,
          model,
          turn_id
        FROM session_messages
        WHERE session_id = ?
          AND rowid > ?
          AND role = 'user'
          AND cancelled_at IS NULL
        ORDER BY rowid
        LIMIT 100
      `),
    };
  }

  get path() {
    return this.#dbPath;
  }

  close() {
    this.#db.close();
  }

  listWorkspaces() {
    return this.#statements.workspaces.all().map((row) => ({
      id: row.id,
      name: workspaceDisplayName(row),
      repositoryName: row.repository_name,
      branch: row.branch || null,
      state: row.state,
      pinned: row.pinned_at != null,
      sessionCount: Number(row.session_count),
      unreadCount: Number(row.unread_count),
      workingCount: Number(row.working_count),
      activityAt: row.activity_at || row.updated_at,
    }));
  }

  listSessions(workspaceId) {
    return this.#statements.sessions.all(workspaceId).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title || 'Untitled chat',
      agentType: row.agent_type || 'unknown',
      model: row.model || null,
      status: row.status || 'unknown',
      unreadCount: Number(row.unread_count || 0),
      queuedCount: Number(row.queued_count || 0),
      queuePaused: row.queue_paused_at != null,
      contextUsedPercent:
        typeof row.context_used_percent === 'number' ? row.context_used_percent : null,
      activityAt: row.last_user_message_at || row.updated_at || row.created_at,
    }));
  }

  listRecentSessions(limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.#statements.recentSessions.all(safeLimit).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: workspaceDisplayName(row),
      title: row.title || 'Untitled chat',
      agentType: row.agent_type || 'unknown',
      model: row.model || null,
      status: row.status || 'unknown',
      unreadCount: Number(row.unread_count || 0),
      activityAt: row.last_user_message_at || row.updated_at || row.created_at,
    }));
  }

  getSessionRoute(sessionId) {
    const row = this.#statements.sessionRoute.get(sessionId);
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: workspaceDisplayName(row),
      title: row.title || 'Untitled chat',
      titleOrdinal: Number(row.title_ordinal),
      status: row.status || 'unknown',
      agentType: row.agent_type || 'unknown',
      model: row.model || null,
    };
  }

  getSessionMessageCursor(sessionId) {
    return Number(this.#statements.maxRowId.get(sessionId).row_id);
  }

  findExactUserMessageAfter(sessionId, afterRowId, exactContent) {
    const safeAfter = Math.max(0, Number(afterRowId) || 0);
    if (typeof exactContent !== 'string') return null;
    const row = this.#statements.exactUserMessageAfter.get(
      sessionId,
      safeAfter,
      exactContent,
    );
    return row ? parseAssistantRow(row)[0] : null;
  }

  listUserMessagesAfter(sessionId, afterRowId) {
    const safeAfter = Math.max(0, Number(afterRowId) || 0);
    return this.#statements.userMessagesAfter
      .all(sessionId, safeAfter)
      .flatMap(parseAssistantRow);
  }

  listMessages(sessionId, { after = 0, limit = 500 } = {}) {
    if (!this.getSessionRoute(sessionId)) return null;
    const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
    const safeAfter = Math.max(0, Number(after) || 0);
    let rows;
    if (safeAfter > 0) {
      rows = this.#statements.messagesAfter.all(sessionId, safeAfter, safeLimit);
    } else {
      rows = this.#statements.latestMessages.all(sessionId, safeLimit).reverse();
    }
    const messages = rows.flatMap(parseAssistantRow);
    const cursor =
      rows.length > 0
        ? Number(rows.at(-1).row_id)
        : this.getSessionMessageCursor(sessionId);
    return { cursor, messages };
  }
}

export class DatabaseWatcher {
  #dbPath;
  #listeners = new Set();
  #watcher;
  #pollTimer;
  #debounceTimer;
  #lastSignature = '';

  constructor(dbPath) {
    this.#dbPath = dbPath;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start() {
    if (this.#watcher || this.#pollTimer) return;
    const directory = path.dirname(this.#dbPath);
    const relevantNames = new Set([
      path.basename(this.#dbPath),
      `${path.basename(this.#dbPath)}-wal`,
      `${path.basename(this.#dbPath)}-shm`,
    ]);
    try {
      this.#watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
        if (!filename || relevantNames.has(String(filename))) this.#schedule();
      });
      this.#watcher.on('error', () => {
        this.#watcher?.close();
        this.#watcher = undefined;
      });
    } catch {
      this.#watcher = undefined;
    }
    this.#pollTimer = setInterval(() => this.#poll(), DB_POLL_MS);
    this.#pollTimer.unref();
    this.#poll();
  }

  stop() {
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#pollTimer = undefined;
    this.#debounceTimer = undefined;
  }

  #schedule() {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined;
      this.#emit();
    }, 60);
  }

  #poll() {
    const files = [this.#dbPath, `${this.#dbPath}-wal`];
    const signature = files
      .map((file) => {
        try {
          const stat = fs.statSync(file);
          return `${file}:${stat.mtimeMs}:${stat.size}`;
        } catch {
          return `${file}:missing`;
        }
      })
      .join('|');
    if (this.#lastSignature && signature !== this.#lastSignature) this.#schedule();
    this.#lastSignature = signature;
  }

  #emit() {
    const event = { type: 'database-change', at: new Date().toISOString() };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A failed client must not interrupt updates to the other clients.
      }
    }
  }
}
