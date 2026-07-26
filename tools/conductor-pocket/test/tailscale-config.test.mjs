import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertEmptyTailscaleConfig,
  assertPrivateServeStatus,
} from '../src/tailscale-config.mjs';

const expected = {
  TCP: { 443: { HTTPS: true } },
  Web: {
    'mac.example.ts.net:443': {
      Handlers: {
        '/': { Proxy: 'http://127.0.0.1:4317' },
      },
    },
  },
};

test('installer accepts only the exact private HTTPS loopback proxy', () => {
  assert.doesNotThrow(() =>
    assertPrivateServeStatus(expected, {
      rpId: 'mac.example.ts.net',
      port: 4317,
    }),
  );
  assert.throws(
    () =>
      assertPrivateServeStatus(
        {
          ...expected,
          Web: {
            'mac.example.ts.net:443': {
              Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } },
            },
          },
        },
        { rpId: 'mac.example.ts.net', port: 4317 },
      ),
    /expected private HTTPS root proxy/,
  );
  assert.throws(
    () =>
      assertPrivateServeStatus(
        { ...expected, AllowFunnel: true },
        { rpId: 'mac.example.ts.net', port: 4317 },
      ),
    /Funnel/,
  );
});

test('installer refuses any pre-existing Serve or Funnel state', () => {
  assert.doesNotThrow(() => assertEmptyTailscaleConfig({}, 'Serve'));
  assert.throws(
    () => assertEmptyTailscaleConfig({ Web: {} }, 'Serve'),
    /Refusing to overwrite/,
  );
});
