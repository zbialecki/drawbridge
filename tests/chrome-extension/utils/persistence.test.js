const { MoatPersistence } = require('../../../chrome-extension/utils/persistence');
const { indexedDBFixture } = require('../../helpers/indexed-db');
const originalNavigator = Object.getOwnPropertyDescriptor(global, 'navigator');
const NOW = Date.parse('2026-11-01T15:42:00Z');
const DAY = 24 * 60 * 60 * 1000;
let fixture;
let persistence;
let handle;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['queueMicrotask'] });
  fixture = indexedDBFixture();
  global.indexedDB = fixture.indexedDB;
  handle = {
    name: 'test-project', kind: 'directory', getDirectoryHandle: jest.fn(),
    queryPermission: jest.fn(async () => 'granted'),
    requestPermission: jest.fn(async () => 'granted'),
    async *values() {}
  };
  global.window = { location: { origin: 'https://example.com' }, indexedDB, showDirectoryPicker: jest.fn() };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { userAgent: 'test browser' } });
  persistence = new MoatPersistence();
});
afterEach(() => {
  delete global.window;
  delete global.indexedDB;
  if (originalNavigator) Object.defineProperty(global, 'navigator', originalNavigator);
  else delete global.navigator;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('initializes the compatible database schema once per instance', async () => {
  const open = jest.spyOn(indexedDB, 'open');
  const db = await persistence.initialize();
  expect(open).toHaveBeenCalledWith('MoatPersistence', 1);
  expect(db.objectStoreNames.contains('directoryHandles')).toBe(true);
  expect(db.transaction(['directoryHandles']).objectStore('directoryHandles').indexNames).toEqual(['origin', 'timestamp']);
  expect(await persistence.initialize()).toBe(db);
  expect(open).toHaveBeenCalledTimes(1);
});

test('persists a connection that a fresh instance can restore after a restart', async () => {
  expect(await persistence.persistProjectConnection(handle, 'test-project')).toBe(true);
  const restarted = new MoatPersistence();
  const restored = await restarted.restoreProjectConnection();
  expect(restored).toMatchObject({ success: true, path: 'test-project', timestamp: NOW, restored: true });
  expect(restored.directoryHandle).toBe(handle);
  expect(handle.queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
  expect(handle.requestPermission).not.toHaveBeenCalled();
  expect(handle.getDirectoryHandle).not.toHaveBeenCalled();
  expect(await restarted.getAllHandles()).toMatchObject([{
    id: 'project_https://example.com', handle, path: 'test-project', origin: 'https://example.com', timestamp: NOW
  }]);
});

test('does not restore another page origin\'s project', async () => {
  await persistence.persistProjectConnection(handle, 'first-project');
  window.location.origin = 'https://other.example.com';
  expect(await new MoatPersistence().restoreProjectConnection()).toEqual({ success: false, reason: 'No stored connection' });
  await persistence.persistProjectConnection(handle, 'second-project');
  expect((await persistence.restoreProjectConnection()).path).toBe('second-project');
  window.location.origin = 'https://example.com';
  expect((await new MoatPersistence().restoreProjectConnection()).path).toBe('first-project');
});

test('cleanup removes only old handles, preserving recent handles and the exact age boundary', async () => {
  await persistence.storeDirectoryHandle('old', handle, { timestamp: NOW - 31 * DAY });
  await persistence.storeDirectoryHandle('boundary', handle, { timestamp: NOW - 30 * DAY });
  await persistence.storeDirectoryHandle('recent', handle, { timestamp: NOW - DAY });
  expect(await persistence.cleanupOldHandles()).toEqual(['old']);
  expect((await persistence.getAllHandles()).map(record => record.id).sort()).toEqual(['boundary', 'recent']);
  expect(await persistence.getDirectoryHandle('old')).toBeNull();
});

test('rejects an invalid directory handle without storing it', async () => {
  await expect(persistence.storeDirectoryHandle('invalid', null)).rejects.toThrow('Invalid directory handle');
  expect(await persistence.getAllHandles()).toEqual([]);
});

test('expired permission requires reconnection without prompting on page load', async () => {
  handle.queryPermission.mockResolvedValue('prompt');
  await persistence.persistProjectConnection(handle, 'test-project');
  expect(await persistence.restoreProjectConnection()).toMatchObject({
    success: false, requiresReconnection: true, path: 'test-project'
  });
  expect(handle.requestPermission).not.toHaveBeenCalled();
  expect(await persistence.getAllHandles()).toHaveLength(1);
});

test('a stored handle that can no longer access its directory is not restored', async () => {
  await persistence.persistProjectConnection(handle, 'test-project');
  handle.values = () => { throw new Error('Directory moved'); };
  expect(await persistence.restoreProjectConnection()).toMatchObject({ success: false, reason: 'Cannot access selected folder' });
});

test('database initialization failures reject initialization and report failed persistence', async () => {
  fixture.state.fail = 'open';
  await expect(persistence.initialize()).rejects.toThrow('open denied');
  expect(await persistence.persistProjectConnection(handle, 'test-project')).toBe(false);
});

test('a failed database write does not report a connection as persisted', async () => {
  fixture.state.fail = 'put';
  expect(await persistence.persistProjectConnection(handle, 'test-project')).toBe(false);
  expect(await persistence.getAllHandles()).toEqual([]);
});

test('a database read failure does not restore a connection or delete its stored record', async () => {
  await persistence.persistProjectConnection(handle, 'test-project');
  fixture.state.fail = 'get';
  expect(await persistence.restoreProjectConnection()).toMatchObject({ success: false, reason: 'get denied' });
  fixture.state.fail = null;
  expect(await persistence.getAllHandles()).toHaveLength(1);
});
