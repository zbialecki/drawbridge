const fs = require('node:fs');
const path = require('node:path');
const { directoryFixture } = require('../helpers/directory-handle');
const { installProjectFiles } = require('../../chrome-extension/sidepanel/projectSetup');

const bridge = fs.readFileSync(path.resolve(__dirname, '../../chrome-extension/rules-templates/bridge.md'), 'utf8');
let fixture;
beforeEach(() => {
  fixture = directoryFixture();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  global.chrome = { runtime: { getURL: value => value } };
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => bridge }));
});
afterEach(() => {
  fixture.cleanup();
  delete global.chrome;
  delete global.fetch;
  jest.restoreAllMocks();
});

test('installs the /bridge command for each agent without touching project files', async () => {
  fs.writeFileSync(path.join(fixture.root, 'README.md'), 'My README');
  fs.writeFileSync(path.join(fixture.root, 'config.json'), '{"mine":true}');
  await installProjectFiles(fixture.directory);

  expect(fixture.exists('.moat')).toBe(false);
  expect(fixture.exists('screenshots')).toBe(false);
  expect(fixture.exists('.gitignore')).toBe(false);
  expect(fixture.read('README.md')).toBe('My README');
  expect(fixture.read('config.json')).toBe('{"mine":true}');
  const command = fixture.read('.claude/commands/bridge.md');
  expect(command).toContain('metadata.json');
  expect(command).toContain('relative to that metadata');
  expect(command).toContain('needsDiscussion');
  expect(command).toContain('even in yolo mode');
  expect(fixture.read('.windsurf/workflows/bridge.md')).toBe(command);
  expect(fixture.read('.codex/prompts/bridge.md')).toBe(command);
});

test('connecting preserves existing agent commands, including an empty file', async () => {
  const commands = [['.claude/commands', 'My custom command'], ['.windsurf/workflows', ''], ['.codex/prompts', 'My saved prompt']];
  for (const [folder, content] of commands) {
    fs.mkdirSync(path.join(fixture.root, folder), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, folder, 'bridge.md'), content);
  }
  await installProjectFiles(fixture.directory);
  for (const [folder, content] of commands) expect(fixture.read(`${folder}/bridge.md`)).toBe(content);
});

test('adds agent folders to an existing .gitignore only once', async () => {
  fs.writeFileSync(path.join(fixture.root, '.gitignore'), 'node_modules/\n.claude/\n');
  await installProjectFiles(fixture.directory);
  await installProjectFiles(fixture.directory);
  const ignore = fixture.read('.gitignore');
  expect(ignore.startsWith('node_modules/\n.claude/\n')).toBe(true);
  expect(ignore.match(/\.claude\//g)).toHaveLength(1);
  expect(ignore.match(/\.windsurf\//g)).toHaveLength(1);
  expect(ignore.match(/\.codex\//g)).toHaveLength(1);
});

test('falls back to a built-in command if the template cannot load', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
  await installProjectFiles(fixture.directory);
  expect(fixture.read('.claude/commands/bridge.md')).toContain('Process Drawbridge annotation folders');
  expect(fixture.read('.claude/commands/bridge.md')).toContain('needsDiscussion');
});

test('one agent folder failing does not stop the others', async () => {
  fs.writeFileSync(path.join(fixture.root, '.windsurf'), 'a file, not a folder');
  await installProjectFiles(fixture.directory);
  expect(fixture.exists('.claude/commands/bridge.md')).toBe(true);
  expect(fixture.exists('.codex/prompts/bridge.md')).toBe(true);
});
