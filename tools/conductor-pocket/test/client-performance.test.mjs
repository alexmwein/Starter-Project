import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function applicationSource() {
  return fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
}

function functionSource(source, name, nextName) {
  const start = source.indexOf(`${name}(`);
  const end = source.indexOf(`${nextName}(`, start + name.length);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test('warm chat navigation paints before cache or network work', async () => {
  const source = await applicationSource();
  const openSession = functionSource(
    source,
    'async function openSession',
    'async function refreshMessages',
  );

  assert.match(openSession, /state\.sessionOpenController\?\.abort\(\)/);
  assert.match(openSession, /const controller = new AbortController\(\)/);
  const paint = openSession.indexOf('renderTranscript();');
  const cacheRead = openSession.indexOf(
    'cacheGet(`messages:${sessionId}`)',
  );
  const refresh = openSession.indexOf('await refreshMessages');
  assert.ok(paint >= 0);
  assert.ok(cacheRead > paint);
  assert.ok(refresh > paint);
  assert.match(
    openSession,
    /if \(hasMemorySnapshot && hasLiveBaseline\)[\s\S]*refreshMessages\(sessionId, \{[\s\S]*signal: controller\.signal[\s\S]*\}\)[\s\S]*else \{[\s\S]*full: true/,
  );
  assert.match(
    source,
    /full \|\| !state\.messageBaselinesBySession\.has\(sessionId\)/,
  );
});

test('live data paints before noncritical snapshot persistence', async () => {
  const source = await applicationSource();
  const refreshMessages = functionSource(
    source,
    'async function refreshMessages',
    'function dedupeMessages',
  );
  const paint = refreshMessages.indexOf('renderTranscript()');
  const persistence = refreshMessages.indexOf(
    'void cacheSet(`messages:${sessionId}`',
  );

  assert.ok(paint >= 0);
  assert.ok(persistence > paint);
  assert.match(source, /renderWorkspacePanel\(\);\s*void cacheSet\('workspaces'/);
  assert.match(source, /renderSessionsPanel\(\);\s*void cacheSet\(`sessions:/);
});

test('collapsed activity defers hidden Markdown DOM until expansion', async () => {
  const source = await applicationSource();
  const renderActivity = functionSource(
    source,
    'function renderActivity',
    'function renderAgentStatus',
  );

  assert.match(renderActivity, /function populateItems\(\)/);
  assert.match(renderActivity, /if \(expanded\) populateItems\(\)/);
  assert.match(
    renderActivity,
    /if \(nextExpanded\) populateItems\(\)/,
  );
});

test('background failure bursts paint one counted lazy disclosure', async () => {
  const source = await applicationSource();
  const renderTranscript = functionSource(
    source,
    'function renderTranscript',
    'function isMessageContinuation',
  );
  const renderKey = functionSource(
    source,
    'function messageRenderKey',
    'function renderBanner',
  );
  const renderMessage = functionSource(
    source,
    'function renderMessage',
    'function renderActivity',
  );
  const renderActivity = functionSource(
    source,
    'function renderActivity',
    'function renderAgentStatus',
  );

  assert.match(renderKey, /message\.backgroundErrorCount[\s\S]*expanded/);
  assert.match(renderKey, /item\.occurrenceCount/);
  assert.match(
    renderTranscript,
    /announcementId = `\$\{messageId\}:background-errors`[\s\S]*seenMessageIds\.add\(announcementId\)/,
  );
  assert.match(
    renderMessage,
    /occurrenceCount > 1[\s\S]*background actions failed[\s\S]*private action details/,
  );
  assert.match(renderActivity, /hasErrors[\s\S]*icon\('warn'\)/);
  assert.match(renderActivity, /if \(expanded\) populateItems\(\)/);
});

test('streaming transcript and metadata refresh on separate schedules', async () => {
  const source = await applicationSource();
  assert.match(
    source,
    /const transcriptRefresh = createLiveRefreshCoordinator\(\{[\s\S]*delayMs: LIVE_REFRESH_DEBOUNCE_MS/,
  );
  assert.match(
    source,
    /const metadataRefresh = createLiveRefreshCoordinator\(\{[\s\S]*delayMs: METADATA_REFRESH_DEBOUNCE_MS/,
  );
  assert.match(
    source,
    /eventSource\.addEventListener\('change'[\s\S]*transcriptRefresh\.schedule\(\)[\s\S]*metadataRefresh\.schedule\(\)/,
  );
});

test('chat UI styles do not hijack the app’s existing rows', async () => {
  const [css, js] = await Promise.all([
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  // Every session row in the switcher and the sessions panel carries
  // "data-row chat-row". A bare .chat-row rule therefore restyles all of them,
  // which is what left Recent chats with a right-aligned title and a floating
  // timestamp. Sheet-specific styling must stay namespaced.
  assert.match(js, /className: 'data-row chat-row'/);
  assert.doesNotMatch(css, /^\.chat-row\s*\{/m);
  assert.doesNotMatch(css, /^\.chat-row\.is-active\s*\{/m);
  assert.match(css, /^\.chats-sheet-row\s*\{/m);

  // The strip is a flex child of a column panel whose scroll area grows, so it
  // must refuse to shrink or the chips render clipped at half height.
  const strip = css.slice(css.indexOf('.chat-strip {'));
  assert.match(strip.slice(0, strip.indexOf('}')), /flex:\s*0\s+0\s+auto/);
});

test('the chat strip never scrolls the transcript', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const start = js.indexOf('function renderChatStrip()');
  const body = js.slice(start, js.indexOf('\n}\n', start));
  // scrollIntoView walks ancestors, so calling it on a chip scrolls the
  // transcript. This runs on every transcript render, which reads as the screen
  // jumping to the top mid-conversation.
  assert.doesNotMatch(body, /scrollIntoView\(/);
  assert.match(body, /strip\.scrollLeft = /);
  // Recentring on every render would fight a manual scroll of the strip.
  assert.match(body, /lastCentredSessionId !== state\.route\.sessionId/);
});


test('closing a chat is never an inline second tap', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  // An armed control that appears where the first tap landed can be
  // double-tapped by accident, and on a scrolling list the row can move under
  // the finger between taps. Confirmation must be its own sheet.
  assert.match(js, /function confirmCloseChat\(/);
  assert.match(js, /openSheet\(\s*'Close this chat\?'/);
  // The chat is named, so the destructive choice cannot be ambiguous.
  assert.match(js, /className: 'confirm-target'[\s\S]*text: session\.title/);
  // Keep is offered before Close, and Close is the only path that confirms.
  const keep = js.indexOf("text: 'Keep it'");
  const shut = js.indexOf("text: 'Close it'");
  assert.ok(keep >= 0 && shut > keep);
  assert.match(js, /text: 'Close it'[\s\S]*confirm: true/);
  // No armed-in-place state may return.
  assert.doesNotMatch(js, /is-armed/);
});

test('chat strip status costs nothing extra and never animates', async () => {
  const [js, css] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  // Status must come from the session rows already in memory. A dedicated fetch
  // or timer here would put a poll behind every chip.
  const start = js.indexOf('function renderChatStrip()');
  const body = js.slice(start, js.indexOf('\n}\n', start));
  assert.match(body, /STRIP_STATUS\[session\.status\]/);
  assert.doesNotMatch(body, /fetch\(|setInterval\(|request\(/);
  // idle must render nothing, or a dot stops meaning anything.
  assert.doesNotMatch(js, /STRIP_STATUS = \{[\s\S]*\bidle:/);
  // The strip's dots must not inherit the pulsing .status-dot animation.
  const dot = css.slice(css.indexOf('.chip-dot {'));
  assert.doesNotMatch(dot.slice(0, dot.indexOf('}')), /animation/);
  assert.doesNotMatch(body, /status-dot/);
  // The meaning has to reach screen readers, not just sighted users.
  assert.match(body, /aria-label.*state_\.label|state_ \? `\$\{session\.title\}, \$\{state_\.label\}`/);
});

test('the header reports the current chat’s state, including waiting', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  // needs_plan_response used to fall through to the workspace name, hiding the
  // one state that is blocked on the operator.
  assert.match(js, /needs_plan_response'\s*\?\s*'Waiting for you'/);
  // The header marker reuses the strip's still dot, never the pulsing one.
  assert.match(js, /transcriptNav\.subtitle\.prepend\(/);
  assert.match(js, /className: `chip-dot \$\{headerStatus\.dot\}`/);
  // During a connection problem the subtitle describes the connection, so the
  // chat marker must not be layered on top of it.
  assert.match(js, /state\.connection === 'live' && headerStatus/);
});

test('the app can never be left blank, and reading position survives a render', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  // Revealing must never be conditional on a reload that may not land. That
  // left the privacy shield over the app until it was force-quit.
  assert.doesNotMatch(js, /if \(!appUpdateCoordinator\?\.foreground\(\)\) revealApplication\(\)/);
  assert.match(js, /appUpdateCoordinator\?\.foreground\(\);\s*\n\s*revealApplication\(\);/);
  // A visible page with a shield over it must self-correct.
  assert.match(js, /function ensureNotShielded\(\)/);
  assert.match(js, /#privacy-shield'\)[\s\S]*shield\.remove\(\)/);
  // A rescued page needs its stream back or it sits stale and looks broken.
  const fn = js.slice(js.indexOf('function ensureNotShielded()'));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /startEvents\(\)/);
  // The transcript is fully rebuilt each render, so an unpinned reader must be
  // restored to the same distance from the end.
  assert.match(js, /transcriptScroll\.scrollHeight -\s*\n\s*transcriptScroll\.clientHeight -\s*\n\s*distanceBefore/);
});

test('feedback reaches a sighted user, and retry never fails silently', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const html = await fs.readFile(
    new URL('../public/index.html', import.meta.url),
    'utf8',
  );

  // Everything the app says went only to an sr-only aria-live region, so a
  // success and a failure looked identical on a phone: nothing moved. That is
  // why a slow operation read as broken and got tapped again.
  assert.match(html, /id="toast"/);
  const announceStart = js.indexOf('function announce(message)');
  assert.ok(announceStart > 0, 'announce must exist');
  const announceBody = js.slice(announceStart, js.indexOf('\n}\n', announceStart));
  assert.match(announceBody, /announcer\.textContent/);
  assert.match(announceBody, /toastElement/);

  // Tapping Retry used to be able to do nothing at all: three separate gates
  // returned with no message. Every early exit must say something.
  const retryStart = js.indexOf('async function retryMessage(message)');
  assert.ok(retryStart > 0, 'retryMessage must exist');
  const retryBody = js.slice(retryStart, js.indexOf('\n}\n', retryStart));
  assert.doesNotMatch(
    retryBody,
    /if \(!deliveryCanRetry\(message\)\) return;/,
    'a retry gate must not return without telling the operator why',
  );

  // Creating a chat is a multi-second Mac round trip. Without a single-flight
  // guard a second tap posts a second shortcut and creates a second chat.
  assert.match(js, /chatCreationInFlight/);
  const createStart = js.indexOf('async function createChat(');
  const createBody = js.slice(createStart, js.indexOf('\n}\n', createStart));
  assert.match(createBody, /if \(chatCreationInFlight\) return null;/);
  assert.match(createBody, /aria-busy/);
})

test('the composer growing a line does not move the transcript under the reader', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  // The textarea was sized by newline count, so a long line that soft-wrapped
  // still reported one row. Pressing Enter grew it correctly and wrapping did
  // not, which is exactly why the jump happened sometimes and not others.
  assert.doesNotMatch(
    js,
    /field\.rows = Math\.max\(1, Math\.min\(6, field\.value\.split\('\\n'\)\.length\)\)/,
    'composer rows must account for soft wrapping, not just newlines',
  );
  const resizeStart = js.indexOf('const resize = () => {');
  assert.ok(resizeStart > 0, 'composer resize must exist');
  const resizeBody = js.slice(resizeStart, js.indexOf('\n  };', resizeStart));
  assert.match(resizeBody, /scrollHeight/);
  assert.match(resizeBody, /lineHeight/);

  // The transcript is sized off --composer-height, so a taller composer shrinks
  // it. Without compensation the text under the reader's eye shifts by exactly
  // one line every time the composer grows.
  const observerStart = js.indexOf('let lastComposerHeight = 0;');
  assert.ok(observerStart > 0, 'composer height must be tracked across resizes');
  const observerBody = js.slice(observerStart, js.indexOf('observer.observe(root);', observerStart));
  assert.match(observerBody, /transcriptScroll/);
  assert.match(observerBody, /wasPinned/);
  // Position must be read BEFORE the variable is written, or it measures the
  // layout it is trying to correct for.
  assert.ok(
    observerBody.indexOf('wasPinned') <
      observerBody.indexOf("setProperty(\n      '--composer-height'"),
    'scroll position must be measured before --composer-height changes',
  );
});

test('opening a chat lands on the newest message, not the last chat position', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  // Opening a chat has no scroll-to-bottom of its own; it relies entirely on
  // the pinned check. That check is measured BEFORE the list is replaced, so it
  // reads the previous chat's content and scroll position. Scrolled up in one
  // chat, open another, and that distance from the end is restored against the
  // new chat, leaving the newest message off screen.
  assert.match(js, /let lastTranscriptSessionId = null;/);
  assert.match(js, /const transcriptSessionChanged =\s*\n?\s*lastTranscriptSessionId !== state\.route\.sessionId;/);

  // A hidden or backgrounded scroller reports clientHeight 0, which inflates
  // the measured distance by exactly one viewport and scrolls a screen too high
  // when restored.
  assert.match(js, /const measurable = transcriptScroll\.clientHeight > 0;/);

  const pinnedMatch = js.match(/const pinned =\s*\n?\s*([^;]+);/);
  assert.ok(pinnedMatch, 'pinned must be derived');
  const pinnedExpression = pinnedMatch[1];
  assert.match(pinnedExpression, /transcriptSessionChanged/);
  assert.match(pinnedExpression, /!measurable/);
  assert.match(pinnedExpression, /distanceBefore < 48/);
});

test('returning to the app follows the newest message until moved by hand', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  // A chat's messages arrive in two passes, a memory snapshot then the network
  // refresh, and coming back to the app re-runs that. The first paint can hold
  // a fraction of the messages, so every message landing afterwards is inserted
  // ABOVE the reader. Measuring distance-from-bottom on that partial paint and
  // then preserving it is what left the view stranded far up the page.
  assert.match(js, /let transcriptMovedByHand = false;/);

  // The signal must be a real gesture, never a programmatic scroll, or the
  // app's own scroll writes would immediately clear it.
  const gestureStart = js.indexOf('function noteReadGesture()');
  assert.ok(gestureStart > 0, 'noteReadGesture must exist');
  const gestureBody = js.slice(gestureStart, js.indexOf('\n}\n', gestureStart));
  assert.match(gestureBody, /transcriptMovedByHand = true;/);

  // Opening a different chat starts untouched again, so one chat's reading
  // position can never be applied to another.
  assert.match(js, /if \(transcriptSessionChanged\) transcriptMovedByHand = false;/);

  const pinnedMatch = js.match(/const pinned =\s*\n?\s*([^;]+);/);
  assert.ok(pinnedMatch, 'pinned must be derived');
  assert.match(pinnedMatch[1], /!transcriptMovedByHand/);
  // The deliberate preservation case survives: a reader who HAS scrolled keeps
  // their distance from the end while messages stream in.
  assert.match(pinnedMatch[1], /distanceBefore < 48/);
})
