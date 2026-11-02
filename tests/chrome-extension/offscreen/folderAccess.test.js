const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../../chrome-extension/offscreen/folderAccess.js'), 'utf8');

function setup(records) {
  let listener;
  const context = vm.createContext({
    moatPersistence: { getAllHandles: jest.fn(async () => records) },
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } } } }
  });
  vm.runInContext(source, context);
  const held = () => vm.runInContext('heldHandles', context);
  return { context, held, send: message => listener(message) };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('holds every stored folder as soon as it loads', async () => {
  const { held } = setup([{ handle: 'one' }, { handle: 'two' }]);
  await flush();
  expect([...held()]).toEqual(['one', 'two']);
});

test('picks up connections and disconnections when asked', async () => {
  const records = [{ handle: 'one' }];
  const { held, send } = setup(records);
  await flush();
  records.splice(0, 1, { handle: 'two' });
  send({ type: 'SAVE_ANNOTATION' });
  await flush();
  expect([...held()]).toEqual(['one']);
  send({ type: 'HOLD_FOLDERS' });
  await flush();
  expect([...held()]).toEqual(['two']);
});
