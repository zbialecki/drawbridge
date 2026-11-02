const fs = require('node:fs');
const path = require('node:path');
const { TaskStore, validateTaskObject } = require('../../../chrome-extension/utils/taskStore');
const { directoryFixture } = require('../../helpers/directory-handle');
let fixture;
let store;

beforeEach(() => {
  jest.useFakeTimers({ now: 1000, doNotFake: ['queueMicrotask', 'setImmediate', 'nextTick'] });
  fixture = directoryFixture();
  store = new TaskStore();
  store.initialize(fixture.directory);
});
afterEach(() => { fixture.cleanup(); jest.useRealTimers(); });

test.each(['id', 'title', 'comment', 'status', 'timestamp'])('legacy metadata requires %s', field => {
  const task = { id: 'one', title: 'Test', comment: 'Comment', status: 'to do', timestamp: 1 };
  delete task[field];
  expect(() => validateTaskObject(task)).toThrow(`Task missing required field: ${field}`);
});

test('rejects an unsupported task status', () => {
  expect(() => validateTaskObject({ id: 'one', title: 'Test', comment: 'Comment', status: 'unknown', timestamp: 1 }))
    .toThrow('Invalid task status');
});

test('saves distinct tasks and reloads their data, defaults, and chronological views', async () => {
  const first = await store.addTaskAndSave({ title: 'Element', comment: 'First comment', selector: 'button' });
  jest.setSystemTime(2000);
  const second = await store.addTaskAndSave({ title: 'Rectangle', comment: 'Second comment' });
  expect(first.id).toEqual(expect.any(String));
  expect(first.id).not.toBe('');
  expect(second.id).not.toBe(first.id);
  expect(JSON.parse(fixture.read('moat-tasks-detail.json'))).toMatchObject([
    { id: first.id, comment: 'First comment', selector: 'button', status: 'to do', timestamp: 1000 },
    { id: second.id, comment: 'Second comment', selector: null, screenshotPath: '', timestamp: 2000 }
  ]);
  const reloaded = new TaskStore();
  reloaded.initialize(fixture.directory);
  expect((await reloaded.loadTasksFromFile()).map(task => task.id)).toEqual([second.id, first.id]);
  expect(reloaded.getAllTasksChronological().map(task => task.id)).toEqual([first.id, second.id]);
});

test('rejects corrupt task data before opening a legacy task file for writing', async () => {
  store.tasks.push({ invalid: 'task' });
  await expect(store.saveTasksToFile()).rejects.toThrow('Task missing required field');
  expect(fixture.exists('moat-tasks-detail.json')).toBe(false);
});

test('reports malformed legacy JSON without overwriting it', async () => {
  fs.writeFileSync(path.join(fixture.root, 'moat-tasks-detail.json'), '{invalid json');
  await expect(store.loadTasksFromFile()).rejects.toThrow('Failed to load tasks');
  expect(fixture.read('moat-tasks-detail.json')).toBe('{invalid json');
});

test('a failed legacy write preserves saved data and releases its lock for retry', async () => {
  const task = await store.addTaskAndSave({ title: 'Test', comment: 'Keep this comment' });
  const original = fixture.read('moat-tasks-detail.json');
  fixture.state.failWrite = 'moat-tasks-detail.json';
  await expect(store.updateTaskStatusAndSave(task.id, 'done')).rejects.toThrow('Write denied');
  expect(fixture.read('moat-tasks-detail.json')).toBe(original);
  fixture.state.failWrite = null;
  await store.updateTaskStatusAndSave(task.id, 'done');
  expect(JSON.parse(fixture.read('moat-tasks-detail.json'))[0].status).toBe('done');
});

test('creates a timestamped backup containing the saved tasks', async () => {
  const task = await store.addTaskAndSave({ title: 'Test', comment: 'Keep this comment' });
  expect(await store.createBackup()).toBe(true);
  const backup = fs.readdirSync(fixture.root).find(name => /^moat-tasks-detail\.backup\..*\.json$/.test(name));
  expect(JSON.parse(fixture.read(backup))).toMatchObject([{ id: task.id, comment: 'Keep this comment' }]);
});
