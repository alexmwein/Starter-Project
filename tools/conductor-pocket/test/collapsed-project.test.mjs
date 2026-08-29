import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { workspaceProjectCollapsedCopy } from '../public/delivery-receipts.js';
import { parseResult } from '../src/accessibility.mjs';

const targetWorkspace = 'iphone-conductor';

function makeNode({
  children = [],
  name = '',
  position = [0, 0],
  role = 'AXGroup',
  size = [0, 0],
} = {}) {
  return {
    name() {
      return name;
    },
    role() {
      return role;
    },
    position() {
      return position;
    },
    size() {
      return size;
    },
    uiElements() {
      return children;
    },
  };
}

function makeProcess({ includeTargetLink = false } = {}) {
  const listRows = [
    makeNode({
      name: 'Quickstart Quickstart 46 Repo settings New workspace',
      position: [25, 351],
      role: 'AXButton',
      size: [216, 44],
    }),
    ...(includeTargetLink
      ? [makeNode({ name: targetWorkspace, role: 'AXLink' })]
      : []),
    makeNode({
      name: 'OVO CRM Fable OVO CRM Fable 4 Repo settings New workspace',
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
    `${source}\nglobalThis.__collapsed = {
      diagnoseWorkspaceFailure,
      expandCollapsedProject:
        typeof expandCollapsedProject === 'function'
          ? expandCollapsedProject
          : null,
      sidebarProjectSnapshot:
        typeof sidebarProjectSnapshot === 'function'
          ? sidebarProjectSnapshot
          : null,
    };`,
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
    (appleScript.match(/set (?:initial|later)WorkspaceFailure to my workspaceListFailure\(inputScriptPath, conductorPid\)/g) || [])
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

test('collapsed project expansion clicks the proven owner once at its leading edge', async () => {
  const { expandCollapsedProject } = await diagnosisHarness();
  assert.equal(typeof expandCollapsedProject, 'function');
  const calls = [];

  const result = expandCollapsedProject(
    makeProcess(),
    targetWorkspace,
    'Quickstart',
    {
      acquireLease() {
        calls.push('acquire');
        return { inputCounters: [0], syntheticInputPosted: false };
      },
      assertLease() {
        calls.push('assert');
      },
      click(point) {
        calls.push(['click', point.x, point.y]);
      },
    },
  );

  assert.equal(result, 'expanded');
  assert.deepEqual(calls, [
    'acquire',
    'assert',
    'assert',
    ['click', 37, 373],
    'assert',
  ]);
});

test('collapsed project expansion never clicks a different collapsed project', async () => {
  const { expandCollapsedProject } = await diagnosisHarness();
  let clicks = 0;

  const result = expandCollapsedProject(
    makeProcess(),
    targetWorkspace,
    'Another project',
    {
      acquireLease: () => ({}),
      assertLease() {},
      click() {
        clicks += 1;
      },
    },
  );

  assert.equal(result, 'not-expanded');
  assert.equal(clicks, 0);
});

test('collapsed project expansion re-proves the row immediately before click', async () => {
  const { expandCollapsedProject } = await diagnosisHarness();
  let inspections = 0;
  let clicks = 0;
  const row = makeNode({
    name: 'Quickstart Quickstart 46 Repo settings New workspace',
    position: [25, 351],
    role: 'AXButton',
    size: [216, 44],
  });
  const result = expandCollapsedProject(
    makeProcess(),
    targetWorkspace,
    'Quickstart',
    {
      acquireLease: () => ({ syntheticInputPosted: false }),
      activate() {},
      assertLease() {},
      inspect: () => {
        inspections += 1;
        return inspections === 1 ? row : null;
      },
      click() {
        clicks += 1;
      },
    },
  );

  assert.equal(result, 'not-expanded');
  assert.equal(inspections, 2);
  assert.equal(clicks, 0);
});

test('watchdog sidebar snapshot is read-only and names collapsed projects', async () => {
  const { sidebarProjectSnapshot } = await diagnosisHarness();
  assert.deepEqual(
    JSON.parse(JSON.stringify(sidebarProjectSnapshot(makeProcess()))),
    {
      ok: true,
      projects: [
        { name: 'Quickstart', collapsed: true },
        { name: 'OVO CRM Fable', collapsed: false },
      ],
    },
  );
  const inputSource = await fs.readFile(
    new URL('../src/conductor-input.js', import.meta.url),
    'utf8',
  );
  const operation = inputSource.slice(
    inputSource.indexOf("operation === 'sidebar-snapshot'"),
    inputSource.indexOf("operation === 'workspace-failure'"),
  );
  assert.match(operation, /conductorProcessForReadOnlyDiagnosis/);
  assert.doesNotMatch(operation, /CGEvent|AXPress|click|activate/i);
});

test('the send path attempts collapsed project expansion at most once', async () => {
  const appleScript = await fs.readFile(
    new URL('../src/conductor-send.applescript', import.meta.url),
    'utf8',
  );
  const transport = await fs.readFile(
    new URL('../src/accessibility.mjs', import.meta.url),
    'utf8',
  );
  const sendPath = appleScript.slice(
    appleScript.indexOf(
      'set sidebarGroup to getSidebarGroup()',
      appleScript.indexOf('set my projectExpansionAttempted to false'),
    ),
    appleScript.indexOf(
      'set workspaceRoute to my getWorkspaceRoute',
      appleScript.indexOf('set my projectExpansionAttempted to false'),
    ),
  );

  assert.equal(
    (sendPath.match(/expandCollapsedProject/g) || []).length,
    1,
  );
  assert.match(sendPath, /set sidebarGroup to getSidebarGroup\(\)/);
  assert.match(sendPath, /return initialWorkspaceFailure/);
  assert.match(transport, /POCKET_PROJECT_NAME_BASE64/);
  assert.match(appleScript, /POCKET_OPERATION=workspace-expand/);
  assert.doesNotMatch(sendPath, /AXPress/);
});
