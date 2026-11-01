const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AnnotationStore } = require('./utils/annotationStore');
const { MoatPersistence } = require('./utils/persistence');
const { directoryFixture } = require('./tests/directory-handle');
const source = fs.readFileSync(require.resolve('./content_script.js'), 'utf8');
let fixture;
beforeEach(() => { fixture = directoryFixture(); });
afterEach(() => { fixture.cleanup(); delete global.window; });

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
    fetch: async filename => ({ ok: true, status: 200, text: async () => fs.readFileSync(path.join(__dirname, filename), 'utf8') }),
    localStorage: { setItem: jest.fn(), getItem: () => null },
    initializeUtilitiesWithRetry: async () => { taskStore.initialize(context.window.directoryHandle); },
    canUseNewTaskSystem: () => true, markdownGenerator: {}, CustomEvent: class {},
    showNotification: jest.fn(), console: { log() {}, warn() {}, error() {} }
  });
  vm.runInContext(source.slice(source.indexOf('  async function setupProject('), source.indexOf('  // Generate fallback workflow template')), context);
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

test('restoring a connection returns the selected root without creating files', async () => {
  global.window = { location: { origin: 'https://example.com' } };
  const persistence = new MoatPersistence();
  persistence.getDirectoryHandle = jest.fn(async () => ({ handle: fixture.directory, path: 'project', timestamp: 1 }));
  persistence.verifyPermission = jest.fn(async () => true);
  const restored = await persistence.restoreProjectConnection();
  expect(restored.success).toBe(true);
  expect(restored.directoryHandle).toBe(fixture.directory);
  expect(fs.readdirSync(fixture.root)).toEqual([]);
});
