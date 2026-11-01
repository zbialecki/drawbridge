const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./content_script.js'), 'utf8');

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
  vm.runInContext(source.slice(source.indexOf('  function relayToSidePanel('), source.indexOf('  // Load tasks for side panel')), context);
  vm.runInContext(source.slice(source.indexOf('  async function captureScreenshotNative('), source.indexOf('  // Initialize when page loads')), context);
  return { context, taskStore };
}

const area = { x: 10, y: 20, width: 30, height: 40 };

test('a missing extension runtime does not throw when relaying an annotation update', () => {
  const { context } = setup();
  expect(() => context.relayToSidePanel({ type: 'TASK_UPDATED' })).not.toThrow();
});

test('a synchronous context-invalidation error does not escape the panel relay', () => {
  const { context } = setup({ runtime: { sendMessage() { throw new Error('Extension context invalidated.'); } } });
  expect(() => context.relayToSidePanel({ type: 'TASK_UPDATED' })).not.toThrow();
});

test('an annotation already saved to disk is not reported as failed when the runtime disappears', async () => {
  const { context, taskStore } = setup();
  await expect(context.saveAnnotationWithNewSystem({ id: 'annotation-1' })).resolves.toBe(true);
  expect(taskStore.saveAnnotation).toHaveBeenCalledTimes(1);
  expect(context.showNotification).toHaveBeenCalledWith('Saved to 26-11-01 15-42');
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
