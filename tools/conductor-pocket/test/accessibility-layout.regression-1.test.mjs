import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Regression: ISSUE-001 — Conductor 0.79 shifted the sidebar/main AX roots.
// Found by /qa on 2026-08-08
// Report: .gstack/qa-reports/qa-report-conductor-pocket-2026-08-08.md

const target = {
  workspaceName: 'Target workspace',
  sessionTitle: 'Target chat',
  sessionOrdinal: 1,
};

function makeNode({
  actionNames = [],
  children = [],
  classes = [],
  description = '',
  name = '',
  role = 'AXGroup',
  throwOnChildren = false,
  value = false,
} = {}) {
  return {
    actions() {
      return actionNames.map((actionName) => ({
        name() {
          return actionName;
        },
      }));
    },
    attributes: {
      byName(attributeName) {
        return {
          value() {
            return attributeName === 'AXDOMClassList' ? classes : '';
          },
        };
      },
    },
    description() {
      return description;
    },
    name() {
      return name;
    },
    role() {
      return role;
    },
    uiElements() {
      if (throwOnChildren) throw new Error('auxiliary root must stay opaque');
      return children;
    },
    value() {
      return value;
    },
  };
}

function makeSidebar() {
  return makeNode({
    children: [
      makeNode({
        children: [
          makeNode({
            classes: ['bg-sidebar-accent'],
            name: target.workspaceName,
            role: 'AXLink',
          }),
          makeNode({ name: 'Another workspace', role: 'AXLink' }),
        ],
      }),
    ],
  });
}

function makeMain({ includeComposer = true } = {}) {
  const radio = makeNode({
    name: `Close chat ${target.sessionTitle}`,
    role: 'AXRadioButton',
    value: true,
  });
  const tabGroup = makeNode({
    children: [makeNode({ children: [radio] })],
    role: 'AXTabGroup',
  });
  const composer = makeNode({ description: 'composer' });
  return {
    composer: includeComposer ? composer : null,
    root: makeNode({
      children: [
        tabGroup,
        makeNode({ role: 'AXGroup' }),
        includeComposer ? composer : makeNode({ role: 'AXGroup' }),
      ],
    }),
  };
}

function makeMainWrapper(main, mainChildIndex = 8) {
  return makeNode({
    children: [
      ...Array.from({ length: mainChildIndex }, (_, index) =>
        index === 0
          ? makeNode({ role: 'AXGroup' })
          : makeNode({ role: index % 2 === 0 ? 'AXStaticText' : 'AXButton' }),
      ),
      main,
    ],
  });
}

function makeTabOnlyRoot() {
  return makeNode({
    children: [makeNode({ role: 'AXTabGroup' })],
  });
}

function makeTargetNamedAuxiliaryRoot({ selected = false } = {}) {
  return makeNode({
    children: [
      makeNode({
        children: [
          makeNode({
            classes: selected ? ['bg-sidebar-accent'] : [],
            name: target.workspaceName,
            role: 'AXLink',
          }),
          makeNode({ name: 'Unrelated link', role: 'AXLink' }),
        ],
      }),
    ],
  });
}

function makeLayout(
  kind,
  {
    decoyTabRoot = false,
    duplicateMain = false,
    duplicateSidebar = false,
    targetNamedAuxiliaryRoot = false,
  } = {},
) {
  const sidebar = makeSidebar();
  const { composer, root: main } = makeMain();
  let roots;
  if (kind === 'legacy') {
    roots = [makeNode(), sidebar, main];
  } else if (kind === 'conductor-0.83.1') {
    roots = [sidebar, makeMainWrapper(main), makeNode(), makeNode()];
  } else if (kind === 'conductor-0.83.1-single-child') {
    roots = [sidebar, makeMainWrapper(main, 0), makeNode(), makeNode()];
  } else {
    roots = [sidebar, main, makeNode(), makeNode()];
  }
  if (duplicateSidebar) roots.push(makeSidebar());
  if (duplicateMain) roots.push(makeMain().root);
  if (decoyTabRoot) roots.push(makeTabOnlyRoot());
  if (targetNamedAuxiliaryRoot) {
    roots.push(makeTargetNamedAuxiliaryRoot());
  }
  return {
    composer,
    webArea: makeNode({ children: roots }),
  };
}

