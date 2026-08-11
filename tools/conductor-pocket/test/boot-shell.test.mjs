import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('the document paints a generic semantic boot state before modules run', async () => {
  const document = await fs.readFile(
    new URL('../public/index.html', import.meta.url),
    'utf8',
  );
  const appStart = document.indexOf('<div id="app"');
  const moduleStart = document.indexOf('<script type="module"');
  assert.ok(moduleStart >= 0 && moduleStart < appStart);
  assert.match(
    document,
    /<main class="gate boot-gate connection-anchor-gate" role="status" aria-live="polite">/,
  );
  assert.match(document, /<h1 class="sr-only">Conductor Pocket<\/h1>/);
  assert.match(document, /Connecting to your Mac…/);
  assert.match(document, /Still connecting\./);
  assert.doesNotMatch(
    document.slice(appStart),
    /workspace|chat|message|account/i,
  );
});

test('boot and generic connection failure share one stable tile anchor', async () => {
  const [application, stylesheet] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  const bootView = application.slice(
    application.indexOf('function bootView()'),
    application.indexOf('function gateView('),
  );
  const gateView = application.slice(
    application.indexOf('function gateView('),
    application.indexOf('function skeletonRows('),
  );
  const connectionGate = application.slice(
    application.indexOf('function renderConnectionGate('),
    application.indexOf('function isStandalone('),
  );
  const anchorRule = stylesheet.match(
    /\.connection-anchor-gate \.gate-column \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.match(bootView, /className: 'gate boot-gate connection-anchor-gate'/);
  assert.match(gateView, /connectionAnchor = false/);
  assert.match(
    gateView,
    /connectionAnchor \? 'gate connection-anchor-gate' : 'gate'/,
  );
  assert.match(
    connectionGate,
    /connectionAnchor: !upgradeRequired && !identityProblem/,
  );
  assert.match(anchorRule, /calc\(50svh - 152px - env\(safe-area-inset-top\)\)/);
  assert.doesNotMatch(anchorRule, /transform/);

  for (const viewportHeight of [844, 932]) {
    const safeAreaTop = 0;
    const gatePaddingTop = 32 + safeAreaTop;
    const columnMarginTop = Math.max(
      0,
      viewportHeight * 0.5 - 152 - safeAreaTop,
    );
    assert.equal(gatePaddingTop + columnMarginTop, viewportHeight * 0.5 - 120);
  }
});

test('connecting pulse never lowers text contrast below the reviewed floor', async () => {
  const stylesheet = await fs.readFile(
    new URL('../public/app.css', import.meta.url),
    'utf8',
  );
  const pulse = stylesheet.match(
    /@keyframes boot-connecting \{([\s\S]*?)\n\}/,
  )?.[1];
  const opacityValues = [...pulse.matchAll(/opacity: ([0-9.]+);/g)].map(
    (match) => Number(match[1]),
  );

  assert.deepEqual(opacityValues, [0.92, 1]);
  assert.ok(Math.min(...opacityValues) >= 0.92);
  assert.match(
    stylesheet,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.boot-connecting \{[\s\S]*opacity: 1;[\s\S]*animation: none !important;/,
  );
});

test('bootstrap is bounded and every gate clears the privacy shield', async () => {
  const application = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const gateSurfaceStart = application.indexOf('function revealGateSurface()');
  const gateViewStart = application.indexOf('function gateView(');
  const gateSurface = application.slice(gateSurfaceStart, gateViewStart);
  const bootstrapStart = application.indexOf('function bootstrap()');
  const lockStart = application.indexOf('function renderLock(', bootstrapStart);
  const bootstrap = application.slice(bootstrapStart, lockStart);

  assert.match(gateSurface, /#privacy-shield/);
  assert.match(gateSurface, /app\.removeAttribute\('aria-hidden'\)/);
  assert.match(application, /function gateView[\s\S]*revealGateSurface\(\)/);
  assert.match(application, /function bootView[\s\S]*revealGateSurface\(\)/);
  const bootView = application.slice(
    application.indexOf('function bootView()'),
    application.indexOf('function gateView('),
  );
  const gateView = application.slice(
    application.indexOf('function gateView('),
    application.indexOf('function skeletonRows('),
  );
  assert.ok(bootView.indexOf('app.replaceChildren') < bootView.indexOf('revealGateSurface()'));
  assert.ok(gateView.indexOf('app.replaceChildren') < gateView.indexOf('revealGateSurface()'));
  assert.match(bootstrap, /createBootstrapCoordinator/);
  assert.match(bootstrap, /timeoutMs: BOOTSTRAP_REQUEST_MS/);
  assert.match(bootstrap, /request\('\/api\/auth\/bootstrap', \{ signal, timeoutMs \}\)/);
  assert.match(bootstrap, /onFailure:[\s\S]*renderConnectionGate\(error\.code\)/);
});
