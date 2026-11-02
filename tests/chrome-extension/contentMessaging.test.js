const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { sourceSection } = require('../helpers/test-utils');
const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');

function setup(chrome = {}) {
  const context = vm.createContext({
    chrome,
    window: { dispatchEvent: jest.fn(), devicePixelRatio: 2 },
    document: { hidden: false, addEventListener: jest.fn(), removeEventListener: jest.fn() },
    CustomEvent: class {},
    convertAnnotationToTask: annotation => annotation,
    showNotification: jest.fn(),
    console: { warn: jest.fn(), error: jest.fn() }
  });
  vm.runInContext(sourceSection(source, '  function relayToSidePanel(', '  // Earlier versions kept the folder handle'), context);
  vm.runInContext(sourceSection(source, '  async function captureScreenshotNative(', '  // Show notifications in the native side panel'), context);
  return { context };
}

const area = { x: 10, y: 20, width: 30, height: 40 };

test('page notifications are sent to the side panel without creating page UI', () => {
  const { context } = setup();
  context.document = { createElement: jest.fn() };
  context.window.showMoatNotification = jest.fn();
  context.relayToSidePanel = jest.fn();
  vm.runInContext(sourceSection(source, '  // Show notification', '  // Add annotation to queue'), context);
  context.showNotification('Could not save annotation', 'error');
  expect(context.relayToSidePanel).toHaveBeenCalledWith({
    type: 'SHOW_NOTIFICATION', message: 'Could not save annotation', notificationType: 'error'
  });
  expect(context.window.showMoatNotification).not.toHaveBeenCalled();
  expect(context.document.createElement).not.toHaveBeenCalled();
});

test('removes the folder handle and keys that earlier versions left in the site\'s storage', () => {
  const removed = [];
  const deleted = [];
  const context = vm.createContext({
    indexedDB: { deleteDatabase: name => deleted.push(name) },
    localStorage: { removeItem: key => removed.push(key) },
    location: { origin: 'https://example.com' }
  });
  vm.runInContext(sourceSection(source, '  // Earlier versions kept the folder handle', '  // The native panel owns a port'), context);
  expect(deleted).toEqual(['MoatPersistence']);
  expect(removed).toEqual(['moat.project.https://example.com', 'moat.queue']);
});

test('blocked site storage does not stop the content script', () => {
  const context = vm.createContext({ indexedDB: { deleteDatabase() { throw new Error('SecurityError'); } } });
  expect(() => vm.runInContext(sourceSection(source, '  // Earlier versions kept the folder handle', '  // The native panel owns a port'), context)).not.toThrow();
});

test('native panel connections enable shortcuts only while connected', () => {
  let connect;
  let disconnect;
  const context = vm.createContext({ sidePanelConnections: 0, Math,
    chrome: { runtime: { onConnect: { addListener(fn) { connect = fn; } } } } });
  vm.runInContext(sourceSection(source, '  chrome.runtime.onConnect.addListener(', '  window.__drawbridgeDebug ='), context);
  connect({ name: 'unrelated' });
  expect(context.sidePanelConnections).toBe(0);
  connect({ name: 'drawbridge-sidepanel', onDisconnect: { addListener(fn) { disconnect = fn; } } });
  expect(context.sidePanelConnections).toBe(1);
  disconnect();
  expect(context.sidePanelConnections).toBe(0);
});

test('a save failure appears in the sidebar and leaves the page untouched', async () => {
  const page = new JSDOM('');
  const panelHtml = fs.readFileSync(require.resolve('../../chrome-extension/sidepanel/sidepanel.html'), 'utf8');
  const panelSource = fs.readFileSync(require.resolve('../../chrome-extension/sidepanel/sidepanel.js'), 'utf8');
  const sidebar = new JSDOM(panelHtml, { runScripts: 'outside-only', url: 'https://extension.test/' });
  try {
    await new Promise(resolve => sidebar.window.addEventListener('load', resolve, { once: true }));
    const panel = sidebar.getInternalVMContext();
    panel.chrome = { runtime: {}, tabs: {} };
    panel.console = { log() {}, warn() {}, error() {} };
    vm.runInContext(panelSource, panel);
    vm.runInContext('activeTabId = 1; panelWindowId = 10;', panel);

    const context = vm.createContext({
      window: page.window, document: page.window.document,
      chrome: { runtime: { sendMessage: jest.fn(async message => {
        panel.handleMessage({ ...message.payload, sourceTabId: 1, sourceWindowId: 10 });
      }) } },
      addToQueue: jest.fn(async () => { throw new Error('Permission denied'); }),
      console: { error() {} }
    });
    vm.runInContext(sourceSection(source, '  function relayToSidePanel(', '  // Earlier versions kept the folder handle'), context);
    vm.runInContext(sourceSection(source, '  // Show notification', '  // Add annotation to queue'), context);
    vm.runInContext(sourceSection(source, '  async function submitCommentAnnotation(', '  // Wire clipboard-image paste'), context);
    const button = { disabled: false };
    const box = { querySelector: () => button };
    expect(await context.submitCommentAnnotation(box, { content: 'Keep this draft' })).toBe(false);
    expect(sidebar.window.document.querySelector('.notification.error').textContent)
      .toContain('Permission denied');
    expect(page.window.document.body.children).toHaveLength(0);
    expect(button.disabled).toBe(false);
  } finally {
    page.window.close();
    sidebar.window.close();
  }
});

test('a missing extension runtime does not throw or reject when relaying an annotation update', async () => {
  const { context } = setup();
  await expect(Promise.resolve().then(() => context.relayToSidePanel({ type: 'TASK_UPDATED' }))).resolves.toBeUndefined();
});

