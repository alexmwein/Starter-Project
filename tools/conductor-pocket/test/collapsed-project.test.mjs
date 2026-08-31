import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { workspaceProjectCollapsedCopy } from '../public/delivery-receipts.js';
import { parseResult } from '../src/accessibility.mjs';

const targetWorkspace = 'iphone-conductor';

function makeNode({ children = [], name = '', role = 'AXGroup' } = {}) {
  return {
    name() {
      return name;
    },
    role() {
      return role;
    },
    uiElements() {
      return children;
    },
  };
}

function makeProcess({ includeTargetLink = false } = {}) {
  const listRows = [
    makeNode({
      name: 'Quickstart Quickstart Repo settings New workspace',
      role: 'AXButton',
    }),
    ...(includeTargetLink
      ? [makeNode({ name: targetWorkspace, role: 'AXLink' })]
      : []),
    makeNode({
      name: 'OVO CRM Fable OVO CRM Fable Repo settings New workspace',
      role: 'AXButton',
    }),
    ...['Hiring', 'calendar', 'OVO CRM Fable', 'filming'].map((name) =>
      makeNode({ name, role: 'AXLink' }),
    ),
  ];
  const sidebarChildren = [
    ...Array.from({ length: 14 }, () => makeNode()),
    makeNode({ children: listRows }),
    ...Array.from({ length: 4 }, () => makeNode()),
  ];
  const webArea = makeNode({
    children: [
      makeNode({ children: sidebarChildren }),
      makeNode({
        children: [
          makeNode({ role: 'AXTabGroup' }),
          makeNode({ role: 'AXGroup' }),
          makeNode({ role: 'AXGroup' }),
        ],
      }),
      makeNode({ children: [makeNode({ name: 'Notifications alt+T' })] }),
      makeNode(),
    ],
  });
  return {
    windows: [
      {
        groups: [
          {
            groups: [
              {
                scrollAreas: [{ uiElements: [webArea] }],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function diagnosisHarness() {
  const source = await fs.readFile(
    new URL('../src/conductor-input.js', import.meta.url),
    'utf8',
  );
  const sandbox = {
    $: new Proxy(() => null, { get: () => 0 }),
    Application() {
      throw new Error('fixture diagnosis must not control an application');
    },
    ObjC: { bindFunction() {}, import() {} },
    delay() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}\nglobalThis.__collapsed = { diagnoseWorkspaceFailure };`,
    sandbox,
  );
  return sandbox.__collapsed;
}

test('collapsed project fixture returns workspace_project_collapsed with the real project name', async () => {
  const { diagnoseWorkspaceFailure } = await diagnosisHarness();
  const fixtureFailure = diagnoseWorkspaceFailure(
    makeProcess(),
    targetWorkspace,
    'Quickstart',
  );
  const parsed = parseResult(JSON.stringify(fixtureFailure));

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'workspace_project_collapsed');
  assert.equal(parsed.projectName, 'Quickstart');
  assert.equal(parsed.safeToRetry, true);
  assert.equal(
    workspaceProjectCollapsedCopy(parsed.projectName),
    "The 'Quickstart' project is collapsed in Conductor's sidebar. Expand it to send.",
  );

  const appleScript = await fs.readFile(
    new URL('../src/conductor-send.applescript', import.meta.url),
    'utf8',
  );
  const failureHandler = appleScript.slice(
    appleScript.indexOf('on workspaceListFailure'),
    appleScript.indexOf('end workspaceListFailure') +
      'end workspaceListFailure'.length,
  );
  assert.match(failureHandler, /POCKET_OPERATION=workspace-failure/);
  assert.doesNotMatch(failureHandler, /AXPress|AXShowMenu/);
  assert.equal(
    (appleScript.match(/return my workspaceListFailure\(inputScriptPath, conductorPid\)/g) || [])
      .length,
    2,
  );
  assert.doesNotMatch(failureHandler, /Quickstart/);
});

test('collapsed project fixture keeps genuine visible-route failures generic', async () => {
  const { diagnoseWorkspaceFailure } = await diagnosisHarness();
  const fixtureFailure = diagnoseWorkspaceFailure(
    makeProcess({ includeTargetLink: true }),
    targetWorkspace,
    'Quickstart',
  );
  assert.equal(fixtureFailure.code, 'workspace_list_unavailable');
  assert.equal('projectName' in fixtureFailure, false);
  assert.deepEqual(
    parseResult(
      JSON.stringify({
        ok: false,
        code: 'workspace_project_collapsed',
        projectName: 'bad\nname',
      }),
    ),
    { ok: false, code: 'automation_invalid_response' },
  );
});
