const fs = require('fs');
const vm = require('vm');
const { sourceSection } = require('../helpers/test-utils');
const { AnnotationStore } = require('../../chrome-extension/utils/annotationStore');
const { directoryFixture } = require('../helpers/directory-handle');
const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');
let fixture;
async function setup() {
  fixture = directoryFixture();
  const taskStore = new AnnotationStore();
  taskStore.initialize(fixture.directory);
  for (const id of ['one', 'two']) {
    await taskStore.saveAnnotation({ id, timestamp: new Date(2026, 10, 1, 15, 42).getTime(), content: id,
      screenshot: 'data:image/png;base64,eA==', pastedImages: ['data:image/png;base64,eA=='] }, { title: id, comment: `${id} comment` });
  }
  const context = vm.createContext({ taskStore, window: { directoryHandle: fixture.directory, dispatchEvent: jest.fn() }, CustomEvent: class {} });
  vm.runInContext(sourceSection(source, '  async function updateTaskStatusFromSidePanel(', '  // Get count of screenshots'), context);
  return { context, taskStore };
}
afterEach(() => { fixture?.cleanup(); fixture = null; });

test('deleting a task removes its annotation folder, not another task', async () => {
  const { context, taskStore } = await setup();
  const first = taskStore.getTaskById('one').folderName;
  const second = taskStore.getTaskById('two').folderName;
  for (const file of ['screenshot.png', 'metadata.json', 'comment.md', 'reference-1.png']) {
    expect(fixture.exists(`${first}/${file}`)).toBe(true);
  }
  await context.deleteTaskFromSidePanel('one');
  expect(taskStore.tasks.map(t => t.id)).toEqual(['two']);
  expect(fixture.exists(first)).toBe(false);
  expect(JSON.parse(fixture.read(`${second}/metadata.json`)).comment).toBe('two comment');
  expect(fixture.exists('moat-tasks-detail.json')).toBe(false);
});

test('a missing task reports an error instead of signaling a successful deletion', async () => {
  const { context, taskStore } = await setup();
  await expect(context.deleteTaskFromSidePanel('missing')).rejects.toThrow('Task not found');
  expect(taskStore.tasks).toHaveLength(2);
  expect(context.window.dispatchEvent).not.toHaveBeenCalled();
});

test('changing status keeps the annotation comment and metadata consistent', async () => {
  const { context, taskStore } = await setup();
  const folder = taskStore.getTaskById('one').folderName;
  await context.updateTaskStatusFromSidePanel('one', 'done');
  expect(JSON.parse(fixture.read(`${folder}/metadata.json`)).status).toBe('done');
  expect(fixture.read(`${folder}/comment.md`)).toContain('[x] done');
});

test('native panel connections enable shortcuts only while connected', () => {
  let connect;
  let disconnect;
  const context = vm.createContext({ sidePanelConnections: 0, chrome: { runtime: { onConnect: { addListener(fn) { connect = fn; } } } } });
  vm.runInContext(sourceSection(source, '  chrome.runtime.onConnect.addListener(', '  window.__drawbridgeDebug ='), context);
  connect({ name: 'unrelated' });
  expect(context.sidePanelConnections).toBe(0);
  connect({ name: 'drawbridge-sidepanel', onDisconnect: { addListener(fn) { disconnect = fn; } } });
  expect(context.sidePanelConnections).toBe(1);
  disconnect();
  expect(context.sidePanelConnections).toBe(0);
});
