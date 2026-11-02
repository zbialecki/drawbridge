const fs = require('node:fs');
const vm = require('node:vm');
const { sourceSection: section, deferred } = require('../helpers/test-utils');
const { AnnotationStore } = require('../../chrome-extension/utils/annotationStore');
const { directoryFixture } = require('../helpers/directory-handle');

const contentSource = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');
const panelSource = fs.readFileSync(require.resolve('../../chrome-extension/sidepanel/sidepanel.js'), 'utf8');
const image = 'data:image/png;base64,eA==';

function setupScreen() {
  const fixture = directoryFixture();
  const store = new AnnotationStore();
  store.initialize(fixture.directory);
  const documentListeners = {};
  const document = {
    hidden: false,
    title: 'Settings',
    querySelectorAll: () => [],
    addEventListener(type, listener) { documentListeners[type] = listener; },
    removeEventListener(type) { delete documentListeners[type]; }
  };
  class Element {
    constructor() {
      this.children = [];
      this.listeners = {};
      this.attributes = {};
      this.classList = { add() {}, remove() {} };
      this.value = '';
      this.disabled = false;
      this.isConnected = false;
    }
    set innerHTML(value) {
      this.html = value;
      this.fields = {
        textarea: new Element(),
        '.float-comment-attachments': new Element(),
        '.float-comment-submit': new Element(),
        '.float-comment-cancel': new Element()
      };
    }
    querySelector(selector) { return this.fields?.[selector] || null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    dispatch(type, event = {}) { return this.listeners[type]?.(event); }
    appendChild(child) { this.children.push(child); child.parent = this; child.isConnected = true; }
    replaceChildren() { this.children = []; }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.isConnected = false;
    }
    focus() { document.activeElement = this; }
  }
  document.createElement = () => new Element();
  document.body = new Element();
  document.body.isConnected = true;
  const previousFocus = new Element();
  previousFocus.isConnected = true;
  document.activeElement = previousFocus;
  const window = {
    innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 240,
    location: { href: 'https://example.com/settings' }
  };
  const context = vm.createContext({
    document, window, console: { error: jest.fn() }, Date, Math,
    commentBox: null, screenBackdrop: null, screenCapturePending: false, annotationCapturePending: false,
    drawingMode: false, commentMode: false, isDrawing: false, sessionId: 'session-1',
    setTimeout: callback => callback(),
    captureScreenshotNative: jest.fn(async (viewport, padding) => {
      expect(document.body.children).toHaveLength(0);
      return { dataUrl: image, viewport: { ...viewport, padding } };
    }),
    relayToSidePanel: jest.fn(), showNotification: jest.fn(),
    exitCommentMode: jest.fn(), exitDrawingMode: jest.fn(), removeDrawingCanvas: jest.fn(),
    shakeCommentBox: jest.fn(),
    FileReader: class {
      readAsDataURL(file) { this.result = file.dataUrl; this.onload(); }
    }
  });
  vm.runInContext(section(contentSource, '  function convertAnnotationToTask(', '  // Keep the editor and its images available'), context);
  vm.runInContext(section(contentSource, '  async function submitCommentAnnotation(', '  /**\n   * Capture screenshot'), context);
  vm.runInContext(section(contentSource, '  function removeCommentBox()', '  // Enter comment mode'), context);
  context.addToQueue = jest.fn(async annotation => store.saveAnnotation(annotation, context.convertAnnotationToTask(annotation)));
  return { context, document, documentListeners, previousFocus, fixture, store };
}

