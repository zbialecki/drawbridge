const { JSDOM } = require('jsdom');
const { inspectPageContext, sanitizeFrameworkContext } = require('../../../chrome-extension/utils/frameworkContext');

const DIST = '/repo/.next/dev';
const CHUNK = 'http://localhost:3000/_next/static/chunks/app_page.js';
const stack = line => ({ stack: `Error: react-stack-top-frame\n    at exports.jsxDEV (${CHUNK}:1:1)\n${line}` });
const framed = (name, line) => stack(`    at ${name} (${CHUNK}:${line}:5)`);

function clientFiber(name, debugStack, owner = null) {
  return { type: Object.assign(function () {}, { displayName: name }), _debugOwner: owner, _debugStack: debugStack };
}

function respond(body) {
  return { ok: true, text: async () => `event: message\ndata: ${JSON.stringify(body)}\n`, json: async () => body };
}

function mcpResult(payload) {
  return respond({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
}

let dom;
let fetchMock;
const metadata = {
  sessions: [{
    url: '/settings',
    segments: [
      { path: 'app/layout.js', type: 'layout' },
      { path: 'not-found.js', type: 'boundary:not-found', isBuiltin: true },
      { path: 'app/settings/page.js', type: 'page' }
    ]
  }]
};
const originalFrames = {
  12: { file: 'app/settings/SaveButton.js', line1: 4, column1: 10 },
  90: { file: 'node_modules/next/dist/link.js', line1: 2, column1: 2, ignored: true }
};

function setup(html = '<button id="target" data-drawbridge-inspect="mark">Save</button>') {
  dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'http://localhost:3000/settings' });
  Object.assign(global, { window: dom.window, document: dom.window.document, location: dom.window.location });
  fetchMock = jest.fn(async (url, options) => {
    if (url === '/_next/mcp') {
      const { name } = JSON.parse(options.body).params;
      return mcpResult(name === 'get_page_metadata' ? metadata : { projectPath: '/repo' });
    }
    const { frames } = JSON.parse(options.body);
    const line = frames[0].line1;
    return respond([{ status: 'fulfilled', value: { originalStackFrame: originalFrames[line] ?? {
      file: 'app/settings/page.js', line1: 6, column1: 16
    } } }]);
  });
  global.fetch = fetchMock;
  return dom.window.document.querySelector('#target');
}

function nextDevPage(element, fiber, ancestors = {}) {
  dom.window.next = { version: '16.4.3' };
  dom.window.document.documentElement.appendChild(dom.window.document.createElement('nextjs-portal'));
  Object.assign(fiber, ancestors);
  element.__reactFiber$abc = fiber;
}

afterEach(() => {
  dom?.window.close();
  for (const key of ['window', 'document', 'location', 'fetch']) delete global[key];
});

