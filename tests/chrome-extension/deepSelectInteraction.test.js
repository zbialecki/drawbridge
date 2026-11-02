const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { sourceSection } = require('../helpers/test-utils');
const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');
function setup() {
  let click;
  const context = vm.createContext({ document: { addEventListener(type, fn) { click = fn; } },
    commentMode: true, commentBox: null, annotationCapturePending: false, shakeCommentBox: jest.fn(), isEventInMoatUI: () => false, isDeepSelectModifier: e => !!e.ctrlKey,
    highlightedElement: null, drilledOnPointerdown: false, lastPointer: { x: 0, y: 0 },
    refreshPickAtPointer: jest.fn(), createCommentBox: jest.fn(), handleDeepSelectDrill: jest.fn() });
  vm.runInContext(sourceSection(source, '  // Click handler — plain click', '  // macOS: Ctrl+Click is remapped'), context);
  const event = { target: { id: 'button' }, clientX: 80, clientY: 60, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
  return { context, click, event };
}

test('plain click without prior hover opens an annotation', () => {
  const { context, click, event } = setup();
  context.refreshPickAtPointer.mockReturnValue(event.target);
  click(event);
  expect(context.refreshPickAtPointer).toHaveBeenCalledWith(80, 60);
  expect(context.createCommentBox).toHaveBeenCalledWith(event.target, 80, 60);
});

test('uses the current-depth pick instead of the event target', () => {
  const { context, click, event } = setup();
  const deeper = { id: 'parent-layer' };
  context.refreshPickAtPointer.mockReturnValue(deeper);
  click(event);
  expect(context.createCommentBox).toHaveBeenCalledWith(deeper, 80, 60);
});

test('falls back to the event target when picker is unavailable', () => {
  const { context, click, event } = setup();
  click(event);
  expect(context.createCommentBox).toHaveBeenCalledWith(event.target, 80, 60);
});

test('Control click without pointerdown uses the click coordinates', () => {
  const { context, click, event } = setup();
  click({ ...event, ctrlKey: true });
  expect(context.lastPointer).toEqual({ x: 80, y: 60 });
  expect(context.handleDeepSelectDrill).toHaveBeenCalledTimes(1);
  expect(context.createCommentBox).not.toHaveBeenCalled();
});

test('page clicks cannot replace the selection while the screenshot is being captured', () => {
  const { context, click, event } = setup();
  context.annotationCapturePending = true;
  event.preventDefault = jest.fn();
  click(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(context.refreshPickAtPointer).not.toHaveBeenCalled();
  expect(context.createCommentBox).not.toHaveBeenCalled();
});

test('drilling refreshes an empty hover stack before choosing the next layer', () => {
  const top = { id: 'top' }, deep = { id: 'deep' };
  const picker = require('../../chrome-extension/utils/elementPicker');
  const api = { ...picker, pickElementAtPoint: jest.fn(() => ({ element: deep, depth: 2, total: 2 })) };
  const context = vm.createContext({ getElementPicker: () => api, pickStack: [], deepSelectIndex: 0,
    lastPointer: { x: 80, y: 60 }, showNotification: jest.fn(), console: { info() {}, warn() {} } });
  context.refreshPickAtPointer = jest.fn(() => { context.pickStack = [top, deep]; return deep; });
  vm.runInContext(sourceSection(source, '  function drillDeeperAtPointer()', '  // Trackpads often skip'), context);
  context.drillDeeperAtPointer();
  expect(context.deepSelectIndex).toBe(1);
  expect(context.refreshPickAtPointer).toHaveBeenCalledWith(80, 60);
});

test('deep selection keeps its highlight without showing a page message', () => {
  const dom = new JSDOM('<button>Example</button>');
  try {
    const element = dom.window.document.querySelector('button');
    const picker = { pickElementAtPoint: () => ({ element, depth: 2, total: 2, stack: [element, element] }) };
    const context = vm.createContext({ document: dom.window.document, getElementPicker: () => picker,
      deepSelectIndex: 1, lastPointer: {}, pickStack: [], hoveredElement: null,
      highlightElement: jest.fn(), removeHighlight: jest.fn() });
    vm.runInContext(sourceSection(source, '  function setDeepSelectActive(', '  function drillDeeperAtPointer()'), context);
    expect(context.refreshPickAtPointer(10, 20)).toBe(element);
    expect(context.highlightElement).toHaveBeenCalledWith(element, true);
    expect(dom.window.document.body.classList.contains('float-deep-select-active')).toBe(true);
    expect(dom.window.document.querySelector('.float-deep-select-badge')).toBeNull();
    expect(dom.window.document.body.textContent).toBe('Example');
  } finally {
    dom.window.close();
  }
});
