jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AnnotationStore } = require('../../chrome-extension/utils/annotationStore');
const { directoryFixture } = require('../helpers/directory-handle');
const { readAnnotations, processAnnotations } = require('../../scripts/drawbridge-watcher');
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
let fixture;
beforeEach(() => {
  fixture = directoryFixture();
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  spawnSync.mockReturnValue({ status: 0 });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  try { fixture.cleanup(); }
  finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    jest.restoreAllMocks();
  }
});

async function save(id, comment = 'Make it smaller') {
  const store = new AnnotationStore();
  store.initialize(fixture.directory);
  return store.saveAnnotation({ id, timestamp: new Date(2026, 10, 1, 15, 42).getTime(), content: comment }, { title: 'Button', comment });
}

test('discovers annotations and stores clipboard receipts without copying them again', async () => {
  const first = await save('one', 'First issue');
  const second = await save('two', 'Second issue');
  expect(readAnnotations(fixture.root).map(entry => entry.metadata.id)).toEqual(['one', 'two']);
  processAnnotations(fixture.root);
  expect(spawnSync).toHaveBeenCalledTimes(1);
  const { input } = spawnSync.mock.calls[0][1];
  for (const text of [first.folderName, second.folderName, 'First issue', 'Second issue']) expect(input).toContain(text);
  expect(spawnSync).toHaveBeenCalledWith('pbcopy', { input, encoding: 'utf8' });
  expect(JSON.parse(fixture.read(`${first.folderName}/watcher.json`)).id).toBe('one');
  expect(JSON.parse(fixture.read(`${second.folderName}/watcher.json`)).id).toBe('two');
  processAnnotations(fixture.root);
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(fixture.exists('.moat')).toBe(false);
});

test('a failed clipboard command does not mark an annotation copied or change its metadata', async () => {
  spawnSync.mockReturnValue({ status: 1, stderr: 'Clipboard unavailable' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const tasks = [await save('one', 'First issue'), await save('two', 'Second issue')];
  const before = tasks.map(task => fixture.read(`${task.folderName}/metadata.json`));
  processAnnotations(fixture.root);
  expect(spawnSync).toHaveBeenCalledTimes(1);
  for (const [index, task] of tasks.entries()) {
    expect(fixture.exists(`${task.folderName}/watcher.json`)).toBe(false);
    expect(fixture.read(`${task.folderName}/metadata.json`)).toBe(before[index]);
  }
  expect(fs.readdirSync(fixture.root)).toEqual(tasks.map(task => task.folderName));
  spawnSync.mockReturnValue({ status: 0 });
  processAnnotations(fixture.root);
  expect(spawnSync).toHaveBeenCalledTimes(2);
  for (const task of tasks) expect(JSON.parse(fixture.read(`${task.folderName}/watcher.json`)).id).toBe(task.id);
});

test('invalid metadata does not block copying the valid queue', async () => {
  const task = await save('one');
  const invalid = `${task.folderName}_2`;
  fs.mkdirSync(path.join(fixture.root, invalid));
  fs.writeFileSync(path.join(fixture.root, invalid, 'metadata.json'), JSON.stringify({
    ...JSON.parse(fixture.read(`${task.folderName}/metadata.json`)), id: 7
  }));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(readAnnotations(fixture.root).map(entry => entry.metadata.id)).toEqual(['one']);
  processAnnotations(fixture.root);
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(fixture.exists(`${invalid}/watcher.json`)).toBe(false);
});

test('the copied prompt includes component context when it was captured', async () => {
  const store = new AnnotationStore();
  store.initialize(fixture.directory);
  await store.saveAnnotation({
    id: 'react', timestamp: new Date(2026, 10, 1, 15, 42).getTime(), content: 'Smaller',
    react: { component: 'SaveButton', componentEnv: 'client', source: 'app/SaveButton.js:4:10', route: 'app/page.js' },
    framework: { name: 'next', buildId: 'abc123' }
  }, { title: 'Button', comment: 'Smaller' });
  processAnnotations(fixture.root);
  const { input } = spawnSync.mock.calls[0][1];
  expect(input).toContain('Component: SaveButton (client)');
  expect(input).toContain('Source: app/SaveButton.js:4:10');
  expect(input).toContain('Route: app/page.js');
  expect(input).toContain('Build: abc123');
});

