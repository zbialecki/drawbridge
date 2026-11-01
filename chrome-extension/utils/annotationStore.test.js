const fs = require('node:fs');
const path = require('node:path');
const { AnnotationStore, timestampFolder } = require('./annotationStore');
const { directoryFixture } = require('../tests/directory-handle');

const timestamp = new Date(2026, 10, 1, 15, 42, 38).getTime();
const folder = '26-11-01 15-42';
const image = 'data:image/png;base64,eA==';
const taskData = { title: 'Button', comment: 'Make this button smaller.\nKeep its label.', selector: 'button' };
const annotation = (id = 'one') => ({
  id, timestamp, content: taskData.comment, screenshot: image, pastedImages: [image],
  pageUrl: 'https://example.com/settings', elementContext: { tagName: 'button' },
  boundingRect: { x: 10, y: 20, width: 50, height: 40 },
  clickPosition: { x: 5, y: 6 }, screenshotViewport: { x: 0, y: 0, width: 250, height: 200 }
});
let fixture;
let store;
beforeEach(() => {
  fixture = directoryFixture();
  store = new AnnotationStore();
  store.initialize(fixture.directory);
});
afterEach(() => { fixture.cleanup(); jest.restoreAllMocks(); });
const metadata = (name = folder) => JSON.parse(fixture.read(`${name}/metadata.json`));

