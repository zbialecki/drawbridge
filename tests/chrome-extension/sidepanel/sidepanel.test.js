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

test('only renders relayed task data for this panel tab and window, as text rather than HTML', async () => {
  const { context, read, document } = await setup();
  read('isConnected = true;');
  context.handleMessage({ type: 'TASKS_LOADED', sourceTabId: 2, sourceWindowId: 10, tasks: [{ id: 'wrong' }] });
  context.handleMessage({ type: 'TASKS_LOADED', sourceTabId: 1, sourceWindowId: 11, tasks: [{ id: 'wrong' }] });
  expect(read('tasks')).toHaveLength(0);
  const comment = '<img src=x onerror="alert(1)">';
  context.handleMessage({ type: 'TASKS_LOADED', sourceTabId: 1, sourceWindowId: 10,
    tasks: [{ id: 'right', comment, status: 'to do' }] });
  expect(read('tasks[0].id')).toBe('right');
  const content = document.querySelector('.task-content');
  expect(content.textContent).toBe(comment);
  expect(content.children).toHaveLength(0);
  expect(document.getElementById('todo-badge').textContent).toBe('1');
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
  const pending = context.sendToContentScript({ type: 'GET_CONNECTION_STATUS' });
  const reply = await sent.promise;
  read('tabEpoch++; activeTabId = 2; contentScriptReady = false;');
  reply({ connected: true, path: 'wrong project' });
  expect(await pending).toBeNull();
  expect(read('contentScriptReady')).toBe(false);
});

test('an old connection check cannot clear a newer tab connection', async () => {
  const { context, chrome, read } = await setup();
  const sent = deferred();
  chrome.tabs.sendMessage.mockImplementation((id, msg, callback) => sent.resolve(callback));
  const pending = context.checkConnectionStatus();
  const reply = await sent.promise;
  read('tabEpoch++; activeTabId = 2; isConnected = true; projectPath = "new project";');
  reply({ connected: false });
  await pending;
  expect(read('isConnected')).toBe(true);
  expect(read('projectPath')).toBe('new project');
});

test('does not route an action if the active tab changed during lookup', async () => {
  const { context, chrome, read } = await setup();
  const pending = context.sendToContentScript({ type: 'DELETE_TASK', taskId: 'old-task' });
  read('tabEpoch++; activeTabId = 2;');
  expect(await pending).toBeNull();
  expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
});

test('an annotation refresh does not reject when the tabs API disappears during tab lookup', async () => {
  const { context, chrome } = await setup();
  chrome.tabs.query.mockImplementation(async () => {
    delete chrome.tabs;
    return [{ id: 1, windowId: 10, url: 'https://example.com' }];
  });
  await expect(context.requestTasks()).resolves.toBeUndefined();
});

test('a page readiness check returns false if the tabs API disappears during lookup', async () => {
  const { context, chrome } = await setup();
  chrome.tabs.query.mockImplementation(async () => {
    delete chrome.tabs;
    return [{ id: 1, windowId: 10, url: 'https://example.com' }];
  });
  await expect(context.pingContentScript()).resolves.toBe(false);
});

test('a task refresh handles the extension runtime disappearing before the response', async () => {
  const { context, chrome } = await setup();
  const sent = deferred();
  chrome.tabs.sendMessage.mockImplementation((id, message, callback) => sent.resolve(callback));
  const refresh = context.requestTasks();
  const reply = await sent.promise;
  delete chrome.runtime;
  expect(() => reply({ success: true })).not.toThrow();
  await expect(refresh).resolves.toBeUndefined();
});

test('a synchronous messaging failure does not reject a task refresh or readiness check', async () => {
  const { context, chrome } = await setup();
  chrome.tabs.sendMessage.mockImplementation(() => { throw new Error('Extension context invalidated'); });
  await expect(context.requestTasks()).resolves.toBeUndefined();
  await expect(context.pingContentScript()).resolves.toBe(false);
});

async function setupDeleteAction(response, confirmed = true) {
  const { context, document, read } = await setup();
  context.confirm = jest.fn(() => confirmed);
  context.sendToContentScript = jest.fn(async () => response);
  context.showNotification = jest.fn();
  read('isConnected = true;');
  context.handleMessage({ type: 'TASKS_LOADED', sourceTabId: 1, sourceWindowId: 10,
    tasks: [{ id: 'task-1', comment: 'Delete this annotation', status: 'to do' }] });
  return { context, async click() {
    document.querySelector('.delete-btn').click();
    await new Promise(setImmediate);
  } };
}

test('deleting a task sends its ID after confirmation', async () => {
  const { context, click } = await setupDeleteAction({ success: true });
  await click();
  expect(context.confirm).toHaveBeenCalledTimes(1);
  expect(context.sendToContentScript).toHaveBeenCalledWith({ type: 'DELETE_TASK', taskId: 'task-1' }, false);
  expect(context.showNotification).not.toHaveBeenCalled();
});

test('canceling task deletion leaves the task unchanged', async () => {
  const { context, click } = await setupDeleteAction(null, false);
  await click();
  expect(context.sendToContentScript).not.toHaveBeenCalled();
});

test('a failed task deletion is reported to the user', async () => {
  const { context, click } = await setupDeleteAction({ success: false, error: 'Permission denied' });
  await click();
  expect(context.showNotification).toHaveBeenCalledWith('Could not delete task: Permission denied', 'error');
});

test('a disconnected page reports that deletion did not complete', async () => {
  const { context, click } = await setupDeleteAction(null);
  await click();
  expect(context.showNotification).toHaveBeenCalledWith('Could not delete task: Please refresh the page and try again.', 'error');
});
