const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { sourceSection, deferred } = require('../helpers/test-utils');
const { directoryFixture } = require('../helpers/directory-handle');
const { AnnotationStore } = require('../../chrome-extension/utils/annotationStore');

const contentSource = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');
const panelSource = fs.readFileSync(require.resolve('../../chrome-extension/sidepanel/sidepanel.js'), 'utf8');
const panelHtml = fs.readFileSync(require.resolve('../../chrome-extension/sidepanel/sidepanel.html'), 'utf8');

test('connecting a folder shows one confirmation in the side panel', async () => {
  const fixture = directoryFixture();
  const dom = new JSDOM(panelHtml, { runScripts: 'outside-only', url: 'https://extension.test/' });
  try {
    await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
    const panel = dom.getInternalVMContext();
    panel.chrome = { runtime: {}, tabs: {} };
    panel.console = { log() {}, warn() {}, error() {} };
    vm.runInContext(panelSource, panel);
    vm.runInContext('activeTabId = 1; panelWindowId = 10;', panel);
    panel.requestTasks = jest.fn();

    let messageListener;
    const listeners = new Map();
    const taskStore = new AnnotationStore();
    const context = vm.createContext({
      taskStore, projectRoot: null, connectionEventDispatched: false,
      window: {
        location: { origin: 'https://example.com' },
        showDirectoryPicker: jest.fn(async () => fixture.directory),
        moatPersistence: { persistProjectConnection: jest.fn(async () => true) },
        addEventListener(type, listener) { listeners.set(type, listener); },
        dispatchEvent(event) { listeners.get(event.type)?.(event); }
      },
      chrome: { runtime: { getURL: value => value, onMessage: { addListener(fn) { messageListener = fn; } } },
        storage: { local: { remove: jest.fn(async () => {}) } } },
      fetch: async filename => ({ ok: true, text: async () => fs.readFileSync(path.resolve(__dirname, '../../chrome-extension', filename), 'utf8') }),
      initializeUtilitiesWithRetry: async () => { taskStore.initialize(context.window.directoryHandle); },
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
      relayToSidePanel: message => panel.handleMessage({ ...message, sourceTabId: 1, sourceWindowId: 10 }),
      showNotification: jest.fn(), console: { log() {}, warn() {}, error() {} }
    });
    vm.runInContext(sourceSection(contentSource, '  async function setupProject(', '  // Generate fallback bridge.md template'), context);
    vm.runInContext(sourceSection(contentSource, '  chrome.runtime.onMessage.addListener(', '  // Helper to relay messages'), context);
    vm.runInContext(sourceSection(contentSource, '  // Relay project connection events to side panel', '  // Relay task update events to side panel'), context);
    const response = deferred();
    messageListener({ type: 'SETUP_PROJECT' }, {}, response.resolve);
    await expect(response.promise).resolves.toEqual({ success: true });
    expect([...dom.window.document.querySelectorAll('.notification.success')].map(node => node.textContent))
      .toEqual(['Project connected']);
    expect(dom.window.document.querySelector('.status-text').textContent).toBe(fixture.directory.name);
    expect(panel.requestTasks).toHaveBeenCalledTimes(1);
  } finally {
    dom.window.close();
    fixture.cleanup();
  }
});
