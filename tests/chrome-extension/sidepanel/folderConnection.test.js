const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { directoryFixture } = require('../../helpers/directory-handle');
const { indexedDBFixture } = require('../../helpers/indexed-db');
const { AnnotationStore } = require('../../../chrome-extension/utils/annotationStore');
const { MoatPersistence } = require('../../../chrome-extension/utils/persistence');

const source = fs.readFileSync(require.resolve('../../../chrome-extension/sidepanel/sidepanel.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../../../chrome-extension/sidepanel/sidepanel.html'), 'utf8');
const ORIGIN = 'https://example.com';
const OTHER = 'https://staging.example.com';
const IMAGE = 'data:image/png;base64,eA==';
const doms = [];
let fixture;
let persistence;

beforeEach(() => {
  fixture = directoryFixture();
  fixture.directory.queryPermission = jest.fn(async () => 'granted');
  fixture.directory.requestPermission = jest.fn(async () => 'granted');
  global.indexedDB = indexedDBFixture().indexedDB;
  persistence = new MoatPersistence();
});
afterEach(() => {
  doms.splice(0).forEach(dom => dom.window.close());
  fixture.cleanup();
  delete global.indexedDB;
  jest.restoreAllMocks();
});

async function until(condition) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for: ${condition}`);
}

async function openPanel(url = `${ORIGIN}/settings`) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://extension.test/' });
  doms.push(dom);
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  const tab = { id: 1, windowId: 10, url };
  const panel = dom.getInternalVMContext();
  panel.console = { log() {}, warn() {}, error() {} };
  panel.chrome = {
    runtime: {
      id: 'drawbridge', onMessage: { addListener() {} }, getURL: path => `chrome-extension://drawbridge/${path}`,
      sendMessage: jest.fn(async () => {})
    },
    offscreen: { createDocument: jest.fn(async () => {}) },
    tabs: {
      query: async () => [tab],
      sendMessage: (id, message, callback) => callback({ ready: true }),
      connect: () => ({ disconnect() {} }),
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
  panel.moatPersistence = persistence;
  panel.DrawbridgeAnnotationStore = { AnnotationStore };
  panel.DrawbridgeProjectSetup = { installProjectFiles: jest.fn(async () => {}) };
  panel.showDirectoryPicker = jest.fn(async () => fixture.directory);
  panel.confirm = () => true;
  // jsdom's FileReader cannot read the Node files that the directory fixture returns.
  panel.FileReader = class {
    readAsDataURL(file) {
      file.arrayBuffer().then(bytes => {
        this.result = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
        this.onload();
      });
    }
  };
  vm.runInContext(source, panel);
  panel.setupEventListeners();
  await panel.handleTabChange();
  const document = dom.window.document;
  return {
    panel, document, tab,
    connected: () => document.getElementById('connection-banner').classList.contains('connected'),
    notices: () => [...document.querySelectorAll('.notification')].map(node => node.textContent),
    click: id => document.getElementById(id).click(),
    sender: (overrides = {}) => ({ id: 'drawbridge', frameId: 0, tab: { ...tab, ...overrides.tab }, ...overrides.sender }),
    request(message, sender) {
      return new Promise(resolve => {
        if (panel.handleMessage(message, sender, resolve) === false) resolve('ignored');
      });
    }
  };
}

const saveMessage = (id = 'one') => ({
  type: 'SAVE_ANNOTATION',
  annotation: { id, timestamp: new Date(2026, 10, 1, 15, 42).getTime(), content: 'Comment', screenshot: IMAGE, pageUrl: `${ORIGIN}/settings` },
  taskData: { title: 'Button', comment: 'Comment', selector: '#save' }
});

