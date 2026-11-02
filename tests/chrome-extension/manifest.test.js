const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../../chrome-extension/manifest.json');
const { shouldExclude } = require('../../scripts/build.js');

function manifestResources() {
  return [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap(script => [...script.js, ...script.css]),
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons),
    ...manifest.web_accessible_resources.flatMap(group => group.resources)
  ];
}

test('every extension resource named in the manifest exists', () => {
  for (const resource of manifestResources()) {
    expect(fs.statSync(path.resolve(__dirname, '../../chrome-extension', resource)).isFile()).toBe(true);
  }
});

test('the build includes runtime resources and excludes development or generated files', () => {
  expect(shouldExclude('README.md')).toBe(true);
  for (const resource of manifestResources()) {
    expect(shouldExclude(resource)).toBe(false);
  }
  expect(['background.test.js', 'utils/annotationStore.test.js']
    .filter(resource => !shouldExclude(resource))).toEqual([]);
});

test('file access code never loads into web pages', () => {
  const scripts = manifest.content_scripts.flatMap(script => script.js);
  expect(scripts).toEqual(expect.arrayContaining(['content_script.js']));
  for (const fileAccess of ['utils/persistence.js', 'utils/annotationStore.js', 'sidepanel/projectSetup.js']) {
    expect(scripts).not.toContain(fileAccess);
  }
  const contentScript = fs.readFileSync(path.resolve(__dirname, '../../chrome-extension/content_script.js'), 'utf8');
  expect(contentScript).not.toMatch(/showDirectoryPicker|FileSystem\w*Handle|getDirectoryHandle|getFileHandle|window\.directoryHandle/);
});

test('the side panel loads its file access code before its own script', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../chrome-extension/sidepanel/sidepanel.html'), 'utf8');
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  expect(order).toEqual(['../utils/persistence.js', '../utils/annotationStore.js', 'projectSetup.js', 'sidepanel.js']);
  for (const script of order) {
    expect(fs.existsSync(path.resolve(__dirname, '../../chrome-extension/sidepanel', script))).toBe(true);
  }
});

test('a keyboard shortcut opens the panel the same way as the toolbar icon', () => {
  const command = manifest.commands._execute_action;
  expect(command.suggested_key).toEqual({ default: 'Alt+Shift+D', mac: 'MacCtrl+Shift+D' });
  expect(manifest.action.default_popup).toBeUndefined();
});

test('web pages cannot read the agent command template', () => {
  const resources = manifest.web_accessible_resources.flatMap(group => group.resources);
  expect(resources).not.toContain('rules-templates/bridge.md');
});
