const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { sourceSection } = require('../helpers/test-utils');
const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');
const helper = sourceSection(source, '  // Let the user move an open editor', '  // Keep the editor and its images');
let dom;

function setup() {
  dom = new JSDOM('<div class="float-comment-box"><textarea></textarea></div>');
  const { window } = dom;
  Object.defineProperties(window, { innerWidth: { value: 1000 }, innerHeight: { value: 800 } });
  const box = window.document.querySelector('.float-comment-box');
  box.getBoundingClientRect = () => {
    const [x, y] = (box.style.translate || '0px 0px').split(' ').map(parseFloat);
    return { left: 100 + x, right: 460 + x, top: 100 + y, bottom: 340 + y };
  };
  vm.runInNewContext(`${helper}; enableCommentBoxDrag(box);`, { box, document: window.document, window });
  const handle = box.firstElementChild;
  const captures = [];
  handle.setPointerCapture = id => captures.push(id);
  const pointer = (type, clientX, clientY, button = 0) => {
    const event = new window.MouseEvent(type, { clientX, clientY, button, cancelable: true });
    handle.dispatchEvent(event);
    return event;
  };
  const release = () => handle.dispatchEvent(new window.Event('lostpointercapture'));
  return { box, handle, captures, pointer, release };
}
afterEach(() => dom.window.close());

test('adds a handle above the editor fields', () => {
  const { handle } = setup();
  expect(handle.className).toBe('float-comment-drag-handle');
  expect(handle.nextElementSibling.tagName).toBe('TEXTAREA');
});

test('moves the editor with the pointer and continues from there on the next drag', () => {
  const { box, pointer, release } = setup();
  pointer('pointerdown', 200, 110);
  pointer('pointermove', 250, 130);
  expect(box.style.translate).toBe('50px 20px');
  release();
  pointer('pointermove', 400, 400);
  expect(box.style.translate).toBe('50px 20px');
  pointer('pointerdown', 300, 200);
  pointer('pointermove', 310, 230);
  expect(box.style.translate).toBe('60px 50px');
});

test('keeps the whole editor inside the viewport', () => {
  const { box, pointer } = setup();
  pointer('pointerdown', 200, 110);
  pointer('pointermove', -500, -500);
  expect(box.style.translate).toBe('-100px -100px');
  pointer('pointermove', 5000, 5000);
  expect(box.style.translate).toBe('540px 460px');
});

test('only the primary button drags, and the caret stays in the textarea', () => {
  const { box, captures, pointer } = setup();
  pointer('pointerdown', 200, 110, 2);
  pointer('pointermove', 250, 130);
  expect(captures).toEqual([]);
  expect(box.style.translate).toBe('');
  expect(pointer('mousedown', 200, 110).defaultPrevented).toBe(true);
});