describe('connecting', () => {
  test('choosing a folder stores it for this site, installs commands, and confirms once', async () => {
    const view = await openPanel();
    expect(view.connected()).toBe(false);
    view.click('connect-btn');
    await until(view.connected);
    await until(() => view.notices().length);

    expect(view.panel.showDirectoryPicker).toHaveBeenCalledWith({ mode: 'readwrite', startIn: 'documents' });
    expect(view.panel.DrawbridgeProjectSetup.installProjectFiles).toHaveBeenCalledWith(fixture.directory);
    expect(view.notices()).toEqual(['Project connected']);
    expect(view.document.querySelector('.status-text').textContent).toBe(fixture.directory.name);
    expect(await persistence.getAllHandles()).toMatchObject([{ id: `project_${ORIGIN}`, origin: ORIGIN }]);
  });

  test('cancelling the picker leaves the site disconnected', async () => {
    const view = await openPanel();
    view.panel.showDirectoryPicker = jest.fn(async () => {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    });
    view.click('connect-btn');
    await until(() => view.notices().length);
    expect(view.connected()).toBe(false);
    expect(await persistence.getAllHandles()).toEqual([]);
  });

  test('a page with no site cannot connect', async () => {
    const view = await openPanel('chrome://extensions');
    view.click('connect-btn');
    await until(() => view.notices().length);
    expect(view.panel.showDirectoryPicker).not.toHaveBeenCalled();
  });

  test('a saved connection restores without any prompt and installs commands once per site', async () => {
    await persistence.persistProjectConnection(fixture.directory, 'project', ORIGIN);
    const view = await openPanel();
    expect(view.connected()).toBe(true);
    await view.panel.handleTabChange(); // A navigation in the same site.
    expect(view.connected()).toBe(true);
    expect(view.panel.DrawbridgeProjectSetup.installProjectFiles).toHaveBeenCalledTimes(1);
    expect(view.panel.showDirectoryPicker).not.toHaveBeenCalled();
    expect(fixture.directory.requestPermission).not.toHaveBeenCalled();
  });

  test('another site is not connected automatically, but can reuse the folder in one click', async () => {
    await persistence.persistProjectConnection(fixture.directory, 'project', OTHER);
    const view = await openPanel();
    const reuse = view.document.getElementById('reuse-btn');
    expect(view.connected()).toBe(false);
    expect(reuse.style.display).toBe('block');
    expect(reuse.textContent).toBe('Use project');
    expect(view.document.getElementById('connect-btn').style.display).toBe('none');
    expect(view.document.getElementById('choose-btn').style.display).toBe('flex');

    view.click('reuse-btn');
    await until(view.connected);
    await until(() => view.notices().length);

    expect(view.panel.showDirectoryPicker).not.toHaveBeenCalled();
    expect((await persistence.getAllHandles()).map(record => record.origin).sort()).toEqual([OTHER, ORIGIN].sort());
    expect(reuse.style.display).toBe('none');
  });

  test('the folder icon chooses a different folder instead of the offered one', async () => {
    await persistence.persistProjectConnection(fixture.directory, 'project', OTHER);
    const view = await openPanel();
    view.click('choose-btn');
    await until(view.connected);
    expect(view.panel.showDirectoryPicker).toHaveBeenCalledTimes(1);
    expect(view.document.getElementById('choose-btn').style.display).toBe('none');
  });

  test('a connected folder is held open for when the panel closes', async () => {
    const view = await openPanel();
    const { offscreen, runtime } = view.panel.chrome;
    expect(offscreen.createDocument).not.toHaveBeenCalled();
    view.click('connect-btn');
    await until(view.connected);
    await until(() => offscreen.createDocument.mock.calls.length);
    expect(offscreen.createDocument.mock.calls[0][0].url).toBe('chrome-extension://drawbridge/offscreen/folderAccess.html');
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    // Only one offscreen document can exist, so an open one is told to reload the folders.
    offscreen.createDocument.mockRejectedValue(new Error('Only a single offscreen document may be created.'));
    view.panel.holdFolderAccess();
    await until(() => runtime.sendMessage.mock.calls.length);
    expect(runtime.sendMessage).toHaveBeenCalledWith({ type: 'HOLD_FOLDERS' });
  });

  test('expired permission offers a reconnect and only prompts after the click', async () => {
    await persistence.persistProjectConnection(fixture.directory, 'project', ORIGIN);
    fixture.directory.queryPermission.mockResolvedValue('prompt');
    const view = await openPanel();
    expect(view.connected()).toBe(false);
    expect(view.document.getElementById('reuse-btn').textContent).toBe('Reconnect project');
    expect(fixture.directory.requestPermission).not.toHaveBeenCalled();

    view.click('reuse-btn');
    await until(view.connected);
    expect(fixture.directory.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  test('a declined permission prompt stays disconnected and reports it', async () => {
    await persistence.persistProjectConnection(fixture.directory, 'project', ORIGIN);
    fixture.directory.queryPermission.mockResolvedValue('prompt');
    fixture.directory.requestPermission.mockResolvedValue('denied');
    const view = await openPanel();
    view.click('reuse-btn');
    await until(() => view.notices().length);
    expect(view.connected()).toBe(false);
    expect(view.notices()[0]).toContain('Could not connect project');
  });

  test('disconnecting forgets only this site and keeps its annotations on disk', async () => {
    await persistence.persistProjectConnection(fixture.directory, 'project', ORIGIN);
    await persistence.persistProjectConnection(fixture.directory, 'project', OTHER);
    const view = await openPanel();
    const { folderName } = await view.request(saveMessage(), view.sender());
    view.document.querySelector('[data-action="disconnect"]').click();
    await until(() => !view.connected());
    await until(async () => (await persistence.getAllHandles()).length === 1);

    expect((await persistence.getAllHandles())[0].origin).toBe(OTHER);
    expect(fixture.exists(`${folderName}/metadata.json`)).toBe(true);
    expect(await view.request(saveMessage('two'), view.sender())).toMatchObject({ success: false });
  });
});

describe('saving from the page', () => {
  async function connected() {
    await persistence.persistProjectConnection(fixture.directory, 'project', ORIGIN);
    return openPanel();
  }

  test('writes a complete annotation and lists it', async () => {
    const view = await connected();
    const response = await view.request(saveMessage(), view.sender());
    expect(response).toEqual({ success: true, folderName: '26-11-01 15-42' });
    expect(JSON.parse(fixture.read('26-11-01 15-42/metadata.json'))).toMatchObject({ id: 'one', comment: 'Comment', pageUrl: `${ORIGIN}/settings` });
    expect(fixture.exists('26-11-01 15-42/screenshot.png')).toBe(true);
    await until(() => view.document.querySelector('.task-content'));
    expect(view.document.querySelector('.task-content').textContent).toBe('Comment');
    expect(view.notices()).toEqual(['Annotation saved']);
  });

  test.each([
    ['another tab', { tab: { id: 2 } }],
    ['another window', { tab: { windowId: 11 } }],
    ['another site in this tab', { tab: { url: `${OTHER}/settings` } }],
    ['an iframe', { sender: { frameId: 4 } }],
    ['another extension', { sender: { id: 'other-extension' } }],
    ['a sender with no tab', { sender: { tab: undefined } }]
  ])('ignores a save from %s', async (name, overrides) => {
    const view = await connected();
    expect(await view.request(saveMessage(), view.sender(overrides))).toBe('ignored');
    expect(fixture.exists('26-11-01 15-42')).toBe(false);
  });

  test('a site that has not connected a folder cannot save, even when another site has', async () => {
    await persistence.persistProjectConnection(fixture.directory, 'project', OTHER);
    const view = await openPanel();
    expect(await view.request(saveMessage(), view.sender())).toEqual({
      success: false, error: 'Connect a project in the Drawbridge side panel.'
    });
    expect(fixture.exists('26-11-01 15-42')).toBe(false);
  });

  test('a failed write returns the folder so that a retry reuses it', async () => {
    const view = await connected();
    fixture.state.failWrite = 'screenshot.png';
    const failed = await view.request(saveMessage(), view.sender());
    expect(failed).toMatchObject({ success: false, folderName: '26-11-01 15-42' });

    fixture.state.failWrite = null;
    const retry = saveMessage();
    retry.annotation.folderName = failed.folderName;
    expect(await view.request(retry, view.sender())).toEqual({ success: true, folderName: '26-11-01 15-42' });
    expect(fixture.exists('26-11-01 15-42_2')).toBe(false);
    expect(fixture.exists('26-11-01 15-42/screenshot.png')).toBe(true);
  });

  test('lists annotations for export', async () => {
    const view = await connected();
    await view.request(saveMessage(), view.sender());
    const { tasks } = await view.request({ type: 'LIST_ANNOTATIONS' }, view.sender());
    expect(tasks.map(task => task.id)).toEqual(['one']);
  });
});

describe('managing saved annotations', () => {
  async function withTasks(ids = ['one', 'two']) {
    await persistence.persistProjectConnection(fixture.directory, 'project', ORIGIN);
    const view = await openPanel();
    for (const [index, id] of ids.entries()) {
      const message = saveMessage(id);
      message.annotation.timestamp += index * 60000;
      await view.request(message, view.sender());
    }
    await view.panel.requestTasks();
    return view;
  }

  test('deleting a task removes its folder, not another task', async () => {
    const view = await withTasks();
    view.document.querySelector('.thumbnail-delete-btn').click();
    await until(() => view.document.querySelectorAll('.task-card').length === 1);
    expect(fixture.exists('26-11-01 15-42')).toBe(false);
    expect(JSON.parse(fixture.read('26-11-01 15-43/metadata.json')).id).toBe('two');
  });

  test('a failed deletion is reported and leaves the task', async () => {
    const view = await withTasks(['one']);
    fixture.directory.removeEntry = async () => { throw new Error('Permission denied'); };
    view.document.querySelector('.thumbnail-delete-btn').click();
    await until(() => view.notices().some(text => text.includes('Could not delete task: Permission denied')));
    expect(fixture.exists('26-11-01 15-42/metadata.json')).toBe(true);
  });

  test('loads thumbnails through the panel', async () => {
    const view = await withTasks(['one']);
    await until(() => view.document.querySelector('.thumbnail-img').getAttribute('src'));
    expect(view.document.querySelector('.thumbnail-img').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  test('metadata cannot inject markup into the panel', async () => {
    const hostile = '"><img src=x id=injected onerror="alert(1)"><div class="';
    const view = await withTasks([hostile]);
    expect(view.document.getElementById('injected')).toBeNull();
    expect(view.document.querySelector('.task-card').dataset.taskId).toBe(hostile);
    expect(view.document.querySelector('.thumbnail-container').dataset.taskId).toBe(hostile);
  });
});
