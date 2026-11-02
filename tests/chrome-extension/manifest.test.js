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
  expect(['background.test.js', 'utils/annotationStore.test.js', '.moat/config.json']
    .filter(resource => !shouldExclude(resource))).toEqual([]);
});

test('the annotation store loads after its dependencies and before the content script', () => {
  const scripts = manifest.content_scripts[0].js;
  const store = scripts.indexOf('utils/annotationStore.js');
  expect(scripts).toEqual(expect.arrayContaining([
    'utils/taskStore.js', 'utils/markdownGenerator.js', 'utils/annotationStore.js', 'content_script.js'
  ]));
  expect(store).toBeGreaterThan(scripts.indexOf('utils/taskStore.js'));
  expect(store).toBeGreaterThan(scripts.indexOf('utils/markdownGenerator.js'));
  expect(store).toBeLessThan(scripts.indexOf('content_script.js'));
});
