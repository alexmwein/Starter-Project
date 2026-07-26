function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function walk(value, visitor) {
  if (!isObject(value) && !Array.isArray(value)) return;
  visitor(value);
  for (const child of Object.values(value)) walk(child, visitor);
}

export function assertEmptyTailscaleConfig(value, label) {
  if (!isObject(value) || Object.keys(value).length !== 0) {
    throw new Error(
      `A Tailscale ${label} configuration already exists. Refusing to overwrite it.`,
    );
  }
}

export function assertPrivateServeStatus(status, { rpId, port }) {
  if (!isObject(status)) {
    throw new Error('Tailscale Serve returned an invalid status document');
  }
  const expectedTarget = `http://127.0.0.1:${port}`;
  const proxies = [];
  let hasHttps443 = false;
  let hasExpectedRoot = false;
  let funnelEnabled = false;

  walk(status, (value) => {
    if (isObject(value)) {
      if (typeof value.Proxy === 'string') proxies.push(value.Proxy);
      if (value.AllowFunnel === true) funnelEnabled = true;
      if (value.TCP?.['443']?.HTTPS === true) hasHttps443 = true;
      const rootHandler = value.Web?.[`${rpId}:443`]?.Handlers?.['/'];
      if (rootHandler?.Proxy === expectedTarget) hasExpectedRoot = true;
    }
  });

  if (funnelEnabled) {
    throw new Error('Tailscale Serve unexpectedly enabled public Funnel access');
  }
  if (
    proxies.length !== 1 ||
    proxies[0] !== expectedTarget ||
    !hasHttps443 ||
    !hasExpectedRoot
  ) {
    throw new Error(
      `Tailscale Serve is not the expected private HTTPS root proxy to ${expectedTarget}`,
    );
  }
}
