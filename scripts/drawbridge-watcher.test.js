const fs = require('node:fs');
const { AnnotationStore } = require('../chrome-extension/utils/annotationStore');
const { directoryFixture } = require('../chrome-extension/tests/directory-handle');
const { readAnnotations, processAnnotations } = require('./drawbridge-watcher');
let fixture;
beforeEach(() => { fixture = directoryFixture(); jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { fixture.cleanup(); jest.restoreAllMocks(); });

async function save(id, comment = 'Make it smaller') {
  const store = new AnnotationStore();
  store.initialize(fixture.directory);
  return store.saveAnnotation({ id, timestamp: new Date(2026, 10, 1, 15, 42).getTime(), content: comment }, { title: 'Button', comment });
}

test('discovers each timestamped annotation and stores clipboard receipts in its own folder', async () => {
  const first = await save('one');
  const second = await save('two');
  expect(readAnnotations(fixture.root).map(entry => entry.metadata.id)).toEqual(['one', 'two']);
  const copy = jest.fn(() => true);
  processAnnotations(fixture.root, copy);
  expect(copy).toHaveBeenCalledTimes(2);
  expect(copy.mock.calls[0][0]).toContain(first.folderName);
  expect(JSON.parse(fixture.read(`${first.folderName}/watcher.json`)).id).toBe('one');
  expect(JSON.parse(fixture.read(`${second.folderName}/watcher.json`)).id).toBe('two');
  processAnnotations(fixture.root, copy);
  expect(copy).toHaveBeenCalledTimes(2);
  expect(fixture.exists('.moat')).toBe(false);
});

test('a clipboard failure does not mark an annotation copied or change its metadata', async () => {
  const task = await save('one', 'Keep this exact text');
  const before = fixture.read(`${task.folderName}/metadata.json`);
  processAnnotations(fixture.root, () => false);
  expect(fixture.exists(`${task.folderName}/watcher.json`)).toBe(false);
  expect(fixture.read(`${task.folderName}/metadata.json`)).toBe(before);
  expect(fs.readdirSync(fixture.root)).toEqual([task.folderName]);
});