describe('screen feedback', () => {
  let setup;
  afterEach(() => setup?.fixture.cleanup());

  test('captures the viewport before the dialog and saves its description, screenshot, reference and page context', async () => {
    setup = setupScreen();
    const { context, document, fixture, store } = setup;
    expect(await context.createScreenCommentBox()).toEqual({ success: true });
    expect(context.captureScreenshotNative).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 }, 0);
    expect(document.body.children).toHaveLength(1);
    const box = context.commentBox;
    expect(box.attributes).toMatchObject({ role: 'dialog', 'aria-modal': 'true' });
    const textarea = box.querySelector('textarea');
    expect(document.activeElement).toBe(textarea);
    textarea.value = 'Make the spacing consistent.';
    textarea.dispatch('paste', {
      clipboardData: { items: [{ type: 'image/png', getAsFile: () => ({ dataUrl: image }) }] },
      preventDefault: jest.fn()
    });
    await box.querySelector('.float-comment-submit').dispatch('click');

    const saved = store.getAllTasks()[0];
    expect(saved).toMatchObject({ title: 'Screen', comment: 'Make the spacing consistent.', selector: null,
      selectorMethod: 'screen', pageUrl: 'https://example.com/settings', pageTitle: 'Settings',
      scrollPosition: { x: 0, y: 240 }, screenshotViewport: { x: 0, y: 0, width: 1200, height: 800, padding: 0 },
      boundingRect: { x: 0, y: 0, w: 1200, h: 800 } });
    expect(fixture.read(`${saved.folderName}/screenshot.png`)).toBe('x');
    expect(fixture.read(`${saved.folderName}/reference-1.png`)).toBe('x');
    expect(fixture.read(`${saved.folderName}/comment.md`)).toContain('Make the spacing consistent.');
    expect(JSON.parse(fixture.read(`${saved.folderName}/metadata.json`))).toMatchObject({ selectorMethod: 'screen', pageTitle: 'Settings' });
    expect(document.body.children).toHaveLength(0);
    expect(document.activeElement).toBe(setup.previousFocus);
    expect(context.relayToSidePanel).toHaveBeenLastCalledWith({ type: 'MODE_CHANGED', mode: null });
  });

  test('keeps the screen draft and images available when saving fails, then retries successfully', async () => {
    setup = setupScreen();
    const { context, fixture, store } = setup;
    await context.createScreenCommentBox();
    const box = context.commentBox;
    box.querySelector('textarea').value = 'Keep this draft';
    box.pastedImages.push(image);
    fixture.state.failWrite = 'screenshot.png';
    await box.querySelector('.float-comment-submit').dispatch('click');
    expect(context.commentBox).toBe(box);
    expect(box.pastedImages).toEqual([image]);
    expect(box.querySelector('.float-comment-submit').disabled).toBe(false);
    expect(context.showNotification).toHaveBeenCalledWith(expect.stringContaining('retry'), 'error');
    fixture.state.failWrite = null;
    await box.querySelector('.float-comment-submit').dispatch('click');
    expect(store.getAllTasks()).toHaveLength(1);
    expect(context.addToQueue.mock.calls[0][0].id).toBe(context.addToQueue.mock.calls[1][0].id);
    expect(context.commentBox).toBeNull();
  });

  test('uses the full native screenshot at high device pixel ratios', async () => {
    setup = setupScreen();
    const { context, document } = setup;
    const drawImage = jest.fn();
    const canvas = { getContext: () => ({ drawImage }), toDataURL: () => image };
    const createElement = document.createElement;
    document.createElement = type => type === 'canvas' ? canvas : createElement(type);
    context.window.devicePixelRatio = 2;
    context.chrome = { runtime: { sendMessage: (message, reply) => reply({ success: true, dataUrl: image }) } };
    context.Image = class {
      constructor() { this.width = 2400; this.height = 1600; }
      set src(value) { this.onload(); }
    };
    vm.runInContext(section(contentSource, '  async function captureScreenshotNative(', '  async function saveAnnotationWithNewSystem('), context);
    expect(await context.createScreenCommentBox()).toEqual({ success: true });
    expect(drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 2400, 1600, 0, 0, 2400, 1600);
    expect(canvas.width).toBe(2400);
    expect(canvas.height).toBe(1600);
  });

  test('hides extension notifications during capture and restores them afterward', async () => {
    setup = setupScreen();
    const notification = { style: { visibility: 'visible' } };
    setup.document.querySelectorAll = () => [notification];
    setup.context.captureScreenshotNative.mockImplementation(async viewport => {
      expect(notification.style.visibility).toBe('hidden');
      return { dataUrl: image, viewport };
    });
    await setup.context.createScreenCommentBox();
    expect(notification.style.visibility).toBe('visible');
  });

  test('reports a capture failure without opening an editor or saving a partial task', async () => {
    setup = setupScreen();
    setup.context.captureScreenshotNative.mockResolvedValue(null);
    expect(await setup.context.createScreenCommentBox()).toEqual({ success: false, error: expect.stringContaining('Could not capture') });
    expect(setup.document.body.children).toHaveLength(0);
    expect(setup.context.screenCapturePending).toBe(false);
    expect(setup.store.getAllTasks()).toHaveLength(0);
  });

  test('does not overwrite an existing annotation or launch two captures', async () => {
    setup = setupScreen();
    const started = deferred();
    const captured = deferred();
    setup.context.captureScreenshotNative.mockImplementation(() => { started.resolve(); return captured.promise; });
    const first = setup.context.createScreenCommentBox();
    await started.promise;
    expect(await setup.context.createScreenCommentBox()).toEqual({ success: false, error: expect.stringContaining('current capture') });
    captured.resolve({ dataUrl: image, viewport: { width: 1200, height: 800 } });
    await first;
    const box = setup.context.commentBox;
    box.querySelector('textarea').value = 'A draft';
    expect(await setup.context.createScreenCommentBox()).toEqual({ success: false, error: expect.stringContaining('current annotation') });
    expect(setup.context.commentBox).toBe(box);
    expect(box.querySelector('textarea').value).toBe('A draft');
    expect(setup.context.captureScreenshotNative).toHaveBeenCalledTimes(1);
  });

  test('waits for an element or rectangle capture rather than replacing its draft', async () => {
    setup = setupScreen();
    setup.context.annotationCapturePending = true;
    expect(await setup.context.createScreenCommentBox()).toEqual({ success: false, error: expect.stringContaining('current capture') });
    expect(setup.context.captureScreenshotNative).not.toHaveBeenCalled();
  });

  test('discards captures if the user switches tabs before capture completes', async () => {
    setup = setupScreen();
    const started = deferred();
    const captured = deferred();
    setup.context.captureScreenshotNative.mockImplementation(() => { started.resolve(); return captured.promise; });
    const pending = setup.context.createScreenCommentBox();
    await started.promise;
    setup.document.hidden = true;
    setup.documentListeners.visibilitychange();
    setup.document.hidden = false;
    captured.resolve({ dataUrl: image, viewport: { width: 1200, height: 800 } });
    expect(await pending).toEqual({ success: false, error: expect.stringContaining('page changed') });
    expect(setup.context.commentBox).toBeNull();
    expect(setup.document.body.children).toHaveLength(0);
    expect(setup.documentListeners.visibilitychange).toBeUndefined();
  });

  test('does not capture another tab if the page is hidden before the screenshot starts', async () => {
    setup = setupScreen();
    const pending = setup.context.createScreenCommentBox();
    setup.document.hidden = true;
    setup.documentListeners.visibilitychange();
    expect(await pending).toEqual({ success: false, error: expect.stringContaining('page changed') });
    expect(setup.context.captureScreenshotNative).not.toHaveBeenCalled();
  });

  test('cancel closes the dialog and restores focus without saving', async () => {
    setup = setupScreen();
    await setup.context.createScreenCommentBox();
    setup.context.commentBox.querySelector('.float-comment-cancel').dispatch('click');
    expect(setup.context.commentBox).toBeNull();
    expect(setup.document.activeElement).toBe(setup.previousFocus);
    expect(setup.store.getAllTasks()).toHaveLength(0);
  });

  test('Escape closes the dialog and Tab wraps through its controls', async () => {
    setup = setupScreen();
    await setup.context.createScreenCommentBox();
    const box = setup.context.commentBox;
    const textarea = box.querySelector('textarea');
    const submit = box.querySelector('.float-comment-submit');
    const key = { key: 'Tab', shiftKey: true, preventDefault: jest.fn() };
    box.dispatch('keydown', key);
    expect(key.preventDefault).toHaveBeenCalled();
    expect(setup.document.activeElement).toBe(submit);
    textarea.dispatch('keydown', { key: 'Escape', preventDefault: jest.fn(), stopPropagation: jest.fn() });
    expect(setup.context.commentBox).toBeNull();
    expect(setup.document.activeElement).toBe(setup.previousFocus);
  });

  test('the panel message opens the same screen capture flow', async () => {
    setup = setupScreen();
    let listener;
    setup.context.chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } } } };
    vm.runInContext(section(contentSource, '  chrome.runtime.onMessage.addListener(', '  // Helper to relay messages'), setup.context);
    const result = new Promise(resolve => {
      expect(listener({ type: 'CAPTURE_SCREEN' }, {}, resolve)).toBe(true);
    });
    expect(await result).toEqual({ success: true });
    expect(setup.context.captureScreenshotNative).toHaveBeenCalledTimes(1);
  });
});

