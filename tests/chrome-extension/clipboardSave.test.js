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
  // Stands in for the side panel, which receives a copy of the message.
  const save = jest.fn(async ({ annotation, taskData }) => {
    if (failure === 'disconnected') return { success: false, error: 'Connect a project in the Drawbridge side panel.' };
    try {
      const saved = await taskStore.saveAnnotation(annotation, taskData);
      return { success: true, folderName: saved.folderName };
    } catch (error) {
      return { success: false, error: error.message, folderName: annotation.folderName };
    }
  });
  const runtime = { sendMessage(message, reply) { save(structuredClone(message)).then(reply); } };
  const context = vm.createContext({ chrome: { runtime }, console: { log() {}, error() {} }, Date,
    Promise, convertAnnotationToTask: annotation => ({ title: 'Button', comment: annotation.content }), showNotification: jest.fn() });
  vm.runInContext(sourceSection(source, '  async function submitCommentAnnotation(', '  // Wire clipboard-image paste'), context);
  vm.runInContext(sourceSection(source, '  // Folder access lives in the side panel', '  // Read React and Next.js details'), context);
  vm.runInContext(sourceSection(source, '  // Add annotation to queue', '  // Get user-friendly element label'), context);
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
  expect(save.mock.calls[0][0].annotation.id).toBe(annotation.id);
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
  saved.resolve({ success: true, folderName: '26-11-01 15-42' });
  expect(await first).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
});

test('framework context is saved with the annotation, and a failed capture still saves', async () => {
  const { context, box, annotation, save } = setup();
  box.frameworkContext = Promise.resolve({ framework: { name: 'next', buildId: 'abc' }, react: { component: 'Save' } });
  expect(await context.submitCommentAnnotation(box, annotation)).toBe(true);
  expect(JSON.parse(fixture.read(`${annotation.folderName}/metadata.json`))).toMatchObject({
    framework: { buildId: 'abc' }, react: { component: 'Save' }
  });

  const failed = { ...box, frameworkContext: Promise.resolve(null), isSubmitting: false, annotationTimestamp: undefined, annotationFolderName: undefined };
  const second = { id: 'second', content: 'Without context', timestamp: annotation.timestamp + 60000 };
  expect(await context.submitCommentAnnotation(failed, second)).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fixture.read(`${second.folderName}/metadata.json`)).react).toBeUndefined();
});

test('a closed side panel keeps the draft and says so on the page', async () => {
  const { context, box, button, annotation } = setup();
  context.chrome.runtime = {
    lastError: { message: 'The message port closed before a response was received.' },
    sendMessage(message, reply) { reply(undefined); }
  };
  expect(await context.submitCommentAnnotation(box, annotation)).toBe(false);
  expect(context.showNotification).toHaveBeenCalledWith(expect.stringContaining('Open the Drawbridge side panel'), 'error');
  expect(button.textContent).toContain('Open the Drawbridge side panel');
  expect(button.disabled).toBe(false);
});
