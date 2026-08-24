import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function source(name) {
  return fs.readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

test('recent chats is the fresh phone route and transcript back destination', async () => {
  const js = await source('app.js');

  assert.match(
    js,
    /route: \{ view: 'recent', workspaceId: null, sessionId: null \}/,
    'the in-memory route must begin on recent chats',
  );
  assert.match(
    js,
    /return \{ view: 'recent', workspaceId: null, sessionId: null \};/,
    'a fresh install must begin on recent chats',
  );
  assert.match(js, /\['recent', 'workspaces', 'sessions', 'transcript'\]/);
  assert.match(js, /backLabel: 'Recent'/);
  assert.match(
    js,
    /onBack: \(\) => navigate\(\{ view: 'recent', workspaceId: null, sessionId: null \}\)/,
    'leaving a transcript must return to recent chats',
  );
  assert.match(js, /const ROUTE_KEY = 'cp:last-route:v2'/);
  assert.match(js, /const LEGACY_ROUTE_KEY = 'cp:last-route:v1'/);
  assert.match(
    js,
    /parsed\.view === 'workspaces'[\s\S]*view: 'recent'/,
    'the old Workspaces home must migrate to Recent Chats once',
  );
  const purge = js.slice(
    js.indexOf('async function purgeLocalData()'),
    js.indexOf('async function startApplication()', js.indexOf('async function purgeLocalData()')),
  );
  assert.match(purge, /localStorage\.removeItem\(ROUTE_KEY\)/);
  assert.match(purge, /localStorage\.removeItem\(LEGACY_ROUTE_KEY\)/);
});

test('the phone home leads with recent chats and keeps workspaces secondary', async () => {
  const js = await source('app.js');

  assert.match(js, /text: recentHome \? 'Recent Chats' : 'Workspaces'/);
  assert.match(js, /button\('Workspaces', \{/);
  assert.match(js, /navigate\(\{ view: 'workspaces', workspaceId: null, sessionId: null \}\)/);
  assert.match(
    js,
    /sessionRow\(session, \{ crossWorkspace: true \}\)/,
    'recent rows must show only quiet workspace context beneath the chat title',
  );
  assert.match(
    js,
    /placeholder: recentHome \? 'Search recent chats' : 'Search workspaces and chats'/,
  );
});

test('the transcript chat controls use all recent chats in newest order', async () => {
  const js = await source('app.js');

  const stripStart = js.indexOf('function renderChatStrip()');
  const stripEnd = js.indexOf('function renderTranscript()', stripStart);
  const strip = js.slice(stripStart, stripEnd);
  assert.match(strip, /recentSessionsNewestFirst\(\)/);
  assert.doesNotMatch(strip, /sessionsFor\(workspaceId\)/);
  assert.match(strip, /workspaceId: session\.workspaceId/);
  assert.match(strip, /className: 'chip-workspace'/);
  assert.match(strip, /text: session\.workspaceName/);

  const sheetStart = js.indexOf('function openChatsSheet()');
  const sheetEnd = js.indexOf('function startEvents()', sheetStart);
  const sheet = js.slice(sheetStart, sheetEnd);
  assert.match(sheet, /recentSessionsNewestFirst\(\)/);
  assert.match(sheet, /session\.workspaceName/);
  assert.match(sheet, /workspaceId: session\.workspaceId/);

  const orderingStart = js.indexOf('function recentSessionsNewestFirst()');
  const orderingEnd = js.indexOf('\n}', orderingStart);
  const ordering = js.slice(orderingStart, orderingEnd);
  assert.match(ordering, /activityAt/);
  assert.match(ordering, /rightActivity - leftActivity/);
});

test('workspace and session request failures render retryable states', async () => {
  const js = await source('app.js');

  assert.match(js, /workspacesError/);
  assert.match(js, /sessionErrorsByWorkspace/);
  assert.match(js, /Workspaces are unavailable/);
  assert.match(js, /Chats are unavailable/);
  assert.match(js, /text: 'Retry'/);
  assert.match(js, /on: \{ click: \(\) => void refreshWorkspaces\(\) \}/);
  assert.match(js, /on: \{ click: \(\) => void loadSessions\(workspace\.id\) \}/);
});

test('connection and panel motion are calm and finger sized', async () => {
  const js = await source('app.js');
  const css = await source('app.css');

  const connection = css.slice(
    css.indexOf('button.connection-voice {'),
    css.indexOf('button.connection-voice:active'),
  );
  assert.match(connection, /min-height: 44px;/);
  assert.match(connection, /min-width: 44px;/);

  assert.match(css, /@keyframes panel-content-enter/);
  assert.match(css, /\.panel\.is-entering \.panel-content/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(
    css.slice(css.indexOf('@keyframes panel-content-enter')),
    /width|height|top|right|bottom|left/,
    'panel motion must not animate layout geometry',
  );

  const narrowPhone = css.slice(
    css.indexOf('@media (max-width: 350px)'),
    css.indexOf('@media (max-width: 399px)'),
  );
  assert.match(narrowPhone, /\.root-title[\s\S]*white-space: nowrap/);
  assert.match(narrowPhone, /font-size: 1\.375rem/);

  assert.match(
    js,
    /state\.shell\.root\.classList\.toggle\([\s\S]*'is-root-route'/,
  );
  assert.match(
    css,
    /@media \(min-width: 600px\)[\s\S]*\.app-shell\.is-root-route[\s\S]*\.workspace-panel[\s\S]*display: flex !important/,
    'Recent Chats must remain visible when a phone rotates past 600 pixels',
  );
});

test('a wide sessions route clears only the mounted chat view', async () => {
  const js = await source('app.js');
  const clearStart = js.indexOf('function clearRenderedSessionView()');
  const clearEnd = js.indexOf('\n}', clearStart) + 2;
  assert.ok(clearStart >= 0, 'the mounted chat view needs an explicit clear path');
  const clearView = js.slice(clearStart, clearEnd);

  assert.match(clearView, /composer\.field\.value = ''/);
  assert.match(clearView, /delete composer\.field\.dataset\.draftRevision/);
  assert.match(clearView, /renderComposerAttachments\(\)/);
  assert.match(clearView, /renderTranscript\(\)/);
  assert.doesNotMatch(
    clearView,
    /saveDraft|localStorage|drafts\.delete/,
    'clearing stale DOM must not clear the saved per-session draft',
  );

  const navigateStart = js.indexOf('function navigate(route, push = true)');
  const navigateEnd = js.indexOf('\n}', navigateStart) + 2;
  const navigate = js.slice(navigateStart, navigateEnd);
  assert.match(
    navigate,
    /route\.view === 'sessions' && !route\.sessionId[\s\S]*clearRenderedSessionView\(\)/,
  );
});

test('an unselected wide transcript asks for a chat instead of loading forever', async () => {
  const js = await source('app.js');
  const placeholderStart = js.indexOf('function renderTranscriptPlaceholder');
  const placeholderEnd = js.indexOf('\n}', placeholderStart) + 2;
  const placeholder = js.slice(placeholderStart, placeholderEnd);
  assert.match(placeholder, /selected/);
  assert.match(placeholder, /Choose a chat/);
  assert.match(placeholder, /Select one from the list/);

  const transcriptStart = js.indexOf('function renderTranscript()');
  const transcriptEnd = js.indexOf('function isMessageContinuation', transcriptStart);
  const transcript = js.slice(transcriptStart, transcriptEnd);
  assert.match(
    transcript,
    /renderTranscriptPlaceholder\(\{[\s\S]*selected: Boolean\(state\.route\.sessionId\)/,
  );
});

test('an unselected transcript cannot capture an orphan phone draft', async () => {
  const js = await source('app.js');
  const composerStart = js.indexOf('function renderComposerState()');
  const composerEnd = js.indexOf('\n}', composerStart) + 2;
  const composer = js.slice(composerStart, composerEnd);

  assert.match(composer, /field\.readOnly = !sessionId \|\| sendQueued/);
  assert.match(
    composer,
    /send\.disabled =[\s\S]*!sessionId[\s\S]*sendQueued/,
  );
});