test('a context-invalidation error does not escape the panel relay', async () => {
  const { context } = setup({ runtime: { sendMessage() { throw new Error('Extension context invalidated.'); } } });
  await expect(Promise.resolve().then(() => context.relayToSidePanel({ type: 'TASK_UPDATED' }))).resolves.toBeUndefined();
});

test('a closed side panel is still handled as a rejected message, without an unhandled rejection', async () => {
  const sendMessage = jest.fn(() => Promise.reject(new Error('Receiving end does not exist.')));
  const { context } = setup({ runtime: { sendMessage } });
  context.relayToSidePanel({ type: 'TASK_UPDATED' });
  await new Promise(setImmediate);
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

test('a valid runtime still receives panel updates', () => {
  const sendMessage = jest.fn(async () => {});
  const { context } = setup({ runtime: { sendMessage } });
  context.relayToSidePanel({ type: 'TASK_UPDATED' });
  expect(sendMessage).toHaveBeenCalledWith({ type: 'RELAY_TO_SIDEPANEL', payload: { type: 'TASK_UPDATED' } });
});

test('capture returns null instead of rejecting if the runtime is missing', async () => {
  const { context } = setup();
  await expect(context.captureScreenshotNative(area)).resolves.toBeNull();
});

test('capture returns null if sending throws during extension invalidation', async () => {
  const { context } = setup({ runtime: { sendMessage() { throw new Error('Extension context invalidated.'); } } });
  await expect(context.captureScreenshotNative(area)).resolves.toBeNull();
});

test('capture handles the runtime disappearing before its callback', async () => {
  let reply;
  const { context } = setup({ runtime: { sendMessage(message, callback) { reply = callback; } } });
  const capture = context.captureScreenshotNative(area);
  delete context.chrome.runtime;
  expect(() => reply({ success: false, error: 'Extension reloaded' })).not.toThrow();
  await expect(capture).resolves.toBeNull();
});

test('capture still handles Chrome permission errors', async () => {
  const { context } = setup({ runtime: {
    lastError: { message: 'Permission denied' },
    sendMessage(message, callback) { callback(); }
  } });
  await expect(context.captureScreenshotNative(area)).resolves.toBeNull();
});

test('native capture and high-DPI cropping still work with a valid runtime', async () => {
  const sendMessage = jest.fn((message, callback) => callback({ success: true, dataUrl: 'data:image/png;base64,viewport' }));
  const { context } = setup({ runtime: { sendMessage } });
  const drawImage = jest.fn();
  const canvas = { getContext: () => ({ drawImage }), toDataURL: () => 'data:image/png;base64,cropped' };
  context.document.createElement = () => canvas;
  context.Image = class {
    constructor() { this.width = 1600; this.height = 1000; }
    set src(value) { this.onload(); }
  };
  const result = await context.captureScreenshotNative(area);
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CAPTURE_SCREENSHOT' }, expect.any(Function));
  expect(drawImage).toHaveBeenCalledWith(expect.any(Object), 20, 40, 60, 80, 0, 0, 60, 80);
  expect(result).toEqual({ dataUrl: 'data:image/png;base64,cropped', viewport: { ...area, padding: 100 } });
});

test('discards a native screenshot if the page became hidden, even if it is visible again', async () => {
  let reply;
  const { context } = setup({ runtime: { sendMessage(message, callback) { reply = callback; } } });
  const canvas = { getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,wrong-page' };
  context.document.createElement = () => canvas;
  context.Image = class {
    constructor() { this.width = 1600; this.height = 1000; }
    set src(value) { this.onload(); }
  };
  const pending = context.captureScreenshotNative(area);
  context.document.hidden = true;
  const onVisibilityChange = context.document.addEventListener.mock.calls.find(([type]) => type === 'visibilitychange')?.[1];
  onVisibilityChange?.();
  context.document.hidden = false;
  reply({ success: true, dataUrl: 'data:image/png;base64,viewport' });
  await expect(pending).resolves.toBeNull();
  expect(context.document.removeEventListener).toHaveBeenCalledWith('visibilitychange', onVisibilityChange);
});

describe('captureFrameworkContext', () => {
  const load = runtime => {
    const context = vm.createContext({ setTimeout, clearTimeout, Promise, Math, Date });
    context.globalThis = context;
    context.chrome = { runtime };
    vm.runInContext(sourceSection(source, '  // Read React and Next.js details', '  // Show notifications in the native side panel'), context);
    return context;
  };

  test('marks the element for the page reader, then removes the marker', async () => {
    const { window } = new JSDOM('<button>Save</button>');
    const button = window.document.querySelector('button');
    let marker;
    const context = load({ sendMessage: (message, callback) => {
      marker = message.marker;
      expect(button.getAttribute('data-drawbridge-inspect')).toBe(marker);
      callback({ react: { component: 'Save' } });
    } });
    await expect(context.captureFrameworkContext(button)).resolves.toEqual({ react: { component: 'Save' } });
    expect(marker).toEqual(expect.any(String));
    expect(button.hasAttribute('data-drawbridge-inspect')).toBe(false);
  });

  test.each([
    ['a runtime error', { lastError: { message: 'gone' }, sendMessage: (message, callback) => callback(undefined) }],
    ['a reloaded extension', { sendMessage: () => { throw new Error('Extension context invalidated'); } }]
  ])('resolves with null after %s', async (name, runtime) => {
    await expect(load(runtime).captureFrameworkContext()).resolves.toBeNull();
  });
});

