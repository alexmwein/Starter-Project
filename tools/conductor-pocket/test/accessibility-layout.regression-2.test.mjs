import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Regression: the chrome band between the tab group and the transcript was
// budgeted at exactly 1 control, and the live Conductor 0.81 window measures
// exactly 1. A single added control (a status pill, a second picker) therefore
// failed every send inside the pre-flight queued-edit check, before a single
// character was typed. Because the shape of the window does not change between
// attempts, retrying the same message reproduced it exactly: observed on
// 2026-08-16 as three identical send_unavailable failures of one 549-character
// message across 33 minutes, all with draftFullyTyped=false.
//
// The band carries no safety weight. The composer is proven by its own
// AXDescription, and the queued-edit scan reads the band AFTER the transcript
// boundary. So these tests pin tolerance of unknown chrome, and pin that the
// checks which are load bearing still fail closed.

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

// Mirrors the live 0.81 window: a tab group, a chrome band, the transcript,
// small siblings, then the composer.
function makeMain({ chrome = [], siblings = 1 } = {}) {
  const tabGroup = makeNode({
    children: [
      makeNode({
        children: [
          makeNode({
            name: `Close chat ${target.sessionTitle}`,
            role: 'AXRadioButton',
            value: true,
          }),
        ],
      }),
    ],
    role: 'AXTabGroup',
  });
  const transcript = makeNode({
    children: Array.from({ length: 5 }, () => makeNode()),
    role: 'AXGroup',
  });
  const composer = makeNode({ description: 'composer' });
  return {
    composer,
    root: makeNode({
      children: [
        tabGroup,
        ...chrome,
        transcript,
        ...Array.from({ length: siblings }, () =>
          makeNode({ children: [makeNode()], role: 'AXGroup' }),
        ),
        composer,
      ],
    }),
  };
}

function chromeControls(count, { role = 'AXPopUpButton', children = [] } = {}) {
  return Array.from({ length: count }, () =>
    makeNode({ actionNames: ['AXPress'], children, role }),
  );
}

function layoutFor(main) {
  return makeNode({
    children: [makeSidebar(), main, makeNode(), makeNode()],
  });
}

function processFor(webArea) {
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
                      return [webArea];
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

async function harness() {
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
    ObjC: { bindFunction() {}, import() {} },
    delay() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}
globalThis.__band = { composerSendContext, lastFailure: () => lastFailure };`,
    sandbox,
  );
  return sandbox.__band;
}

function resolve(composerSendContext, main) {
  return composerSendContext(processFor(layoutFor(main.root))).composer;
}

test('chrome band tolerates more than the single control 0.81 ships', async () => {
  const { composerSendContext } = await harness();

  // 1 is the live measurement, and was also the entire budget. 2 is the
  // failure that survived three retries of the same message.
  for (const count of [0, 1, 2, 5, 8]) {
    const main = makeMain({ chrome: chromeControls(count) });
    assert.equal(
      resolve(composerSendContext, main),
      main.composer,
      `chrome band of ${count} control(s) must resolve the composer`,
    );
  }
});

test('chrome band does not pin the role Conductor happens to use', async () => {
  const { composerSendContext } = await harness();

  // 0.81 renders AXPopUpButton here. Pinning that turned a redesign into a
  // total send outage, so any non-container control is accepted.
  for (const role of ['AXPopUpButton', 'AXButton', 'AXStaticText', 'AXImage']) {
    const main = makeMain({ chrome: chromeControls(1, { role }) });
    assert.equal(
      resolve(composerSendContext, main),
      main.composer,
      `chrome band control of role ${role} must resolve the composer`,
    );
  }

  // A press action was also required. Chrome without one is still chrome.
  const main = makeMain({
    chrome: [makeNode({ role: 'AXPopUpButton' })],
  });
  assert.equal(resolve(composerSendContext, main), main.composer);
});

test('an empty Untitled chat tolerates its twelve bounded context siblings', async () => {
  const { composerSendContext, lastFailure } = await harness();

  // The live empty-chat layout on 2026-08-27 placed twelve small siblings
  // between the transcript boundary and the composer. Every sibling remains
  // independently bounded, and the whole queued-edit walk still shares the
  // fixed node budget.
  const liveEmptyChat = makeMain({ siblings: 12 });
  assert.equal(resolve(composerSendContext, liveEmptyChat), liveEmptyChat.composer);

  // Tolerance stays finite. A thirteenth sibling is a new layout that needs a
  // fresh proof instead of silently widening the send surface again.
  assert.throws(
    () => resolve(composerSendContext, makeMain({ siblings: 13 })),
    /send_unavailable/,
  );
  assert.match(lastFailure().tag, /context-band=14/);
});

test('chrome band still fails closed on overflow and on containers', async () => {
  const { composerSendContext, lastFailure } = await harness();

  // Budget is tolerant, not absent: an unbounded band would mean the element
  // taken as the transcript below is not the transcript.
  assert.throws(
    () => resolve(composerSendContext, makeMain({ chrome: chromeControls(9) })),
    /send_unavailable/,
  );
  assert.match(lastFailure().tag, /pre-transcript-overflow=9/);

  // A container in the band means the boundary is misidentified, which would
  // move the queued-edit scan off its region. That must not be tolerated.
  assert.throws(
    () =>
      resolve(
        composerSendContext,
        makeMain({
          chrome: chromeControls(1, {
            children: Array.from({ length: 9 }, () => makeNode()),
          }),
        }),
      ),
    /send_unavailable/,
  );
  assert.match(lastFailure().tag, /pre-transcript-container@/);
});

test('structural failures name themselves instead of a bare code', async () => {
  const { composerSendContext, lastFailure } = await harness();

  // Three retries reported only "send_unavailable" with a null tag, which is
  // what made this cost a debugging session rather than a glance at the log.
  const main = makeMain();
  main.root = makeNode({
    children: main.root
      .uiElements()
      .filter((child) => child.description() !== 'composer'),
  });
  assert.throws(() => resolve(composerSendContext, main), /send_unavailable/);
  const tag = lastFailure().tag;
  assert.ok(
    typeof tag === 'string' && tag.length > 0,
    'structural failure must carry a diagnostic tag',
  );
  // A window with no composer fails in root resolution, which is upstream of
  // the layout checks and names itself there.
  assert.match(tag, /main-root-unresolved|composer=|no-transcript-boundary/);
});
