const manifest = require('../../chrome-extension/manifest.json');
const { getContentScriptBuild } = require('../../chrome-extension/utils/buildInfo.js');
const { deferred } = require('../helpers/test-utils');

function getReadyPing(overrides = {}) {
  return {
    success: true,
    ready: true,
    moatLoaded: true,
    contentScriptBuild: getContentScriptBuild(manifest.version),
    ...overrides
  };
}

function loadBackground({ sendMessage, insertCSS, executeScript } = {}) {
  jest.resetModules();

  global.self = global;
  global.importScripts = jest.fn(() => {
    require('../../chrome-extension/utils/buildInfo.js');
    require('../../chrome-extension/utils/frameworkContext.js');
  });
  require('../../chrome-extension/utils/buildInfo.js');
  require('../../chrome-extension/utils/frameworkContext.js');

  global.chrome = {
    sidePanel: { open: jest.fn(async () => {}) },
    action: {
      onClicked: {
        addListener: jest.fn()
      }
    },
    runtime: {
      sendMessage: jest.fn(async () => {}),
      lastError: null,
      getManifest: jest.fn(() => manifest),
      onMessage: {
        addListener: jest.fn()
      }
    },
    tabs: {
      query: jest.fn(async () => [{ id: 7, windowId: 3 }]),
      sendMessage: sendMessage || jest.fn((tabId, message, callback) => callback(getReadyPing())),
      captureVisibleTab: jest.fn()
    },
    scripting: {
      insertCSS: insertCSS || jest.fn((details, callback) => callback([])),
      executeScript: executeScript || jest.fn((details, callback) => callback([]))
    }
  };

  return require('../../chrome-extension/background');
}

afterEach(() => {
  delete global.chrome;
  delete global.self;
  delete global.importScripts;
  delete global.DrawbridgeBuildInfo;
  jest.restoreAllMocks();
});

function failNextChromeCallback(message, callback) {
  chrome.runtime.lastError = { message };
  callback();
  chrome.runtime.lastError = null;
}

describe('background action click handling', () => {
  let consoleWarnSpy;
  let consoleLogSpy;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete global.chrome;
  });

  test('opens the panel before checking content readiness', async () => {
    const sendMessage = jest.fn((tabId, message, callback) => {
      if (message.action === 'ping') {
        callback(getReadyPing());
        return;
      }

      callback({ success: true });
    });
    const { handleActionClick } = loadBackground({ sendMessage });

    await handleActionClick({ id: 7, url: 'https://example.com/' });

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
    expect(chrome.sidePanel.open.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0]);
    expect(sendMessage.mock.calls.map(call => call[1].action)).toEqual(['ping']);
    expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test('injects manifest content scripts when the active tab has no receiver', async () => {
    let pingCount = 0;
    const sendMessage = jest.fn((tabId, message, callback) => {
      if (message.action === 'ping') {
        pingCount += 1;

        if (pingCount === 1) {
          failNextChromeCallback('Could not establish connection. Receiving end does not exist.', callback);
          return;
        }

        callback({ ...getReadyPing(), moatLoaded: true });
        return;
      }

      callback({ success: true });
    });
    const { handleActionClick } = loadBackground({ sendMessage });

    await handleActionClick({ id: 7, url: 'https://example.com/' });

    expect(chrome.scripting.insertCSS).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: manifest.content_scripts[0].css
    }, expect.any(Function));
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: manifest.content_scripts[0].js
    }, expect.any(Function));
    expect(sendMessage.mock.calls.map(call => call[1].action)).toEqual(['ping', 'ping']);
  });

  test('injects full manifest when the content script is not ready', async () => {
    let pingCount = 0;
    const sendMessage = jest.fn((tabId, message, callback) => {
      if (message.action === 'ping') {
        pingCount += 1;
        callback({
          ...getReadyPing(),
          ready: pingCount > 1
        });
        return;
      }

      callback({ success: true });
    });
    const { handleActionClick } = loadBackground({ sendMessage });

    await handleActionClick({ id: 7, url: 'https://example.com/' });

    expect(chrome.scripting.insertCSS).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: manifest.content_scripts[0].css
    }, expect.any(Function));
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: manifest.content_scripts[0].js
    }, expect.any(Function));
    expect(sendMessage.mock.calls.map(call => call[1].action)).toEqual(['ping', 'ping']);
  });

  test('injects full manifest when content script build is stale', async () => {
    let pingCount = 0;
    const sendMessage = jest.fn((tabId, message, callback) => {
      if (message.action === 'ping') {
        pingCount += 1;
        callback({
          success: true,
          ready: true,
          moatLoaded: true,
          contentScriptBuild: pingCount > 1 ? getContentScriptBuild(manifest.version) : '1.0.0-outdated'
        });
        return;
      }

      callback({ success: true });
    });
    const { handleActionClick } = loadBackground({ sendMessage });

    await handleActionClick({ id: 7, url: 'https://example.com/' });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: manifest.content_scripts[0].js
    }, expect.any(Function));
    expect(sendMessage.mock.calls.map(call => call[1].action)).toEqual(['ping', 'ping']);
  });

  test('does nothing on restricted pages', async () => {
    const sendMessage = jest.fn();
    const { handleActionClick } = loadBackground({ sendMessage });

    await handleActionClick({ id: 7, url: 'chrome://extensions/' });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
    expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test('reports fallback injection failure', async () => {
    const sendMessage = jest.fn((tabId, message, callback) => {
      if (message.action === 'ping') {
        failNextChromeCallback('Could not establish connection. Receiving end does not exist.', callback);
        return;
      }

      callback({ success: true });
    });
    const insertCSS = jest.fn((details, callback) => {
      failNextChromeCallback('Cannot access contents of the page.', callback);
    });
    const { handleActionClick } = loadBackground({ sendMessage, insertCSS });

    await handleActionClick({ id: 7, url: 'https://example.com/' });

    expect(sendMessage.mock.calls.map(call => call[1].action)).toEqual(['ping']);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Drawbridge: Failed to open on this page:',
      'Cannot access contents of the page.'
    );
  });
});


