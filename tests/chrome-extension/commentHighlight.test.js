const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { sourceSection, deferred } = require('../helpers/test-utils');

const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');

test('dismissing a comment removes the highlight even after another page click', async () => {
  const dom = new JSDOM('<button id="first">First</button><button id="second">Second</button>', {
    url: 'https://example.com/', pretendToBeVisual: true
  });
  try {
    const { window } = dom;
    const first = window.document.querySelector('#first');
    const second = window.document.querySelector('#second');
    const picker = { pickElementAtPoint: x => ({
      element: x < 50 ? first : second, stack: [first, second], depth: 1, total: 2
    }) };
    const context = vm.createContext({
      window, document: window.document, commentMode: true, commentBox: null,
      screenBackdrop: null, screenCapturePending: false, annotationCapturePending: false,
      commentCaptureVersion: 0,
      hoverOverlay: null, highlightedElement: null, hoveredElement: null,
      deepSelectIndex: 0, pickStack: [], lastPointer: {}, lastTopPickElement: null,
      drilledOnPointerdown: false, getElementPicker: () => picker,
      isDeepSelectModifier: () => false, captureFrameworkContext: async () => null, captureScreenshotNative: jest.fn(async () => null),
      enablePasteImages: box => { box.pastedImages = []; },
      enableCommentBoxDrag() {},
      setTimeout: callback => callback(), console: { log() {}, warn() {}, info() {}, error() {} }
    });
    vm.runInContext(sourceSection(source, '  // Create comment input box', '  // Remove comment box'), context);
    vm.runInContext(sourceSection(source, '  // Remove comment box', '  // Create canvas overlay for drawing'), context);
    vm.runInContext(sourceSection(source, '  function setDeepSelectActive(', '  // Export annotations'), context);
    vm.runInContext(sourceSection(source, '  // Helper: does the event target sit inside', '  // macOS: Ctrl+Click is remapped'), context);

    first.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }));
    await new Promise(setImmediate);
    expect(window.document.querySelector('.float-comment-box')).not.toBeNull();
    expect(window.document.querySelectorAll('.float-hover-overlay')).toHaveLength(1);

    const originalOverlay = window.document.querySelector('.float-hover-overlay');
    second.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 20 }));
    expect(window.document.querySelector('.float-hover-overlay')).toBe(originalOverlay);
    window.document.querySelector('.float-comment-cancel').click();
    expect(window.document.querySelector('.float-comment-box')).toBeNull();
    expect(window.document.querySelectorAll('.float-hover-overlay')).toHaveLength(0);
  } finally {
    dom.window.close();
  }
});

test.each([
  ['comment', 'cancel'], ['comment', 'tab switch'], ['rectangle', 'tab switch']
])('%s capture cannot reopen its editor after a %s', async (mode, action) => {
  const dom = new JSDOM('<button>Example</button>', { url: 'https://example.com/', pretendToBeVisual: true });
  try {
    const { window } = dom;
    const element = window.document.querySelector('button');
    const overlay = window.document.createElement('div');
    overlay.className = mode === 'comment' ? 'float-hover-overlay' : 'float-drawing-canvas';
    window.document.body.appendChild(overlay);
    const capture = deferred();
    const started = deferred();
    const context = vm.createContext({
      window, document: window.document, commentMode: mode === 'comment', commentBox: null,
      screenBackdrop: null, screenCapturePending: false, annotationCapturePending: false,
      drawingCtx: null, drawingCanvas: mode === 'rectangle' ? overlay : null, drawingTool: null,
      removeDrawingHandlers: jest.fn(), updateCanvasSize: jest.fn(),
      commentCaptureVersion: 0, hoverOverlay: overlay, highlightedElement: element,
      deepSelectIndex: 0, pickStack: [], lastTopPickElement: null,
      setDeepSelectActive: jest.fn(), setControlKeyHeld: jest.fn(),
      captureFrameworkContext: async () => null,
      captureScreenshotNative: () => { started.resolve(); return capture.promise; },
      enablePasteImages: box => { box.pastedImages = []; },
      enableCommentBoxDrag() {},
      setTimeout: callback => callback(), console: { log() {}, warn() {}, error() {} }
    });
    vm.runInContext(sourceSection(source, '  // Create comment input box', '  // Remove comment box'), context);
    vm.runInContext(sourceSection(source, '  // Remove comment box', '  // Create canvas overlay for drawing'), context);
    vm.runInContext(sourceSection(source, '  // Highlight element on hover with DOM overlay', '  // Export annotations'), context);
    vm.runInContext(sourceSection(source, '  // Create comment box for freeform rectangle', '  // Global hover overlay element'), context);
    vm.runInContext(sourceSection(source, '  // Remove canvas overlay', '  // Enter drawing mode'), context);
    vm.runInContext(sourceSection(source, "  window.addEventListener('blur'", '  function setDeepSelectActive('), context);
    const opening = mode === 'comment' ? context.createCommentBox(element, 20, 20)
      : context.createFreeformCommentBox({ x: 20, y: 20, width: 40, height: 40 }, 20, 20);
    await started.promise;
    if (action === 'cancel') context.exitCommentMode();
    else {
      Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'hidden' });
      window.document.dispatchEvent(new window.Event('visibilitychange'));
      Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'visible' });
    }
    capture.resolve({ dataUrl: 'data:image/png;base64,eA==', viewport: {} });
    await opening;
    expect(window.document.querySelector('.float-comment-box')).toBeNull();
    if (action === 'cancel') expect(window.document.querySelector('.float-hover-overlay')).toBeNull();
    expect(window.document.querySelector('.float-drawing-canvas')).toBeNull();
    expect(context.annotationCapturePending).toBe(false);
  } finally {
    dom.window.close();
  }
});
