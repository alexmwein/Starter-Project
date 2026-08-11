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
    /<main class="gate boot-gate" role="status" aria-live="polite">/,
  );
  assert.match(document, /<h1 class="sr-only">Conductor Pocket<\/h1>/);
  assert.match(document, /Connecting to your Mac…/);
  assert.match(document, /Still connecting\./);
  assert.doesNotMatch(
    document.slice(appStart),
    /workspace|chat|message|account/i,
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