function setupPageShortcut() {
  let keydown;
  const document = { hidden: false, addEventListener(type, listener) { if (type === 'keydown') keydown = listener; } };
  const context = vm.createContext({ document, window: {},
    screenBackdrop: null, drawingMode: false, commentMode: false, commentBox: null,
    sidePanelConnections: 1, isDrawing: false, screenCapturePending: false, annotationCapturePending: false,
    createScreenCommentBox: jest.fn(async () => ({ success: true })),
    showNotification: jest.fn(), setTimeout: jest.fn(), clearTimeout: jest.fn() });
  vm.runInContext(section(contentSource, '  // Listen for keyboard events', '  // Initialize Moat extension on page load'), context);
  const event = (overrides = {}) => ({ key: 's', target: { matches: () => false, closest: () => null },
    preventDefault: jest.fn(), ...overrides });
  return { context, document, keydown, event };
}

test('S captures from the page while its side panel is open', () => {
  const { context, keydown, event } = setupPageShortcut();
  const key = event();
  keydown(key);
  expect(key.preventDefault).toHaveBeenCalled();
  expect(context.createScreenCommentBox).toHaveBeenCalledTimes(1);
});

test.each([
  { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true },
  { isComposing: true }, { keyCode: 229 },
  { target: { matches: selector => selector.includes('input'), closest: () => null } },
  { target: { matches: () => false, isContentEditable: true, closest: () => ({}) } },
  { target: { matches: () => false, closest: () => ({}) } },
  { target: { matches: selector => selector === 'select', closest: () => null } }
])('S does not capture while typing or using a modified shortcut: %p', overrides => {
  const { context, keydown, event } = setupPageShortcut();
  const key = event(overrides);
  keydown(key);
  expect(key.preventDefault).not.toHaveBeenCalled();
  expect(context.createScreenCommentBox).not.toHaveBeenCalled();
});

