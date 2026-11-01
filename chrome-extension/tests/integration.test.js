// Integration tests for the supported legacy .moat JSON and Markdown format.
// These use an in-memory File System Access API mock, not a real browser.

const { TaskStore } = require('../utils/taskStore');
const MarkdownGenerator = require('../utils/markdownGenerator');

if (!global.window) {
  global.window = {};
}

if (!global.document) {
  global.document = {
    body: {
      classList: {
        add: () => {},
        remove: () => {}
      }
    }
  };
}

// --- Mock Helpers -----------------------------------------------------------
class MockFileHandle {
  constructor(name, content = '') {
    this.name = name;
    this.content = content;
  }
  async getFile() {
    return { text: async () => this.content };
  }
  async createWritable() {
    return {
      write: async (data) => {
        this.content = typeof data === 'string' ? data : JSON.stringify(data);
      },
      close: async () => true
    };
  }
}

class MockDirectoryHandle {
  constructor(initial = {}, name = 'root', parent = null) {
    this.name = name;
    this.parent = parent;
    this.files = new Map();
    this.directories = new Map();
    Object.entries(initial).forEach(([fileName, content]) => {
      this.files.set(fileName, new MockFileHandle(fileName, content));
    });
  }

  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name)) {
      if (!create) throw new Error(`File not found: ${name}`);
      this.files.set(name, new MockFileHandle(name, ''));
    }
    return this.files.get(name);
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    if (name === '.' || name === './') {
      return this;
    }

    if (name === '..') {
      if (!this.parent) throw new Error('No parent directory');
      return this.parent;
    }

    if (name === '.moat' && !this.directories.has(name) && !create) {
      return this;
    }

    if (!this.directories.has(name)) {
      if (!create) throw new Error(`Directory not found: ${name}`);
      const subDir = new MockDirectoryHandle({}, name, this);
      this.directories.set(name, subDir);
      return subDir;
    }

    return this.directories.get(name);
  }

  async removeEntry(name) {
    this.files.delete(name);
    this.directories.delete(name);
  }

  listFiles() {
    return [...this.files.keys()];
  }
}

// Utility to generate mock annotations
function createMockAnnotation(index = 0) {
  return {
    content: `Test annotation ${index}`,
    target: `.element-${index}`,
    elementLabel: `Element ${index}`,
    boundingRect: { x: 0, y: 0, width: 100, height: 20 },
    screenshot: null,
    status: 'to do',
    timestamp: Date.now() + index * 1000
  };
}