function processFor(state) {
  return {
    windows: [
      {
        groups: [
          {
            groups: [
              {
                scrollAreas: [
                  {
                    get uiElements() {
                      return [state.webArea];
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function routeHarness() {
  const source = await fs.readFile(
    new URL('../src/conductor-input.js', import.meta.url),
    'utf8',
  );
  const dollar = new Proxy(() => null, { get: () => 0 });
  const sandbox = {
    $: dollar,
    Application: () => {
      throw new Error('Application must not be called in this unit test');
    },
    ObjC: {
      bindFunction() {},
      import() {},
    },
    delay() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}
globalThis.__layoutRegression = {
  acquireRouteLease,
  assertRouteLease,
  composerSendContext,
};`,
    sandbox,
  );
  return sandbox.__layoutRegression;
}

test('semantic route discovery supports legacy and current Conductor root layouts', async () => {
  const {
    acquireRouteLease,
    assertRouteLease,
    composerSendContext,
  } = await routeHarness();

  for (const kind of [
    'legacy',
    'conductor-0.79',
    'conductor-0.83.1',
    'conductor-0.83.1-single-child',
  ]) {
    const state = makeLayout(kind);
    const process = processFor(state);
    const lease = acquireRouteLease(process, target);

    state.webArea = makeLayout(kind).webArea;
    assert.doesNotThrow(() => assertRouteLease(process, lease));

    const visible = makeLayout(kind);
    state.webArea = visible.webArea;
    assert.equal(composerSendContext(process).composer, visible.composer);
  }
});

test('Conductor 0.83.1 nested main route stays pinned to its full path', async () => {
  const { acquireRouteLease, assertRouteLease } = await routeHarness();
  const initial = makeLayout('conductor-0.83.1');
  const state = { webArea: initial.webArea };
  const process = processFor(state);
  const lease = acquireRouteLease(process, target);

  assert.deepEqual(Array.from(lease.mainRootPath), [1, 8]);

  const movedRoots = makeLayout('conductor-0.83.1').webArea.uiElements();
  const wrapperChildren = movedRoots[1].uiElements();
  const main = wrapperChildren.pop();
  wrapperChildren.splice(7, 0, main);
  state.webArea = makeNode({ children: movedRoots });

  assert.throws(
    () => assertRouteLease(process, lease),
    (error) => error?.pocketCode === 'route_changed',
  );
});

test('Conductor 0.79 production hints ignore non-sidebar links and tab-only roots', async () => {
  const {
    acquireRouteLease,
    assertRouteLease,
    composerSendContext,
  } = await routeHarness();
  const hintedTarget = {
    ...target,
    workspaceHint: {
      containerChildCount: 2,
      path: [0, 0],
      sidebarChildCount: 1,
    },
  };
  const state = makeLayout('conductor-0.79', {
    decoyTabRoot: true,
    targetNamedAuxiliaryRoot: true,
  });
  const process = processFor(state);
  const lease = acquireRouteLease(process, hintedTarget);

  state.webArea = makeLayout('conductor-0.79', {
    decoyTabRoot: true,
    targetNamedAuxiliaryRoot: true,
  }).webArea;
  assert.doesNotThrow(() => assertRouteLease(process, lease));

  const visible = makeLayout('conductor-0.79', {
    decoyTabRoot: true,
    targetNamedAuxiliaryRoot: true,
  });
  state.webArea = visible.webArea;
  assert.equal(composerSendContext(process).composer, visible.composer);
});

test('semantic route discovery fails closed on missing or ambiguous roots', async () => {
  const { acquireRouteLease } = await routeHarness();
  const routeChanged = (error) => error?.pocketCode === 'route_changed';

  for (const layout of [
    makeLayout('conductor-0.79', { duplicateMain: true }),
    makeLayout('conductor-0.79', { duplicateSidebar: true }),
    { webArea: makeNode({ children: [makeSidebar(), makeNode()] }) },
    { webArea: makeNode({ children: [makeMain().root, makeNode()] }) },
  ]) {
    const state = { webArea: layout.webArea };
    assert.throws(
      () => acquireRouteLease(processFor(state), target),
      routeChanged,
    );
  }
});

test('a route lease rejects root insertion or reordering during a send', async () => {
  const { acquireRouteLease, assertRouteLease } = await routeHarness();
  const initial = makeLayout('conductor-0.79');
  const state = { webArea: initial.webArea };
  const process = processFor(state);
  const lease = acquireRouteLease(process, target);
  const reordered = makeLayout('conductor-0.79').webArea.uiElements();
  state.webArea = makeNode({
    children: [reordered[1], reordered[0], reordered[2], reordered[3]],
  });

  assert.throws(
    () => assertRouteLease(process, lease),
    (error) => error?.pocketCode === 'route_changed',
  );
});

test('route revalidation stays pinned while unrelated roots rerender', async () => {
  const { acquireRouteLease, assertRouteLease } = await routeHarness();
  const initial = makeLayout('conductor-0.79');
  const state = { webArea: initial.webArea };
  const process = processFor(state);
  const lease = acquireRouteLease(process, target);
  const refreshedRoots = makeLayout('conductor-0.79').webArea.uiElements();
  refreshedRoots[2] = makeNode({
    children: [makeNode({ throwOnChildren: true })],
  });
  refreshedRoots[3] = makeNode({
    children: [makeNode({ throwOnChildren: true })],
  });
  state.webArea = makeNode({ children: refreshedRoots });

  assert.doesNotThrow(() => assertRouteLease(process, lease));
});

test('route revalidation rejects duplicate or migrated composer roots', async () => {
  const { acquireRouteLease, assertRouteLease } = await routeHarness();
  const initial = makeLayout('conductor-0.79');
  const state = { webArea: initial.webArea };
  const process = processFor(state);
  const lease = acquireRouteLease(process, target);
  const routeChanged = (error) => error?.pocketCode === 'route_changed';

  const duplicated = makeLayout('conductor-0.79').webArea.uiElements();
  duplicated[2] = makeMain().root;
  state.webArea = makeNode({ children: duplicated });
  assert.throws(() => assertRouteLease(process, lease), routeChanged);

  const migrated = makeLayout('conductor-0.79').webArea.uiElements();
  migrated[1] = makeMain({ includeComposer: false }).root;
  migrated[2] = makeMain().root;
  state.webArea = makeNode({ children: migrated });
  assert.throws(() => assertRouteLease(process, lease), routeChanged);
});

test('AppleScript resolves AX roots semantically instead of by position', async () => {
  const [source, inputSource] = await Promise.all([
    fs.readFile(
      new URL('../src/conductor-send.applescript', import.meta.url),
      'utf8',
    ),
    fs.readFile(new URL('../src/conductor-input.js', import.meta.url), 'utf8'),
  ]);

  assert.match(source, /on findSidebarGroup\(workspaceName\)/);
  assert.match(
    source,
    /on getSidebarGroup\(\)[\s\S]*findSidebarGroupWithRetry\(my workspaceName\)/,
  );
  assert.match(
    source,
    /on findSidebarGroupWithRetry\(workspaceName\)[\s\S]*findSidebarGroup\(workspaceName\)/,
  );
  assert.match(
    source,
    /on isMainGroup\(candidate\)[\s\S]*AXTabGroup[\s\S]*"composer"/,
  );
  assert.match(source, /on mainGroupCandidates\(rootElements\)/);
  assert.doesNotMatch(source, /if childCount > 1 then/);
  assert.match(
    source,
    /on findSidebarGroup\(workspaceName\)[\s\S]*isMainGroup\(candidate\) is false[\s\S]*getWorkspaceRoute\(workspaceName, candidate\)/,
  );
  assert.doesNotMatch(source, /return item 2 of rootElements/);
  assert.doesNotMatch(source, /return item 3 of rootElements/);
  assert.match(
    source,
    /findSidebarGroup\(workspaceName\)[\s\S]*getWorkspaceRoute\(workspaceName, candidate\)/,
  );
  assert.match(
    source,
    /on inspectWorkspaceCandidate[\s\S]*candidateClasses contains "bg-sidebar-accent"[\s\S]*set selectedIncrement to 1[\s\S]*on getWorkspaceRoute\(workspaceName, sidebarGroup\)[\s\S]*set selectedWorkspaceCount to 0[\s\S]*selectedWorkspaceCount to selectedWorkspaceCount \+ containerSelectedCount[\s\S]*\(count of matchingRoutes\) is not 1[\s\S]*selectedWorkspaceCount is greater than 1[\s\S]*selectedWorkspaceCount is 0 and my targetRepositoryName is ""/,
  );
  assert.match(
    source,
    /property cachedWorkspaceName[\s\S]*property cachedWorkspaceGroup[\s\S]*property cachedWorkspaceRoute[\s\S]*on clearWorkspaceRouteCache\(\)/,
  );
  assert.match(
    source,
    /on findSidebarGroup\(workspaceName\)[\s\S]*clearWorkspaceRouteCache\(\)[\s\S]*set my cachedWorkspaceName to workspaceName[\s\S]*set my cachedWorkspaceGroup[\s\S]*set my cachedWorkspaceRoute/,
  );
  assert.match(
    source,
    /on getWorkspaceRoute\(workspaceName, sidebarGroup\)[\s\S]*cachedName[\s\S]*cachedGroup[\s\S]*cachedRoute[\s\S]*clearWorkspaceRouteCache\(\)[\s\S]*return cachedRoute/,
  );

  const finalReadiness = inputSource.indexOf(
    "if (exactDraftExposedAt <= 0) fail('draft_changed');",
  );
  const finalWait = inputSource.indexOf(
    'waitForComposerSend(pid, message, inputLease);',
    finalReadiness,
  );
  assert.ok(finalReadiness >= 0);
  assert.ok(finalWait > finalReadiness);
  assert.doesNotMatch(
    inputSource.slice(finalReadiness, finalWait),
    /assertRouteLease|validateFocusedComposer/,
  );
});
