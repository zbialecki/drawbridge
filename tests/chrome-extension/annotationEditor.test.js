const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { sourceSection } = require('../helpers/test-utils');

const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');

test.each(['comment', 'rectangle', 'screen'])('%s editor shows the updated prompt and submits with Return', async mode => {
  const dom = new JSDOM('<button id="target">Example</button>', {
    url: 'https://example.com/', pretendToBeVisual: true
  });
  try {
    const { window } = dom;
    const element = window.document.querySelector('#target');
    element.getBoundingClientRect = () => ({ x: 50, y: 50, width: 100, height: 30 });
    const submitCommentAnnotation = jest.fn(async () => true);
    const context = vm.createContext({
      window, document: window.document, commentBox: null, screenBackdrop: null,
      screenCapturePending: false, annotationCapturePending: false, commentCaptureVersion: 0, isDrawing: false,
      commentMode: false, drawingMode: false, drawingCtx: null, drawingCanvas: null,
      drawingTool: null, drawingTools: {}, hoverOverlay: null, sessionId: 'test-session',
      captureScreenshotNative: jest.fn(async (viewport, padding) => ({
        dataUrl: 'data:image/png;base64,eA==', viewport: { ...viewport, padding }
      })),
      enablePasteImages: box => { box.pastedImages = []; },
      captureFrameworkContext: async () => null,
      isUserAction: () => true,
      submitCommentAnnotation, relayToSidePanel: jest.fn(),
      exitCommentMode: jest.fn(), exitDrawingMode: jest.fn(), removeDrawingCanvas: jest.fn(), removeCommentBox: jest.fn(),
      getSelector: () => '#target', validateSelector: () => true,
      getElementLabel: () => 'Button', getElementContext: () => ({}),
      setTimeout: callback => callback(), console: { log() {}, warn() {}, error() {} }
    });

    if (mode === 'comment') {
      vm.runInContext(sourceSection(source, '  // Create comment input box', '  // Shake comment box'), context);
      await context.createCommentBox(element, 80, 80);
    } else if (mode === 'rectangle') {
      vm.runInContext(sourceSection(source, '  // Create comment box for freeform rectangle', '  // Global hover overlay element'), context);
      await context.createFreeformCommentBox({ x: 50, y: 50, width: 100, height: 30, type: 'freeform' }, 80, 80);
    } else {
      vm.runInContext(sourceSection(source, '  function removeCommentBox()', '  // Enter comment mode'), context);
      expect(await context.createScreenCommentBox()).toEqual({ success: true });
    }

    const textarea = window.document.querySelector('.float-comment-input');
    const submit = window.document.querySelector('.float-comment-submit');
    expect(textarea.placeholder).toBe('What needs to be changed? Markdown supported.');
    expect(submit.textContent).toBe('Submit ⏎');
    expect(submit.getAttribute('aria-label')).toBe('Submit (Return)');
    textarea.value = '**Make this clearer.**';
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(submitCommentAnnotation).toHaveBeenCalledTimes(1);
    expect(submitCommentAnnotation.mock.calls[0][1].content).toBe('**Make this clearer.**');

    // Page scripts can dispatch events on the editor, but those must not submit it.
    vm.runInContext(sourceSection(source, '  // Page scripts can dispatch events', '  // Keep the editor and its images'), context);
    submitCommentAnnotation.mockClear();
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    submit.click();
    expect(submitCommentAnnotation).not.toHaveBeenCalled();
    await Promise.resolve();
  } finally {
    dom.window.close();
  }
});