// ---------------------------------------------------------------------------
describe('Legacy task JSON and Markdown integration', () => {
  let rootDir;
  let moatDir;
  let taskStore;
  let markdownGen;
  
  beforeEach(async () => {
    // Fresh mock directory for each test
    rootDir = new MockDirectoryHandle();
    moatDir = await rootDir.getDirectoryHandle('.moat', { create: true });
    taskStore = new TaskStore();
    taskStore.initialize(moatDir);
    markdownGen = MarkdownGenerator;
    // The Markdown generator reads the connected directory from window.
    global.window.taskStore = taskStore;
    global.window.markdownGenerator = markdownGen;
    global.window.directoryHandle = moatDir;
    global.window.MoatTaskStore = { TaskStore };
    global.window.MoatMarkdownGenerator = markdownGen;
    global.window.showDirectoryPicker = async () => moatDir;
    global.chrome = {
      runtime: {
        onMessage: {
          addListener: () => {}
        }
      }
    };
  });

  function createTaskData({
    title,
    comment,
    selector,
    boundingRect = { x: 0, y: 0, w: 0, h: 0 },
    screenshotPath = ''
  }) {
    return {
      title,
      comment,
      selector,
      boundingRect,
      screenshotPath
    };
  }

  test('saves task data and generates the legacy checklist', async () => {
    const annotation = createMockAnnotation(1);

    // Convert the captured data into the legacy task format.
    const taskData = createTaskData({
      title: annotation.elementLabel,
      comment: annotation.content,
      selector: annotation.target,
      boundingRect: {
        x: annotation.boundingRect.x,
        y: annotation.boundingRect.y,
        w: annotation.boundingRect.width,
        h: annotation.boundingRect.height
      }
    });

    await taskStore.addTaskAndSave(taskData);
    await markdownGen.rebuildMarkdownFile(taskStore.getAllTasksChronological());

    // Verify JSON file creation
    const detailHandle = await moatDir.getFileHandle('moat-tasks-detail.json');
    expect(detailHandle).toBeDefined();
    const detailContent = await detailHandle.getFile().then(f => f.text());
    expect(JSON.parse(detailContent)).toHaveLength(1);

    // Verify markdown generation
    const mdHandle = await moatDir.getFileHandle('moat-tasks.md');
    expect(mdHandle).toBeDefined();
    const mdContent = await mdHandle.getFile().then(f => f.text());
    expect(mdContent).toContain('Test annotation');
  });

  test('regenerates the checklist after adding a legacy task', async () => {
    // Pre-populate with two tasks
    for (let i = 0; i < 2; i++) {
      await taskStore.addTaskAndSave(createTaskData({
        title: `Title ${i}`,
        comment: `Comment ${i}`,
        selector: `.item-${i}`
      }));
    }
    // First markdown build
    await markdownGen.rebuildMarkdownFile(taskStore.getAllTasksChronological());
    const mdHandle1 = await moatDir.getFileHandle('moat-tasks.md');
    const size1 = (await mdHandle1.getFile().then(f => f.text())).length;

    // Add a task, then rebuild the checklist.
    const newTask = await taskStore.addTaskAndSave(createTaskData({
      title: 'New Task',
      comment: 'New Task Comment',
      selector: '.item-99'
    }));
    await markdownGen.rebuildMarkdownFile(taskStore.getAllTasksChronological());

    const mdHandle2 = await moatDir.getFileHandle('moat-tasks.md');
    const contentAfter = await mdHandle2.getFile().then(f => f.text());
    expect(contentAfter.length).toBeGreaterThan(size1);
    expect(contentAfter).toContain(newTask.title);
  });

  test('keeps JSON status and the checklist checkbox in sync', async () => {
    // Add a task
    const task = await taskStore.addTaskAndSave(createTaskData({
      title: 'Toggle Test',
      comment: 'Toggle Comment',
      selector: '.toggle-item'
    }));
    await markdownGen.rebuildMarkdownFile(taskStore.getAllTasksChronological());

    // Update status to completed
    await taskStore.updateTaskStatusAndSave(task.id, 'done');
    await markdownGen.rebuildMarkdownFile(taskStore.getAllTasksChronological());

    // Validate JSON reflects change
    const detailContent = await (await moatDir.getFileHandle('moat-tasks-detail.json')).getFile().then(f => f.text());
    const tasksArr = JSON.parse(detailContent);
    expect(tasksArr.find(t => t.id === task.id).status).toBe('done');

    // Validate markdown reflects change (looks for [x])
    const mdContent = await (await moatDir.getFileHandle('moat-tasks.md')).getFile().then(f => f.text());
    expect(mdContent).toMatch(/\[x\].*Toggle Test/);
  });

  test('updates the screenshot path when a new image is provided', async () => {
    const baseTask = await taskStore.addTaskAndSave(createTaskData({
      title: 'Screenshot Task',
      comment: 'Needs screenshot',
      selector: '.screenshot-task'
    }));

    expect(baseTask.screenshotPath).toBe('');

    const updatedTask = await taskStore.addTaskAndSave({
      ...createTaskData({
        title: 'Screenshot Task',
        comment: 'Needs screenshot',
        selector: '.screenshot-task',
        screenshotPath: './screenshots/test.png'
      }),
      id: baseTask.id
    });

    expect(updatedTask.screenshotPath).toBe('./screenshots/test.png');
  });

  test('generates a checklist for 1,000 legacy tasks', () => {
    const bigTasks = [];
    for (let i = 0; i < 1000; i++) {
      bigTasks.push({
        id: `task-${i}`,
        title: `Task ${i}`,
        comment: `Task ${i} comment`,
        selector: `.task-${i}`,
        status: 'to do',
        timestamp: Date.now()
      });
    }
    const markdown = markdownGen.rebuildMarkdownFromJson(bigTasks);
    expect(markdown).toContain('**Total**: 1000');
    expect(markdown).toContain('Task 0');
    expect(markdown).toContain('Task 999');
  });

  test('generates identical Markdown for unchanged tasks at the same time', async () => {
    const formatDate = jest.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('fixed time');
    try {
      const tasksArr = [{
        id: 't1',
        title: 'Same Task',
        comment: 'Same Task comment',
        selector: '.same-task',
        status: 'to do',
        timestamp: Date.now()
      }];
      await markdownGen.rebuildMarkdownFile(tasksArr);
      const md1 = await (await moatDir.getFileHandle('moat-tasks.md')).getFile().then(f => f.text());
      await markdownGen.rebuildMarkdownFile(tasksArr);
      const md2 = await (await moatDir.getFileHandle('moat-tasks.md')).getFile().then(f => f.text());
      expect(md1).toBe(md2);
    } finally {
      formatDate.mockRestore();
    }
  });
});
