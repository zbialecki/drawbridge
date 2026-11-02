const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { sourceSection, deferred } = require('../helpers/test-utils');
const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');
let dom;
afterEach(() => dom?.window.close());

async function openEditor(mode) {
  dom = new JSDOM('<button id="target">Example</button>', { url: 'https://example.com/', pretendToBeVisual: true });
  const { window } = dom;
  const element = window.document.querySelector('#target');
  element.getBoundingClientRect = () => ({ x: 50, y: 50, width: 100, height: 30 });
  const context = vm.createContext({
    window, document: window.document, commentBox: null, screenBackdrop: null,
    screenCapturePending: false, annotationCapturePending: false, commentCaptureVersion: 0, isDrawing: false,
    commentMode: mode === 'comment', drawingMode: false, drawingCtx: null, drawingCanvas: null,
    drawingTool: null, drawingTools: {}, hoverOverlay: null, sessionId: 'test-session',
    deepSelectIndex: 0, pickStack: [], lastTopPickElement: null,
    setDeepSelectActive() {}, removeHighlight() {},
    captureScreenshotNative: jest.fn(async (viewport, padding) => ({ dataUrl: 'data:image/png;base64,eA==', viewport: { ...viewport, padding } })),
    enablePasteImages: box => { box.pastedImages = []; }, enableCommentBoxDrag: jest.fn(),
    captureFrameworkContext: async () => null,
    addToQueue: jest.fn(async () => {}), showNotification: jest.fn(), relayToSidePanel: jest.fn(),
    exitDrawingMode: jest.fn(), removeDrawingCanvas: jest.fn(),
    getSelector: () => '#target', validateSelector: () => true,
    getElementLabel: () => 'Button', getElementContext: () => ({}),
    setTimeout: callback => callback(), console: { log() {}, warn() {}, error() {} }
  });
  vm.runInContext(sourceSection(source, '  async function submitCommentAnnotation(', '  // Wire clipboard-image paste'), context);
  context.submitCommentAnnotation = jest.fn(context.submitCommentAnnotation);
  context.isUserAction = () => true;
  vm.runInContext(sourceSection(source, '  // Remove comment box', '  // Create canvas overlay for drawing'), context);
  if (mode === 'comment') {
    vm.runInContext(sourceSection(source, '  // Create comment input box', '  // Shake comment box'), context);
    await context.createCommentBox(element, 80, 80);
  } else if (mode === 'rectangle') {
    vm.runInContext(sourceSection(source, '  // Create comment box for freeform rectangle', '  // Global hover overlay element'), context);
    await context.createFreeformCommentBox({ x: 50, y: 50, width: 100, height: 30, type: 'freeform' }, 80, 80);
  } else {
    expect(await context.createScreenCommentBox()).toEqual({ success: true });
  }
  const textarea = context.commentBox.querySelector('textarea');
  const submit = context.commentBox.querySelector('.float-comment-submit');
  const key = name => textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  return { context, document: window.document, textarea, submit, key };
}

test.each(['comment', 'rectangle', 'screen'])('%s editor shows the updated prompt and submits with Return', async mode => {
  const { context, textarea, submit, key } = await openEditor(mode);
  expect(context.enableCommentBoxDrag).toHaveBeenCalledTimes(1);
  expect(textarea.placeholder).toBe('What needs to be changed? Markdown supported.');
  expect(submit.textContent).toBe('Submit ⏎');
  expect(submit.getAttribute('aria-label')).toBe('Submit (Return)');
  const checkbox = context.commentBox.querySelector('.float-comment-discussion');
  expect(checkbox.checked).toBe(false);
  expect(checkbox.closest('label').textContent).toContain('Needs Discussion');
  checkbox.checked = true;
  textarea.value = '**Make this clearer.**';
  key('Enter');
  expect(context.submitCommentAnnotation).toHaveBeenCalledTimes(1);
  expect(context.submitCommentAnnotation.mock.calls[0][1]).toMatchObject({
    content: '**Make this clearer.**', needsDiscussion: true
  });
  await context.submitCommentAnnotation.mock.results[0].value;

  // Page scripts can dispatch events on the editor, but those must not submit it.
  vm.runInContext(sourceSection(source, '  // Page scripts can dispatch events', '  // Keep the editor and its images'), context);
  context.submitCommentAnnotation.mockClear();
  key('Enter');
  submit.click();
  expect(context.submitCommentAnnotation).not.toHaveBeenCalled();
});

test.each(['comment', 'rectangle', 'screen'])('%s keeps its draft if Cancel or Escape is used during a failed save', async mode => {
  const { context, document, textarea, submit, key } = await openEditor(mode);
  const box = context.commentBox;
  const started = deferred();
  const saved = deferred();
  context.addToQueue.mockImplementationOnce(() => { started.resolve(); return saved.promise; });
  textarea.value = 'Keep this draft';
  box.querySelector('.float-comment-discussion').checked = true;
  box.pastedImages.push('data:image/png;base64,eA==');
  key('Enter');
  await started.promise;
  const pending = context.submitCommentAnnotation.mock.results[0].value;
  try {
    box.querySelector('.float-comment-cancel').click();
    key('Escape');
    expect(document.querySelector('.float-comment-box')).toBe(box);
  } finally {
    saved.reject(new Error('Write denied'));
    await pending;
  }
  expect(textarea.value).toBe('Keep this draft');
  expect(box.querySelector('.float-comment-discussion').checked).toBe(true);
  expect(box.pastedImages).toEqual(['data:image/png;base64,eA==']);
  expect(submit.disabled).toBe(false);
  key('Enter');
  expect(await context.submitCommentAnnotation.mock.results[1].value).toBe(true);
  expect(context.addToQueue.mock.calls[1][0].needsDiscussion).toBe(true);
  expect(document.querySelector('.float-comment-box')).toBeNull();
});

test.each(['textarea', '.float-comment-discussion', '.float-comment-cancel', '.float-comment-submit'])(
  'Escape closes the screen editor from %s even when the page stops key events', async selector => {
    const { context, document } = await openEditor('screen');
    const control = context.commentBox.querySelector(selector);
    document.body.addEventListener('keydown', event => event.stopPropagation());
    control.focus();
    control.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    expect(context.commentBox).not.toBeNull();
    control.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(context.commentBox).toBeNull();
    expect(document.querySelector('.float-screen-backdrop')).toBeNull();
    expect(context.addToQueue).not.toHaveBeenCalled();
  }
);

test('selectors uniquely identify elements with special IDs, duplicate attributes, and nested buttons', () => {
  dom = new JSDOM(`<div id=":r0:">React</div><main>
    <section><button data-testid="shared">A</button><div><button>B</button></div><button>C</button></section>
    <section><button data-testid="shared">D</button></section><input aria-label='Say "hello"'>
  </main>`);
  const { document } = dom.window;
  const context = vm.createContext({ document,
    CSS: { escape: value => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') }
  });
  vm.runInContext(sourceSection(source, '  // Get CSS selector for element', '  // Get enhanced element context'), context);
  for (const element of document.querySelectorAll('[id], button, input')) {
    const selector = context.getSelector(element);
    expect(selector).toEqual(expect.any(String));
    expect([...document.querySelectorAll(selector)]).toEqual([element]);
  }
});
