const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { deferred } = require('../../helpers/test-utils');
const sourcePath = require.resolve('../../../chrome-extension/sidepanel/sidepanel.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const html = fs.readFileSync(require.resolve('../../../chrome-extension/sidepanel/sidepanel.html'), 'utf8');
let dom;

async function setup() {
  dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://extension.test/' });
  // These tests drive the panel explicitly, after the document's initial load.
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  const chrome = { tabs: {
    query: jest.fn(async () => [{ id: 1, windowId: 10, url: 'https://example.com' }]), sendMessage: jest.fn()
  }, runtime: {} };
  const context = dom.getInternalVMContext();
  context.chrome = chrome;
  vm.runInContext(`'use strict';\n${source}`, context, { filename: sourcePath });
  vm.runInContext('activeTabId = 1; panelWindowId = 10;', context);
  return { context, chrome, document: dom.window.document,
    read: expression => vm.runInContext(expression, context) };
}
afterEach(() => { dom?.window.close(); dom = null; });

test('Add is enabled only while a project folder is connected', async () => {
  const { context, document, read } = await setup();
  const button = document.getElementById('tools-btn');
  const menu = document.getElementById('tools-menu');
  expect(button.disabled).toBe(true);

  context.chrome.runtime.onMessage = { addListener: jest.fn() };
  context.window.DrawbridgeAnnotationStore = { AnnotationStore: class { initialize() {} } };
  context.window.moatPersistence = { removeProjectConnection: jest.fn(async () => {}) };
  context.holdFolderAccess = jest.fn();
  context.requestTasks = jest.fn(async () => {});
  context.restoreFolder = jest.fn(async () => {});
  context.setupEventListeners();
  button.click();
  expect(menu.classList.contains('hidden')).toBe(true);

  await context.openFolder({}, 'Feedback', read('tabEpoch'));
  expect(button.disabled).toBe(false);
  button.click();
  expect(menu.classList.contains('hidden')).toBe(false);

  document.querySelector('[data-action="disconnect"]').click();
  await new Promise(setImmediate);
  expect(button.disabled).toBe(true);
  expect(menu.classList.contains('hidden')).toBe(true);
});

test('renders task data as text rather than HTML', async () => {
  const { read, context, document } = await setup();
  const comment = '<img src=x onerror="alert(1)">';
  context.__tasks = [{ id: 'right', comment, status: 'to do' }];
  read('isConnected = true; tasks = globalThis.__tasks; renderTasks(); updateBadges();');
  const content = document.querySelector('.task-content');
  expect(content.textContent).toBe(comment);
  expect(content.children).toHaveLength(0);
  expect(document.getElementById('todo-badge').textContent).toBe('1');
});

test('only truncated annotations can be expanded, and the control responds to resizing', async () => {
  const { context, document, read } = await setup();
  context.__tasks = [
    { id: 'long', comment: 'A long annotation\nwith multiple lines of feedback.', selector: 'main > button' },
    { id: 'short', comment: 'Short annotation' },
    { id: 'no-selector', comment: 'A long annotation without a selector.' }
  ];
  read('isConnected = true; tasks = globalThis.__tasks; renderTasks();');
  const [longCard, shortCard, noSelectorCard] = document.querySelectorAll('.task-card');
  const content = longCard.querySelector('.task-content');
  const button = longCard.querySelector('.task-expand');
  const noSelectorContent = noSelectorCard.querySelector('.task-content');
  Object.defineProperty(noSelectorContent, 'clientHeight', { get: () => 40 });
  Object.defineProperty(noSelectorContent, 'scrollHeight', { get: () => 80 });
  let overflow = true;
  Object.defineProperty(content, 'clientHeight', { get: () => 40 });
  Object.defineProperty(content, 'scrollHeight', { get: () => overflow ? 80 : 40 });
  context.updateTaskTextOverflowAll();
  expect(button.hidden).toBe(false);
  expect(shortCard.querySelector('.task-expand').hidden).toBe(true);
  expect(noSelectorCard.querySelector('.task-selector')).toBeNull();
  expect(noSelectorCard.querySelector('.task-expand').hidden).toBe(false);
  expect(button.getAttribute('aria-controls')).toBe(content.id);
  expect(button.getAttribute('aria-expanded')).toBe('false');

  button.click();
  expect(content.classList.contains('expanded')).toBe(true);
  expect(button.textContent).toBe('Hide');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  overflow = false;
  context.updateTaskTextOverflowAll();
  expect(button.hidden).toBe(false);

  button.click();
  expect(content.classList.contains('expanded')).toBe(false);
  expect(button.textContent).toBe('Expand');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(button.hidden).toBe(true);
  overflow = true;
  context.updateTaskTextOverflowAll();
  expect(button.hidden).toBe(false);
});

test('shows the page path or host before the relative time, with safe fallbacks', async () => {
  const { read, context, document } = await setup();
  const timestamp = Date.now();
  context.__tasks = [
    { id: 'path', pageUrl: 'http://localhost:3000/projects/47?secret=1#section', timestamp, status: 'to do' },
    { id: 'root', pageUrl: 'https://example.com/', timestamp, status: 'to do' },
    { id: 'missing', timestamp, status: 'to do' },
    { id: 'invalid', pageUrl: 'not a url', pageTitle: '<img src=x onerror=alert(1)>', timestamp, status: 'to do' }
  ];
  read('isConnected = true; tasks = globalThis.__tasks; renderTasks();');
  const headers = [...document.querySelectorAll('.task-time')];
  expect(headers.map(header => header.textContent)).toEqual([
    '/projects/47 · Just now', 'example.com · Just now', 'Just now', '<img src=x onerror=alert(1)> · Just now'
  ]);
  expect(headers[3].querySelector('img')).toBeNull();
});

test('page messages cannot change the connection or the task list', async () => {
  const { context, read } = await setup();
  const relayed = { sourceTabId: 1, sourceWindowId: 10 };
  context.handleMessage({ type: 'PROJECT_CONNECTED', path: 'forged', ...relayed });
  context.handleMessage({ type: 'TASKS_LOADED', tasks: [{ id: 'forged' }], ...relayed });
  expect(read('isConnected')).toBe(false);
  expect(read('tasks')).toHaveLength(0);
});

test('shows a content-script error in the sidebar for the active tab only', async () => {
  const { context, document } = await setup();
  context.handleMessage({ type: 'SHOW_NOTIFICATION', message: 'Could not save annotation', notificationType: 'error', sourceTabId: 2, sourceWindowId: 10 });
  expect(document.querySelectorAll('.notification')).toHaveLength(0);
  context.handleMessage({ type: 'SHOW_NOTIFICATION', message: 'Could not save annotation', notificationType: 'error', sourceTabId: 1, sourceWindowId: 10 });
  expect(document.querySelectorAll('.notification')).toHaveLength(1);
  expect(document.querySelector('.notification.error').textContent).toBe('Could not save annotation');
});

test('drops a delayed response after a tab switch', async () => {
  const { context, chrome, read } = await setup();
  const sent = deferred();
  chrome.tabs.sendMessage.mockImplementation((id, msg, callback) => sent.resolve(callback));
  const pending = context.sendToContentScript({ type: 'ENTER_COMMENT_MODE' });
  const reply = await sent.promise;
  read('tabEpoch++; activeTabId = 2; contentScriptReady = false;');
  reply({ success: true });
  expect(await pending).toBeNull();
  expect(read('contentScriptReady')).toBe(false);
});

test('does not route an action if the active tab changed during lookup', async () => {
  const { context, chrome, read } = await setup();
  const pending = context.sendToContentScript({ type: 'CAPTURE_SCREEN' });
  read('tabEpoch++; activeTabId = 2;');
  expect(await pending).toBeNull();
  expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
});

test('a page readiness check returns false if the tabs API disappears during lookup', async () => {
  const { context, chrome } = await setup();
  chrome.tabs.query.mockImplementation(async () => {
    delete chrome.tabs;
    return [{ id: 1, windowId: 10, url: 'https://example.com' }];
  });
  await expect(context.pingContentScript()).resolves.toBe(false);
});

test('a synchronous messaging failure does not reject a page message or readiness check', async () => {
  const { context, chrome } = await setup();
  chrome.tabs.sendMessage.mockImplementation(() => { throw new Error('Extension context invalidated'); });
  await expect(context.sendToContentScript({ type: 'CAPTURE_SCREEN' })).resolves.toBeNull();
  await expect(context.pingContentScript()).resolves.toBe(false);
});

async function setupDeleteAction(removeTask, confirmed = true) {
  const { context, document, read } = await setup();
  context.confirm = jest.fn(() => confirmed);
  context.showNotification = jest.fn();
  context.__store = { removeTaskAndSave: jest.fn(removeTask), loadTasksFromFile: jest.fn(async () => []) };
  context.__tasks = [{ id: 'task-1', comment: 'Delete this annotation', status: 'to do' }];
  read('isConnected = true; annotationStore = globalThis.__store; tasks = globalThis.__tasks; renderTasks();');
  return { context, store: context.__store, async click() {
    document.querySelector('.delete-btn').click();
    await new Promise(setImmediate);
  } };
}

test('deleting a task uses its ID after confirmation', async () => {
  const { context, store, click } = await setupDeleteAction(async () => true);
  await click();
  expect(context.confirm).toHaveBeenCalledTimes(1);
  expect(store.removeTaskAndSave).toHaveBeenCalledWith('task-1');
  expect(context.showNotification).not.toHaveBeenCalled();
});

test('canceling task deletion leaves the task unchanged', async () => {
  const { store, click } = await setupDeleteAction(async () => true, false);
  await click();
  expect(store.removeTaskAndSave).not.toHaveBeenCalled();
});

test('a failed task deletion is reported to the user', async () => {
  const { context, click } = await setupDeleteAction(async () => { throw new Error('Permission denied'); });
  await click();
  expect(context.showNotification).toHaveBeenCalledWith('Could not delete task: Permission denied', 'error');
});

test('deleting a task that no longer exists reports it', async () => {
  const { context, click } = await setupDeleteAction(async () => false);
  await click();
  expect(context.showNotification).toHaveBeenCalledWith('Could not delete task: Task not found. Refresh and try again.', 'error');
});