test('names folders in local time, without seconds', () => {
  expect(timestampFolder(timestamp)).toBe(folder);
  expect(timestampFolder(timestamp)).not.toMatch(/[<>:"/\\|?*]/);
  expect(timestampFolder(new Date(2026, 0, 2, 3, 4, 59).getTime())).toBe('26-01-02 03-04');
  expect(() => timestampFolder('invalid')).toThrow('Invalid annotation timestamp');
});

test('saves a screenshot, complete comment, metadata and references together without touching project files', async () => {
  fs.writeFileSync(path.join(fixture.root, 'README.md'), 'My project');
  const saved = await store.saveAnnotation(annotation(), taskData);
  expect(saved.folderName).toBe(folder);
  expect(saved.screenshotPath).toBe(`./${folder}/screenshot.png`);
  expect(fixture.read(`${folder}/screenshot.png`)).toBe('x');
  expect(fixture.read(`${folder}/reference-1.png`)).toBe('x');
  expect(fixture.read(`${folder}/comment.md`)).toContain(taskData.comment);
  expect(metadata()).toMatchObject({ ...taskData, id: 'one', screenshotPath: './screenshot.png',
    attachments: ['./reference-1.png'], pageUrl: 'https://example.com/settings',
    clickPosition: { x: 5, y: 6 }, screenshotViewport: { width: 250, height: 200 } });
  expect(metadata()).not.toHaveProperty('screenshot');
  expect(metadata()).not.toHaveProperty('pastedImages');
  expect(fixture.read('README.md')).toBe('My project');
  expect(fixture.exists('.moat')).toBe(false);
  expect(fixture.exists('moat-tasks-detail.json')).toBe(false);
});

test('same-minute annotations get _2 and _3 instead of merging or overwriting', async () => {
  for (const id of ['one', 'two', 'three']) await store.saveAnnotation(annotation(id), taskData);
  expect(store.tasks.map(task => task.folderName)).toEqual([folder, `${folder}_2`, `${folder}_3`]);
  expect(metadata().id).toBe('one');
  expect(metadata(`${folder}_2`).id).toBe('two');
  expect(metadata(`${folder}_3`).id).toBe('three');
});

test('the index resets next minute and continues beyond nine conflicts', async () => {
  for (let index = 1; index <= 11; index++) await store.saveAnnotation(annotation(String(index)), taskData);
  expect(metadata(`${folder}_11`).id).toBe('11');
  const next = await store.saveAnnotation({ ...annotation('next'), timestamp: timestamp + 60000 }, taskData);
  expect(next.folderName).toBe('26-11-01 15-43');
});

test('a file with the same name is also a conflict and stays untouched', async () => {
  fs.writeFileSync(path.join(fixture.root, folder), 'My file');
  const saved = await store.saveAnnotation(annotation(), taskData);
  expect(saved.folderName).toBe(`${folder}_2`);
  expect(fixture.read(folder)).toBe('My file');
});

test('an unrelated timestamped directory without metadata stays untouched', async () => {
  fs.mkdirSync(path.join(fixture.root, folder));
  fs.writeFileSync(path.join(fixture.root, folder, 'screenshot.png'), 'My file');
  const saved = await store.saveAnnotation(annotation(), taskData);
  expect(saved.folderName).toBe(`${folder}_2`);
  expect(fixture.read(`${folder}/screenshot.png`)).toBe('My file');
  expect(fixture.exists(`${folder}/metadata.json`)).toBe(false);
});

test('simultaneous saves from different tabs do not overwrite one another', async () => {
  const other = new AnnotationStore();
  other.initialize(fixture.directory);
  const results = await Promise.all([
    store.saveAnnotation(annotation('one'), taskData),
    other.saveAnnotation(annotation('two'), taskData)
  ]);
  expect(new Set(results.map(task => task.folderName)).size).toBe(2);
  expect([metadata().id, metadata(`${folder}_2`).id].sort()).toEqual(['one', 'two']);
});

test.each(['screenshot.png', 'reference-1.png', 'comment.md', 'metadata.json'])('retrying a failed %s write reuses its folder and hides incomplete saves', async failedFile => {
  const draft = annotation();
  fixture.state.failWrite = failedFile;
  await expect(store.saveAnnotation(draft, taskData)).rejects.toThrow('Write denied');
  expect(store.tasks).toHaveLength(0);
  expect(await store.loadTasksFromFile()).toHaveLength(0);
  fixture.state.failWrite = null;
  await store.saveAnnotation(draft, taskData);
  expect(store.tasks).toHaveLength(1);
  expect(fixture.exists(`${folder}_2`)).toBe(false);
  expect(metadata().id).toBe('one');
});

test('retrying an already-saved annotation preserves later agent changes and status', async () => {
  const draft = annotation();
  await store.saveAnnotation(draft, taskData);
  const saved = { ...metadata(), status: 'doing', agentNote: 'Preserve me' };
  fs.writeFileSync(path.join(fixture.root, folder, 'metadata.json'), JSON.stringify(saved));
  await store.saveAnnotation(draft, taskData);
  expect(metadata()).toMatchObject({ status: 'doing', agentNote: 'Preserve me' });
  expect(fixture.exists(`${folder}_2`)).toBe(false);
});

test('capture failure still saves the comment and metadata without an image', async () => {
  const saved = await store.saveAnnotation({ ...annotation(), screenshot: null, pastedImages: [] }, taskData);
  expect(saved.screenshotPath).toBe('');
  expect(fixture.exists(`${folder}/screenshot.png`)).toBe(false);
  expect(metadata().comment).toBe(taskData.comment);
});

test('reloading discovers saved annotations and resolves their image paths', async () => {
  await store.saveAnnotation(annotation(), taskData);
  const reloaded = new AnnotationStore();
  reloaded.initialize(fixture.directory);
  const tasks = await reloaded.loadTasksFromFile();
  expect(tasks).toHaveLength(1);
  expect(tasks[0].id).toBe('one');
  expect(await (await reloaded.getImageFile(tasks[0].screenshotPath)).text()).toBe('x');
  expect(await (await reloaded.getImageFile(tasks[0].attachments[0])).text()).toBe('x');
});

test('status and comment updates stay in the annotation folder and preserve agent metadata edits', async () => {
  await store.saveAnnotation(annotation(), taskData);
  const saved = metadata();
  saved.agentNote = 'Keep this';
  fs.writeFileSync(path.join(fixture.root, folder, 'metadata.json'), JSON.stringify(saved));
  await store.updateTaskStatusAndSave('one', 'done');
  await store.updateTaskCommentAndSave('one', 'Updated comment');
  expect(metadata()).toMatchObject({ status: 'done', comment: 'Updated comment', agentNote: 'Keep this' });
  expect(fixture.read(`${folder}/comment.md`)).toContain('[x] done');
  expect(fixture.read(`${folder}/comment.md`)).toContain('Updated comment');
  expect(fixture.exists('moat-tasks.md')).toBe(false);
});

test('deleting an annotation removes its folder and references, not other annotations', async () => {
  await store.saveAnnotation(annotation('one'), taskData);
  await store.saveAnnotation(annotation('two'), taskData);
  expect(await store.removeTaskAndSave('one')).toBe(true);
  expect(fixture.exists(folder)).toBe(false);
  expect(metadata(`${folder}_2`).id).toBe('two');
  expect(store.tasks.map(task => task.id)).toEqual(['two']);
});

test('refuses to delete a folder whose metadata has been replaced', async () => {
  await store.saveAnnotation(annotation(), taskData);
  fs.writeFileSync(path.join(fixture.root, folder, 'metadata.json'), JSON.stringify({ ...metadata(), id: 'someone-else' }));
  await expect(store.removeTaskAndSave('one')).rejects.toThrow('belongs to another task');
  expect(fixture.exists(`${folder}/screenshot.png`)).toBe(true);
});

test('clearing screenshots preserves comments and pasted references', async () => {
  await store.saveAnnotation(annotation(), taskData);
  expect(await store.clearScreenshots()).toBe(1);
  expect(fixture.exists(`${folder}/screenshot.png`)).toBe(false);
  expect(fixture.exists(`${folder}/reference-1.png`)).toBe(true);
  expect(metadata()).toMatchObject({ screenshotPath: '', attachments: ['./reference-1.png'], comment: taskData.comment });
});

test('does not overwrite an unrelated timestamped folder or invalid metadata', async () => {
  fs.mkdirSync(path.join(fixture.root, folder));
  fs.writeFileSync(path.join(fixture.root, folder, 'metadata.json'), 'Important unrelated file');
  await store.saveAnnotation(annotation(), taskData);
  expect(metadata(`${folder}_2`).id).toBe('one');
  expect(fixture.read(`${folder}/metadata.json`)).toBe('Important unrelated file');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await store.loadTasksFromFile()).toHaveLength(1);
});

test('rejects image paths escaping the selected folder', async () => {
  for (const invalid of ['../secrets.png', `./${folder}/../secret.png`, './.moat/screenshots/../secret.png', '/etc/passwd']) {
    await expect(store.getImageFile(invalid)).rejects.toThrow('Invalid annotation image path');
  }
});

test('existing .moat annotations remain readable without migration or writes on reconnect', async () => {
  fs.mkdirSync(path.join(fixture.root, '.moat/screenshots'), { recursive: true });
  const original = JSON.stringify([{ id: 'old', ...taskData, status: 'to do', timestamp: 1, screenshotPath: './screenshots/old.png' }]);
  fs.writeFileSync(path.join(fixture.root, '.moat/moat-tasks-detail.json'), original);
  fs.writeFileSync(path.join(fixture.root, '.moat/screenshots/old.png'), 'old image');
  await store.loadTasksFromFile();
  expect(store.tasks[0].screenshotPath).toBe('./.moat/screenshots/old.png');
  expect(fixture.read('.moat/moat-tasks-detail.json')).toBe(original);
  expect(await (await store.getImageFile(store.tasks[0].screenshotPath)).text()).toBe('old image');
  await store.saveAnnotation(annotation(), taskData);
  expect(metadata().id).toBe('one');
  expect(fixture.read('.moat/moat-tasks-detail.json')).toBe(original);
  await store.updateTaskStatusAndSave('old', 'done');
  expect(JSON.parse(fixture.read('.moat/moat-tasks-detail.json'))[0].status).toBe('done');
});

test('deleting a legacy task removes its files and description while preserving shared images', async () => {
  fs.mkdirSync(path.join(fixture.root, '.moat/screenshots'), { recursive: true });
  const tasks = [
    { id: 'old-one', ...taskData, comment: 'Remove this description', status: 'to do', timestamp: 1,
      screenshotPath: './screenshots/old.png', attachments: ['./screenshots/reference.png', './screenshots/shared.png'] },
    { id: 'old-two', ...taskData, comment: 'Keep this description', status: 'to do', timestamp: 2,
      screenshotPath: './screenshots/other.png', attachments: ['screenshots/shared.png'] }
  ];
  fs.writeFileSync(path.join(fixture.root, '.moat/moat-tasks-detail.json'), JSON.stringify(tasks));
  for (const name of ['old.png', 'reference.png', 'shared.png', 'other.png']) {
    fs.writeFileSync(path.join(fixture.root, '.moat/screenshots', name), 'image');
  }

  await store.loadTasksFromFile();
  await store.removeTaskAndSave('old-one');

  expect(JSON.parse(fixture.read('.moat/moat-tasks-detail.json')).map(task => task.id)).toEqual(['old-two']);
  expect(fixture.read('.moat/moat-tasks.md')).not.toContain('Remove this description');
  expect(fixture.read('.moat/moat-tasks.md')).toContain('Keep this description');
  expect(fixture.exists('.moat/screenshots/old.png')).toBe(false);
  expect(fixture.exists('.moat/screenshots/reference.png')).toBe(false);
  expect(fixture.exists('.moat/screenshots/shared.png')).toBe(true);
  expect(fixture.exists('.moat/screenshots/other.png')).toBe(true);
});

test('a failed legacy image deletion leaves the task available to retry', async () => {
  fs.mkdirSync(path.join(fixture.root, '.moat/screenshots'), { recursive: true });
  const tasks = [{ id: 'old', ...taskData, status: 'to do', timestamp: 1, screenshotPath: './screenshots/old.png' }];
  fs.writeFileSync(path.join(fixture.root, '.moat/moat-tasks-detail.json'), JSON.stringify(tasks));
  fs.writeFileSync(path.join(fixture.root, '.moat/screenshots/old.png'), 'image');
  await store.loadTasksFromFile();
  jest.spyOn(store.legacyStore.directoryHandle, 'getDirectoryHandle').mockResolvedValue({
    removeEntry: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});

  await expect(store.removeTaskAndSave('old')).rejects.toThrow('Permission denied');
  expect(store.tasks.map(task => task.id)).toEqual(['old']);
  expect(JSON.parse(fixture.read('.moat/moat-tasks-detail.json'))).toEqual(tasks);
  expect(fixture.exists('.moat/screenshots/old.png')).toBe(true);
});

test('a missing legacy screenshot does not prevent deleting its task', async () => {
  fs.mkdirSync(path.join(fixture.root, '.moat'), { recursive: true });
  const tasks = [{ id: 'old', ...taskData, status: 'to do', timestamp: 1, screenshotPath: './screenshots/missing.png' }];
  fs.writeFileSync(path.join(fixture.root, '.moat/moat-tasks-detail.json'), JSON.stringify(tasks));
  await store.loadTasksFromFile();
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  expect(await store.removeTaskAndSave('old')).toBe(true);
  expect(JSON.parse(fixture.read('.moat/moat-tasks-detail.json'))).toEqual([]);
  expect(store.tasks).toEqual([]);
});

test('deleting a legacy task rejects image paths outside the screenshots folder', async () => {
  fs.mkdirSync(path.join(fixture.root, '.moat/screenshots'), { recursive: true });
  const tasks = [{ id: 'old', ...taskData, status: 'to do', timestamp: 1, screenshotPath: './screenshots/../important.png' }];
  fs.writeFileSync(path.join(fixture.root, '.moat/moat-tasks-detail.json'), JSON.stringify(tasks));
  fs.writeFileSync(path.join(fixture.root, '.moat/important.png'), 'keep');
  await store.loadTasksFromFile();
  jest.spyOn(console, 'error').mockImplementation(() => {});

  await expect(store.removeTaskAndSave('old')).rejects.toThrow('Invalid screenshot path format');
  expect(fixture.read('.moat/important.png')).toBe('keep');
  expect(JSON.parse(fixture.read('.moat/moat-tasks-detail.json'))).toEqual(tasks);
});