test.each(['hidden', 'closed', 'draft', 'pending', 'annotation pending'])('S is ignored when the page is %s', state => {
  const { context, document, keydown, event } = setupPageShortcut();
  if (state === 'hidden') document.hidden = true;
  if (state === 'closed') context.sidePanelConnections = 0;
  if (state === 'draft') context.commentBox = {};
  if (state === 'pending') context.screenCapturePending = true;
  if (state === 'annotation pending') context.annotationCapturePending = true;
  keydown(event());
  expect(context.createScreenCommentBox).not.toHaveBeenCalled();
});

function setupPanel() {
  const listeners = {};
  const screenItem = { dataset: { action: 'screen' }, addEventListener(type, fn) { this[type] = fn; },
    classList: { toggle() {} } };
  const node = { querySelector() { return this; }, querySelectorAll: () => [], addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} }, style: {}, dataset: {} };
  const menu = { ...node, querySelectorAll: () => [screenItem] };
  const document = { hidden: false, getElementById: id => id === 'tools-menu' ? menu : node,
    querySelectorAll: () => [], addEventListener(type, fn) { listeners[type] = fn; } };
  const chrome = { runtime: { onMessage: { addListener() {} } }, tabs: {} };
  const context = vm.createContext({ document, chrome, console, Map, Date, setTimeout });
  vm.runInContext(`'use strict';\n${panelSource}`, context);
  vm.runInContext('contentScriptReady = true; activeTabId = 1; panelWindowId = 10;', context);
  context.sendToContentScript = jest.fn(async () => ({ success: true }));
  context.showNotification = jest.fn();
  context.setupEventListeners();
  return { context, listeners, screenItem };
}

test('the Screen menu option routes a capture request to the active page', async () => {
  const { context, screenItem } = setupPanel();
  await screenItem.click();
  expect(context.sendToContentScript).toHaveBeenCalledWith({ type: 'CAPTURE_SCREEN' }, false);
});

test('a failed panel capture shows the reason', async () => {
  const { context, screenItem } = setupPanel();
  context.sendToContentScript.mockResolvedValue({ success: false, error: 'Try again.' });
  await screenItem.click();
  expect(context.showNotification).toHaveBeenCalledWith('Try again.', 'error');
});

test('S also works with focus in the side panel, but not in an input', async () => {
  const { context, listeners } = setupPanel();
  const event = { key: 's', preventDefault: jest.fn(), target: { matches: () => false, closest: () => null } };
  listeners.keydown(event);
  await Promise.resolve();
  expect(event.preventDefault).toHaveBeenCalled();
  expect(context.sendToContentScript).toHaveBeenCalledWith({ type: 'CAPTURE_SCREEN' }, false);
  context.sendToContentScript.mockClear();
  listeners.keydown({ ...event, target: { matches: () => true, closest: () => null } });
  expect(context.sendToContentScript).not.toHaveBeenCalled();
});
