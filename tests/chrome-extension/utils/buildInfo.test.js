const { getContentScriptBuild, DRAWBRIDGE_FEATURE_BUILD } = require('../../../chrome-extension/utils/buildInfo.js');

describe('buildInfo', () => {
  test('build id includes manifest version and feature tag', () => {
    expect(getContentScriptBuild('1.1.1')).toBe(`1.1.1-${DRAWBRIDGE_FEATURE_BUILD}`);
  });
});
