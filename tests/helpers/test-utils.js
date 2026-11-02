const assert = require('node:assert/strict');

function sourceSection(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing source section start: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `Missing source section end after ${start}: ${end}`);
  return source.slice(from, to);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

module.exports = { sourceSection, deferred };
