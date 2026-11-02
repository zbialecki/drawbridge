const fs = require('fs');
const vm = require('vm');
const { sourceSection, deferred } = require('../helpers/test-utils');
const { AnnotationStore } = require('../../chrome-extension/utils/annotationStore');
const { directoryFixture } = require('../helpers/directory-handle');
const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');
let fixture;
function setup(failure) {
  fixture = directoryFixture();
  if (failure === 'file') fixture.state.failWrite = 'reference-1.png';
  if (failure === 'directory') fixture.directory.getDirectoryHandle = async () => { throw new Error('Directory permission denied'); };
  const taskStore = new AnnotationStore();
  taskStore.initialize(fixture.directory);
  const save = jest.fn(async annotation => taskStore.saveAnnotation(annotation, { title: 'Button', comment: annotation.content }));
  const context = vm.createContext({ window: { directoryHandle: failure === 'disconnected' ? null : fixture.directory },
    taskStore, console: { log() {}, error() {} }, Date,
    saveAnnotationWithNewSystem: save, showNotification: jest.fn() });
  vm.runInContext(sourceSection(source, '  async function submitCommentAnnotation(', '  // Wire clipboard-image paste'), context);
  vm.runInContext(sourceSection(source, '  async function addToQueue(', '  // Get user-friendly element label'), context);
  const button = { disabled: false };
  const box = { pastedImages: ['data:image/png;base64,eA=='], querySelector: () => button };
  const annotation = { id: 'test', content: 'Keep this comment', pastedImages: box.pastedImages,
    timestamp: new Date(2026, 10, 1, 15, 42).getTime() };
  return { context, button, box, annotation, save, taskStore };
}
afterEach(() => { fixture?.cleanup(); });

test.each(['directory', 'file', 'disconnected'])('retains editable draft on %s failure', async failure => {
  const { context, box, button, annotation, taskStore } = setup(failure);
  expect(await context.submitCommentAnnotation(box, annotation)).toBe(false);
  expect(taskStore.tasks).toHaveLength(0);
  expect(annotation.content).toBe('Keep this comment');
  expect(box.pastedImages).toEqual(['data:image/png;base64,eA==']);
  expect(button.disabled).toBe(false);
  expect(box.isSubmitting).toBe(false);
  expect(context.showNotification).toHaveBeenCalledWith(expect.stringContaining('retry'), 'error');
});

test('saves pasted images beside their comment and metadata', async () => {
  const { context, box, annotation, save, taskStore } = setup();
  expect(await context.submitCommentAnnotation(box, annotation)).toBe(true);
  const task = taskStore.tasks[0];
  expect(fixture.read(`${task.folderName}/reference-1.png`)).toBe('x');
  expect(JSON.parse(fixture.read(`${task.folderName}/metadata.json`)).attachments).toEqual(['./reference-1.png']);
  expect(save).toHaveBeenCalledWith(annotation);
});

test('a retry in a later minute keeps the original annotation folder', async () => {
  const { context, box, annotation, taskStore } = setup('file');
  expect(await context.submitCommentAnnotation(box, annotation)).toBe(false);
  fixture.state.failWrite = null;
  const retry = { id: annotation.id, content: annotation.content, pastedImages: box.pastedImages,
    timestamp: annotation.timestamp + 60000 };
  expect(await context.submitCommentAnnotation(box, retry)).toBe(true);
  expect(taskStore.tasks[0].folderName).toBe('26-11-01 15-42');
  expect(fixture.exists('26-11-01 15-43')).toBe(false);
});

test('prevents duplicate submissions during an outstanding save', async () => {
  const { context, box, annotation, save } = setup();
  const started = deferred();
  const saved = deferred();
  save.mockImplementation(() => { started.resolve(); return saved.promise; });
  const first = context.submitCommentAnnotation(box, annotation);
  await started.promise;
  expect(await context.submitCommentAnnotation(box, annotation)).toBe(false);
  saved.resolve(true);
  expect(await first).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
});
