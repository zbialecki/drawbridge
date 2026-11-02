const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { sourceSection } = require('../helpers/test-utils');
const source = fs.readFileSync(require.resolve('../../chrome-extension/content_script.js'), 'utf8');
const guard = sourceSection(source, '  const __moatNodeSelector', '  let commentMode');
let dom;

function setup() {
  dom = new JSDOM('<input id="host"><input id="other-host"><div class="float-comment-box"><textarea></textarea></div>');
  const { document, Element, FocusEvent } = dom.window;
  vm.runInNewContext(guard, { Element, document });
  return {
    document,
    host: document.getElementById('host'),
    otherHost: document.getElementById('other-host'),
    editor: document.querySelector('textarea'),
    focus(type, target, relatedTarget) {
      target.dispatchEvent(new FocusEvent(type, { bubbles: true, relatedTarget }));
    }
  };
}
afterEach(() => dom.window.close());

test('blocks the host focusout trap when focus enters the editor', () => {
  const { document, host, editor, focus } = setup();
  const trap = jest.fn();
  document.addEventListener('focusout', trap);
  focus('focusout', host, editor);
  expect(trap).not.toHaveBeenCalled();
});

test.each(['focusin', 'focusout'])('blocks editor %s but preserves host-only transitions', type => {
  const { document, host, otherHost, editor, focus } = setup();
  const trap = jest.fn();
  document.addEventListener(type, trap);
  focus(type, editor, host);
  expect(trap).not.toHaveBeenCalled();
  for (const relatedTarget of [otherHost, null]) {
    trap.mockClear();
    focus(type, host, relatedTarget);
    expect(trap).toHaveBeenCalledTimes(1);
  }
});
