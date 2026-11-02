const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { sourceSection } = require('../helpers/test-utils');
const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');

function setup(chrome = {}) {
  const task = { id: 'annotation-1', folderName: '26-11-01 15-42' };
  const taskStore = { saveAnnotation: jest.fn(async () => task) };
  const context = vm.createContext({
    chrome, taskStore,
    window: { dispatchEvent: jest.fn(), devicePixelRatio: 2 },
    CustomEvent: class {},
    convertAnnotationToTask: annotation => annotation,
    showNotification: jest.fn(),
    console: { warn: jest.fn(), error: jest.fn() }
  });
  vm.runInContext(sourceSection(source, '  function relayToSidePanel(', '  // Load tasks for side panel'), context);
  vm.runInContext(sourceSection(source, '  async function captureScreenshotNative(', '  // Initialize when page loads'), context);
  return { context, taskStore };
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

test('extension initialization does not show the old comment prompt', async () => {
  const context = vm.createContext({
    initializeUtilities: async () => true,
    initializeProject: async () => {}, initializeUI: jest.fn(),
    showNotification: jest.fn(), setTimeout: jest.fn(),
    console: { log() {}, error() {} }
  });
  vm.runInContext(sourceSection(source, '  // Initialize Moat extension on page load', '  // Initialize UI components'), context);
  await context.initializeExtension();
  expect(context.initializeUI).toHaveBeenCalledTimes(1);
  expect(context.showNotification).not.toHaveBeenCalled();
  expect(context.setTimeout).not.toHaveBeenCalled();
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
    vm.runInContext(sourceSection(source, '  function relayToSidePanel(', '  // Load tasks for side panel'), context);
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

test('successful storage is not reported as failed when the runtime disappears', async () => {
  const { context, taskStore } = setup();
  await expect(context.saveAnnotationWithNewSystem({ id: 'annotation-1' })).resolves.toBe(true);
  expect(taskStore.saveAnnotation).toHaveBeenCalledTimes(1);
  expect(context.showNotification).not.toHaveBeenCalled();
});

test('saving does not wake stale page listeners from an invalidated extension context', async () => {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM('', { virtualConsole });
  try {
    const staleListener = jest.fn(() => {
      const oldChrome = {};
      oldChrome.runtime.sendMessage({ type: 'RELAY_TO_SIDEPANEL' });
    });
    dom.window.addEventListener('moat:tasks-updated', staleListener);
    const sendMessage = jest.fn(async () => {});
    const { context, taskStore } = setup({ runtime: { sendMessage } });
    context.window = dom.window;
    context.CustomEvent = dom.window.CustomEvent;
    await expect(context.saveAnnotationWithNewSystem({ id: 'annotation-1' })).resolves.toBe(true);
    expect(taskStore.saveAnnotation).toHaveBeenCalledTimes(1);
    expect(staleListener).not.toHaveBeenCalled();
    expect(errors).toHaveLength(0);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'RELAY_TO_SIDEPANEL',
      payload: { type: 'ANNOTATION_CREATED', taskId: 'annotation-1' } });
  } finally {
    dom.window.close();
  }
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
  context.document = { createElement: () => canvas };
  context.Image = class {
    constructor() { this.width = 1600; this.height = 1000; }
    set src(value) { this.onload(); }
  };
  const result = await context.captureScreenshotNative(area);
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CAPTURE_SCREENSHOT' }, expect.any(Function));
  expect(drawImage).toHaveBeenCalledWith(expect.any(Object), 20, 40, 60, 80, 0, 0, 60, 80);
  expect(result).toEqual({ dataUrl: 'data:image/png;base64,cropped', viewport: { ...area, padding: 100 } });
});
