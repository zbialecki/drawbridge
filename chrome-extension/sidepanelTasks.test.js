const fs = require('fs');
const vm = require('vm');
const { AnnotationStore } = require('./utils/annotationStore');
const { directoryFixture } = require('./tests/directory-handle');
const source = fs.readFileSync(require.resolve('./content_script.js'), 'utf8');
let fixture;
async function setup() {
  fixture = directoryFixture();
  const taskStore = new AnnotationStore();
  taskStore.initialize(fixture.directory);
  for (const id of ['one', 'two']) {
    await taskStore.saveAnnotation({ id, timestamp: new Date(2026, 10, 1, 15, 42).getTime(), content: id,
      screenshot: 'data:image/png;base64,eA==' }, { title: id, comment: `${id} comment` });
  }
  const context = vm.createContext({ taskStore, window: { directoryHandle: fixture.directory, dispatchEvent: jest.fn() }, CustomEvent: class {} });
  vm.runInContext(source.slice(source.indexOf('  async function updateTaskStatusFromSidePanel('), source.indexOf('  // Get count of screenshots')), context);
  return { context, taskStore };
}
afterEach(() => { fixture?.cleanup(); fixture = null; });

test('deleting a task removes its annotation folder, not another task', async () => {
  const { context, taskStore } = await setup();
  const first = taskStore.getTaskById('one').folderName;
  const second = taskStore.getTaskById('two').folderName;
  await context.deleteTaskFromSidePanel('one');
  expect(taskStore.tasks.map(t => t.id)).toEqual(['two']);
  expect(fixture.exists(first)).toBe(false);
  expect(JSON.parse(fixture.read(`${second}/metadata.json`)).comment).toBe('two comment');
  expect(fixture.exists('moat-tasks-detail.json')).toBe(false);
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
  vm.runInContext(source.slice(source.indexOf('  chrome.runtime.onConnect.addListener('), source.indexOf('  window.__drawbridgeDebug =')), context);
  connect({ name: 'unrelated' });
  expect(context.sidePanelConnections).toBe(0);
  connect({ name: 'drawbridge-sidepanel', onDisconnect: { addListener(fn) { disconnect = fn; } } });
  expect(context.sidePanelConnections).toBe(1);
  disconnect();
  expect(context.sidePanelConnections).toBe(0);
});
