const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sourceSection, deferred } = require('../helpers/test-utils');
const { indexedDBFixture } = require('../helpers/indexed-db');
const { AnnotationStore } = require('../../chrome-extension/utils/annotationStore');
const { MoatPersistence } = require('../../chrome-extension/utils/persistence');
const { directoryFixture } = require('../helpers/directory-handle');
const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');
let fixture;
beforeEach(() => { fixture = directoryFixture(); });
afterEach(() => { fixture.cleanup(); delete global.window; delete global.indexedDB; });

test('connecting uses the selected folder and installs commands without creating hidden storage or overwriting project files', async () => {
  fs.writeFileSync(path.join(fixture.root, 'README.md'), 'My README');
  fs.writeFileSync(path.join(fixture.root, 'config.json'), '{"mine":true}');
  const taskStore = new AnnotationStore();
  const context = vm.createContext({
    taskStore, projectRoot: null, connectionEventDispatched: false,
    window: {
      location: { origin: 'https://example.com' },
      showDirectoryPicker: jest.fn(async () => fixture.directory),
      moatPersistence: { persistProjectConnection: jest.fn(async () => true) },
      dispatchEvent: jest.fn()
    },
    chrome: { runtime: { getURL: value => value }, storage: { local: { remove: jest.fn(async () => {}) } } },
    fetch: async filename => ({ ok: true, status: 200, text: async () => fs.readFileSync(path.resolve(__dirname, '../../chrome-extension', filename), 'utf8') }),
    localStorage: { setItem: jest.fn(), getItem: () => null },
    initializeUtilitiesWithRetry: async () => { taskStore.initialize(context.window.directoryHandle); },
    canUseNewTaskSystem: () => true, markdownGenerator: {}, CustomEvent: class {},
    showNotification: jest.fn(), console: { log() {}, warn() {}, error() {} }
  });
  vm.runInContext(sourceSection(source, '  async function setupProject(', '  // Generate fallback workflow template'), context);
  expect(await context.setupProject()).toBe(true);
  expect(context.window.directoryHandle).toBe(fixture.directory);
  expect(fixture.exists('.moat')).toBe(false);
  expect(fixture.exists('screenshots')).toBe(false);
  expect(fixture.exists('moat-tasks.md')).toBe(false);
  expect(fixture.read('README.md')).toBe('My README');
  expect(fixture.read('config.json')).toBe('{"mine":true}');
  const command = fixture.read('.claude/commands/bridge.md');
  expect(command).toContain('metadata.json');
  expect(command).toContain('relative to that metadata');
  expect(fixture.read('.windsurf/workflows/bridge.md')).toBe(command);
  expect(fixture.read('.codex/prompts/bridge.md')).toBe(command);
});

async function persistedConnection() {
  global.window = { location: { origin: 'https://example.com' }, directoryHandle: fixture.directory };
  global.indexedDB = indexedDBFixture().indexedDB;
  fixture.directory.queryPermission = jest.fn(async () => 'granted');
  const persistence = new MoatPersistence();
  await persistence.storeDirectoryHandle('project_https://example.com', fixture.directory, { path: 'project' });
  window.moatPersistence = persistence;
  return persistence;
}

function connectionContext() {
  const data = new Map([
    ['moat.connection', 'old connection'], ['moat.project.https://example.com', 'project'], ['unrelated', 'keep']
  ]);
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const context = vm.createContext({ window, localStorage: storage, MoatPersistence,
    projectRoot: 'project', markdownFileHandle: null, connectionEventDispatched: true,
    relayToSidePanel: jest.fn(), checkLegacyConnection: jest.fn(),
    console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(fs.readFileSync(require.resolve('../../chrome-extension/utils/safeStorage'), 'utf8'), context);
  return { context, data };
}

test('restoring a connection returns the selected root without creating files', async () => {
  const persistence = await persistedConnection();
  const restored = await persistence.restoreProjectConnection();
  expect(restored.success).toBe(true);
  expect(restored.directoryHandle).toBe(fixture.directory);
  expect(fs.readdirSync(fixture.root)).toEqual([]);
});

test('disconnect uses the real persistence and safe-storage interfaces to forget only this project', async () => {
  const persistence = await persistedConnection();
  const { context, data } = connectionContext();
  let listener;
  context.chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } } } };
  vm.runInContext(sourceSection(source, '  chrome.runtime.onMessage.addListener(', '  // Helper to relay messages'), context);
  const response = deferred();
  expect(listener({ type: 'DISCONNECT_PROJECT' }, {}, response.resolve)).toBe(true);
  await expect(response.promise).resolves.toEqual({ success: true });
  expect(await persistence.getDirectoryHandle('project_https://example.com')).toBeNull();
  expect([...data]).toEqual([['unrelated', 'keep']]);
  expect(context.window.directoryHandle).toBeNull();
  expect(context.relayToSidePanel).toHaveBeenCalledWith({ type: 'PROJECT_DISCONNECTED' });
});

test('a stored disconnect flag clears the connection without attempting automatic restoration', async () => {
  const persistence = await persistedConnection();
  const { context, data } = connectionContext();
  const flag = 'drawbridge:disconnected:https://example.com';
  context.chrome = { storage: { local: {
    get: jest.fn(async () => ({ [flag]: true })), remove: jest.fn(async () => {})
  } } };
  vm.runInContext(sourceSection(source, '  async function initializeProject(', '  // Check for legacy localStorage connections'), context);
  await context.initializeProject();
  expect(context.checkLegacyConnection).not.toHaveBeenCalled();
  expect(await persistence.getDirectoryHandle('project_https://example.com')).toBeNull();
  expect(data.has('moat.connection')).toBe(false);
  expect(context.chrome.storage.local.remove).toHaveBeenCalledWith(flag);
});