describe('inspectPageContext', () => {
  test('reads the component, owners, source, boundary, and route on a Next dev build', async () => {
    const element = setup();
    const server = { name: 'BillingCard', env: 'Server', owner: { name: 'SettingsPage', env: 'Server' },
      stack: [['SettingsPage', `file://${DIST}/server/chunks/ssr/page.js`, 65, 2]] };
    const saveButton = clientFiber('SaveButton', framed('SaveButton', 40), server);
    const primary = clientFiber('PrimaryButton', framed('PrimaryButton', 30), saveButton);
    const router = { type: { displayName: 'OuterLayoutRouter' }, _debugInfo: [
      { name: 'BillingCard', env: 'Server' }, { name: 'SettingsPage', env: 'Server' }, { name: 'RootLayout', env: 'Server' }
    ] };
    nextDevPage(element, { type: 'button', _debugOwner: primary, _debugStack: framed('PrimaryButton', 12), return: router });

    const context = await inspectPageContext('mark');

    expect(element.hasAttribute('data-drawbridge-inspect')).toBe(false);
    expect(context.framework).toMatchObject({ name: 'next', version: '16.4.3', router: 'app', mode: 'development', mcpAvailable: true });
    expect(context.react).toEqual({
      component: 'PrimaryButton',
      componentEnv: 'client',
      owners: ['SaveButton', 'BillingCard', 'SettingsPage'],
      serverComponents: ['BillingCard', 'SettingsPage', 'RootLayout'],
      clientBoundary: { component: 'SaveButton', renderedBy: 'BillingCard' },
      source: 'app/settings/SaveButton.js:4:10',
      route: 'app/settings/page.js',
      layouts: ['app/layout.js']
    });
    const traced = JSON.parse(fetchMock.mock.calls.find(([url]) => url.includes('stack-frames'))[1].body);
    expect(traced.frames[0].file).toBe(`file://${DIST}/static/chunks/app_page.js`);
    expect(traced.isServer).toBe(false);
  });

  test('skips framework wrappers and falls back to app code when the element comes from a library', async () => {
    const element = setup();
    const billing = { name: 'BillingCard', env: 'Server', stack: [['SettingsPage', `${DIST}/server/chunks/ssr/page.js`, 65, 2]] };
    const link = clientFiber('LinkComponent', stack(`    at LinkComponent (http://localhost:3000/_next/static/chunks/next_dist_link.js:9:9)`), billing);
    nextDevPage(element, { type: 'a', _debugOwner: link, _debugStack: stack('    at LinkComponent (http://localhost:3000/_next/static/chunks/next_dist_link.js:8:8)') });

    const { react } = await inspectPageContext('mark');

    expect(react).toMatchObject({ component: 'BillingCard', componentEnv: 'server', owners: [], clientBoundary: null });
    expect(react.source).toBe('app/settings/page.js:6:16');
  });

  test('records only build identity on an App Router production build', async () => {
    const element = setup(`<button id="target" data-drawbridge-inspect="mark">Save</button>
      <script>self.__next_f.push([1,"0:{\\"P\\":null,\\"G\\":[\\"$13\\",[]],\\"b\\":\\"abc123\\"}\\n"])</script>`);
    dom.window.next = { version: '16.4.3' };
    dom.window.__next_f = [];
    dom.window.document.documentElement.setAttribute('data-dpl-id', 'dpl_1');
    element.__reactFiber$abc = { type: 'button', return: { type: () => {} } };

    expect(await inspectPageContext('mark')).toEqual({ framework: {
      name: 'next', version: '16.4.3', router: 'app', mode: 'production', buildId: 'abc123', deploymentId: 'dpl_1'
    } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(element.hasAttribute('data-drawbridge-inspect')).toBe(false);
  });

  test('reads the Pages Router build ID and leaves out its default App wrapper', async () => {
    const element = setup();
    dom.window.__NEXT_DATA__ = { buildId: 'development' };
    const app = clientFiber('App', framed('App', 50));
    const legacy = clientFiber('Legacy', framed('Legacy', 40), app);
    const inner = clientFiber('Inner', framed('Inner', 30), legacy);
    element.__reactFiber$abc = { type: 'button', _debugOwner: inner, _debugStack: framed('Inner', 12) };

    const { framework, react } = await inspectPageContext('mark');

    expect(framework).toMatchObject({ router: 'pages', mode: 'development', buildId: 'development' });
    expect(react).toMatchObject({ component: 'Inner', owners: ['Legacy'], clientBoundary: null });
  });

  test('reads component names on other React dev builds without calling Next endpoints', async () => {
    const element = setup();
    element.__reactFiber$abc = { type: 'button', _debugOwner: clientFiber('Card', framed('Card', 12)) };

    expect((await inspectPageContext('mark')).react).toMatchObject({ component: 'Card', owners: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns nothing on a page without React', async () => {
    setup();
    expect(await inspectPageContext('mark')).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('keeps the route for annotations with no element', async () => {
    setup();
    dom.window.next = { version: '16.4.3' };
    dom.window.document.documentElement.appendChild(dom.window.document.createElement('nextjs-portal'));

    const { react } = await inspectPageContext(null);

    expect(react.route).toBe('app/settings/page.js');
    expect(react.component).toBeUndefined();
  });

  test('keeps component names when every Next endpoint fails', async () => {
    const element = setup();
    nextDevPage(element, { type: 'button', _debugOwner: clientFiber('Card', framed('Card', 12)), _debugStack: framed('Card', 12) });
    fetchMock.mockRejectedValue(new Error('offline'));

    const context = await inspectPageContext('mark');

    expect(context.framework.mcpAvailable).toBe(false);
    expect(context.react).toMatchObject({ component: 'Card', source: null, route: null, layouts: [] });
  });

  test('never reads a component\'s props into the result', async () => {
    const element = setup();
    nextDevPage(element, {
      type: 'input',
      _debugOwner: Object.assign(clientFiber('Card', framed('Card', 12)), { memoizedProps: { password: 'hunter2' } }),
      memoizedProps: { value: 'hunter2' }
    });
    expect(JSON.stringify(await inspectPageContext('mark'))).not.toContain('hunter2');
  });
});

describe('sanitizeFrameworkContext', () => {
  const local = 'http://localhost:3000/settings';
  const dev = { name: 'next', mode: 'development', mcpAvailable: true };

  test.each([
    [undefined], [null], [{}], ['text'], [{ framework: { name: 'other' } }]
  ])('produces nothing from %p', raw => {
    expect(sanitizeFrameworkContext(raw, local)).toEqual({});
  });

  test('offers an MCP endpoint only for loopback dev servers and ignores page-supplied URLs', () => {
    const framework = { ...dev, mcpEndpoint: 'https://evil.example/mcp' };
    expect(sanitizeFrameworkContext({ framework }, local).framework.mcpEndpoint).toBe('http://localhost:3000/_next/mcp');
    expect(sanitizeFrameworkContext({ framework }, 'https://staging.example/x').framework.mcpEndpoint).toBeUndefined();
    expect(sanitizeFrameworkContext({ framework: { ...framework, mode: 'production' } }, local).framework.mcpEndpoint).toBeUndefined();
    expect(sanitizeFrameworkContext({ framework: { ...framework, mcpAvailable: false } }, local).framework.mcpEndpoint).toBeUndefined();
  });

  test.each([
    '/etc/passwd:1:1', '../../secret.js:1:1', 'app/../../secret.js:1:1', 'C:\\repo\\a.js:1:1',
    'https://evil.example/a.js:1:1', 'app/page.js'
  ])('rejects %s as a source', value => {
    expect(sanitizeFrameworkContext({ react: { component: 'A', source: value } }, local).react.source).toBeNull();
  });

  test('keeps Next route syntax in project-relative paths', () => {
    const route = 'src/app/(shop)/[slug]/@modal/page.tsx';
    const { react } = sanitizeFrameworkContext({ react: { route, layouts: [route, '/abs/layout.js'], source: `${route}:1:2` } }, local);
    expect(react).toMatchObject({ route, layouts: [route], source: `${route}:1:2` });
  });

  test('caps long values, strips control characters, and drops non-string names', () => {
    const { react } = sanitizeFrameworkContext({ react: {
      component: `Evil\n\u0000${'x'.repeat(500)}`,
      owners: ['A', 7, { toString: () => 'B' }, ...Array(50).fill('C')]
    } }, local);
    expect(react.component).toHaveLength(120);
    expect(react.component.startsWith('Evil  ')).toBe(true);
    expect(react.owners[0]).toBe('A');
    expect(react.owners).toHaveLength(24);
    expect(react.owners).not.toContain(7);
  });

  test('drops react data the page claims for a production build', () => {
    const context = sanitizeFrameworkContext({
      framework: { name: 'next', mode: 'production', buildId: 'abc' },
      react: { component: 'n' }
    }, 'https://staging.example/');
    expect(context.framework.buildId).toBe('abc');
    expect(context.react).toBeUndefined();
  });
});
