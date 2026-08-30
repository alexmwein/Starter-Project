export async function recoverAttestedRelay({
  configPath,
  port,
  attest,
  bootout,
  waitForRemoval,
  waitForShutdown,
  bootstrap,
}) {
  const profile = await attest({ configPath, port });
  const removed = await bootout();
  if (!removed) {
    throw new Error('The attested Pocket relay changed before recovery');
  }
  await waitForRemoval();
  await waitForShutdown({ port, expectedPid: profile.pid });
  await bootstrap();
  return profile;
}

export async function verifyPublicRelease({
  origin,
  expected,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const revisionToken = `${expected.shellRevision}-${now()}`;
  const healthUrl = new URL('/api/health', origin);
  healthUrl.searchParams.set('appRevision', revisionToken);
  const healthResponse = await fetchImpl(healthUrl, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!healthResponse.ok) {
    throw new Error(`public health unavailable: ${healthResponse.status}`);
  }
  const health = await healthResponse.json();
  if (
    health?.ok !== true ||
    health.version !== expected.version ||
    health.configRevision !== expected.configRevision ||
    health.shellRevision !== expected.shellRevision
  ) {
    throw new Error('public health identity mismatch');
  }

  const documentUrl = new URL('/', origin);
  documentUrl.searchParams.set('appRevision', revisionToken);
  const documentResponse = await fetchImpl(documentUrl, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  const documentContentType = documentResponse.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    ?.toLowerCase();
  if (!documentResponse.ok || documentContentType !== 'text/html') {
    throw new Error(`public document unavailable: ${documentResponse.status}`);
  }
  const document = await documentResponse.text();
  const documentRevision = /<meta\s+name="conductor-pocket-shell-revision"\s+content="([^"]+)"\s*>/i.exec(
    document,
  )?.[1];
  if (documentRevision !== expected.shellRevision) {
    throw new Error('public document revision mismatch');
  }

  return { health, documentRevision };
}