test('native capture uses the sender window and keeps the response channel open until capture finishes', async () => {
  loadBackground();
  const started = deferred();
  let reply;
  chrome.tabs.captureVisibleTab.mockImplementation((windowId, options, callback) => { reply = callback; started.resolve(); });
  const handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  const respond = jest.fn();
  expect(handler({ type: 'CAPTURE_SCREENSHOT' }, { tab: { id: 7, windowId: 3 } }, respond)).toBe(true);
  await started.promise;
  expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(3, { format: 'png' }, expect.any(Function));
  expect(respond).not.toHaveBeenCalled();
  reply('data:image/png;base64,captured');
  await new Promise(setImmediate);
  expect(respond).toHaveBeenCalledWith({ success: true, dataUrl: 'data:image/png;base64,captured' });
  expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 3 });
});

test('native capture reports permission errors instead of returning a successful screenshot', async () => {
  loadBackground();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  chrome.tabs.captureVisibleTab.mockImplementation((windowId, options, callback) => {
    failNextChromeCallback('Capture permission denied', callback);
  });
  const handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  const respond = jest.fn();
  expect(handler({ type: 'CAPTURE_SCREENSHOT' }, { tab: { id: 7, windowId: 3 } }, respond)).toBe(true);
  await new Promise(setImmediate);
  expect(respond).toHaveBeenCalledWith({ success: false, error: 'Capture permission denied' });
});

test.each(['before', 'during'])('rejects screenshots when the active tab changes %s capture', async stage => {
  loadBackground();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  if (stage === 'before') chrome.tabs.query.mockResolvedValue([{ id: 99, windowId: 3 }]);
  chrome.tabs.captureVisibleTab.mockImplementation((windowId, options, reply) => {
    chrome.tabs.query.mockResolvedValue([{ id: 99, windowId: 3 }]);
    reply('data:image/png;base64,another-tab');
  });
  const handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  const result = await new Promise(resolve => {
    expect(handler({ type: 'CAPTURE_SCREENSHOT' }, { tab: { id: 7, windowId: 3 } }, resolve)).toBe(true);
  });
  expect(result).toMatchObject({ success: false, error: expect.stringContaining('active') });
  expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
});

test('relay stamps source tab and window from sender rather than payload', () => {
  loadBackground();
  const handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  handler({ type: 'RELAY_TO_SIDEPANEL', payload: { type: 'TASKS_LOADED', tasks: [], sourceTabId: 99, sourceWindowId: 99 } }, { tab: { id: 7, windowId: 3 } }, () => {});
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TASKS_LOADED', tasks: [], sourceTabId: 7, sourceWindowId: 3 });
  delete global.chrome;
});

describe('framework context capture', () => {
  const sender = { tab: { id: 7, windowId: 3, url: 'http://localhost:3000/settings' }, frameId: 0 };
  const respondWith = (executeScript) => {
    loadBackground({ executeScript });
    const handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    return new Promise(resolve => {
      expect(handler({ type: 'CAPTURE_FRAMEWORK_CONTEXT', marker: 'mark' }, sender, resolve)).toBe(true);
    });
  };

  test('runs the reader in the page world and sanitizes what it returns', async () => {
    const executeScript = jest.fn((details, callback) => callback([{ result: {
      framework: { name: 'next', mode: 'development', mcpAvailable: true, mcpEndpoint: 'https://evil.example/mcp' },
      react: { component: 'SaveButton', source: '/etc/passwd:1:1' }
    } }]));
    const response = await respondWith(executeScript);
    expect(executeScript.mock.calls[0][0]).toMatchObject({
      target: { tabId: 7, frameIds: [0] }, world: 'MAIN', args: ['mark']
    });
    expect(response.framework.mcpEndpoint).toBe('http://localhost:3000/_next/mcp');
    expect(response.react).toMatchObject({ component: 'SaveButton', source: null });
  });

  test('a page that cannot be scripted produces no context', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await respondWith((details, callback) => {
      chrome.runtime.lastError = { message: 'Cannot access this page' };
      callback();
      chrome.runtime.lastError = null;
    });
    expect(response).toBeNull();
    warn.mockRestore();
  });
});
