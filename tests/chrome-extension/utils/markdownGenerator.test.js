const { generateMarkdownFromTasks, writeMarkdownToFile } = require('../../../chrome-extension/utils/markdownGenerator');
const { directoryFixture } = require('../../helpers/directory-handle');
let fixture;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  delete global.window;
  jest.restoreAllMocks();
});

test('renders tasks and statistics in chronological order without mutating the queue', () => {
  const tasks = Object.freeze([
    { title: 'First Task', comment: '  First\ncomment  ', status: 'to do', timestamp: 2000 },
    { title: 'Second Task', comment: 'a'.repeat(100), status: 'done', timestamp: 3000 },
    { title: 'Third Task', comment: 'Third comment', status: 'doing', timestamp: 1000 }
  ]);
  const markdown = generateMarkdownFromTasks(tasks);
  for (const expected of ['# Moat Tasks', '**Total**: 3', '**To Do**: 1', '**Doing**: 1', '**Done**: 1',
    '1. [~] Third Task', '2. [ ] First Task', '3. [x] Second Task', '"First comment"', '"' + 'a'.repeat(57) + '..."']) {
    expect(markdown).toContain(expected);
  }
  expect(tasks.map(task => task.timestamp)).toEqual([2000, 3000, 1000]);
});

describe('Legacy checklist file writing', () => {
  let file;
  beforeEach(async () => {
    fixture = directoryFixture();
    file = await fixture.directory.getFileHandle('moat-tasks.md', { create: true });
    jest.spyOn(fixture.directory, 'getFileHandle').mockResolvedValue(file);
    global.window = { directoryHandle: fixture.directory };
  });

  test('writes only actual changes, including different text with the same byte length', async () => {
    const writer = jest.spyOn(file, 'createWritable');
    expect(await writeMarkdownToFile('# Café')).toBe(true);
    expect(fixture.read('moat-tasks.md')).toBe('# Café');
    await writeMarkdownToFile('# Café');
    expect(writer).toHaveBeenCalledTimes(1);
    await writeMarkdownToFile('# Other');
    expect(writer).toHaveBeenCalledTimes(2);
    expect(fixture.read('moat-tasks.md')).toBe('# Other');
    expect(fixture.directory.getFileHandle).toHaveBeenCalledWith('moat-tasks.md', { create: true });
  });

  test('falls back when the browser does not accept exclusive mode', async () => {
    const create = file.createWritable.bind(file);
    const writer = jest.spyOn(file, 'createWritable').mockImplementation(create)
      .mockRejectedValueOnce(new TypeError('Unsupported mode'));
    await writeMarkdownToFile('Comment');
    expect(writer.mock.calls).toEqual([
      [{ mode: 'exclusive', keepExistingData: false }], [{ keepExistingData: false }]
    ]);
    expect(fixture.read('moat-tasks.md')).toBe('Comment');
  });

  test('a failed write preserves the old file and releases its lock so a retry can succeed', async () => {
    await writeMarkdownToFile('Original');
    fixture.state.failWrite = 'moat-tasks.md';
    await expect(writeMarkdownToFile('Updated')).rejects.toThrow('Write denied');
    expect(fixture.read('moat-tasks.md')).toBe('Original');
    fixture.state.failWrite = null;
    expect(await writeMarkdownToFile('Updated')).toBe(true);
    expect(fixture.read('moat-tasks.md')).toBe('Updated');
  });
});
