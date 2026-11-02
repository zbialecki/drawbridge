// chrome-extension/background.js

importScripts('utils/buildInfo.js', 'utils/frameworkContext.js');

const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'moz-extension://',
  'devtools://'
];

function isRestrictedTab(tab) {
  return !tab?.id || !tab?.url || RESTRICTED_URL_PREFIXES.some(scheme => tab.url.startsWith(scheme));
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const lastError = chrome.runtime.lastError;

        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function runScriptingMethod(methodName, details) {
  return new Promise((resolve, reject) => {
    try {
      const maybePromise = chrome.scripting[methodName](details, (result) => {
        const lastError = chrome.runtime.lastError;

        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        resolve(result);
      });

      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function getPrimaryContentScript() {
  const manifest = chrome.runtime.getManifest();
  return manifest.content_scripts?.[0] || {};
}

async function injectManifestContentScripts(tabId) {
  const contentScript = getPrimaryContentScript();
  const target = { tabId };

  if (contentScript.css?.length) {
    await runScriptingMethod('insertCSS', {
      target,
      files: contentScript.css
    });
  }

  if (contentScript.js?.length) {
    await runScriptingMethod('executeScript', {
      target,
      files: contentScript.js
    });
  }
}

function getExpectedContentScriptBuild() {
  const buildInfo = globalThis.DrawbridgeBuildInfo;
  return buildInfo.getContentScriptBuild(chrome.runtime.getManifest().version);
}

function needsManualInjection(pingResponse) {
  if (!pingResponse?.ready) {
    return true;
  }
  if (pingResponse.contentScriptBuild !== getExpectedContentScriptBuild()) {
    return true;
  }
  return false;
}

async function ensureContentScriptsReady(tabId) {
  try {
    const pingResponse = await sendTabMessage(tabId, { action: 'ping' });

    if (!needsManualInjection(pingResponse)) {
      return;
    }

    console.warn(
      'Drawbridge: Injecting content scripts (missing, outdated moat, or stale build:',
      pingResponse?.contentScriptBuild,
      'expected:',
      getExpectedContentScriptBuild() + ')'
    );
    await injectManifestContentScripts(tabId);
  } catch (error) {
    console.warn('Drawbridge: Content script not ready, injecting into active tab:', error.message);
    await injectManifestContentScripts(tabId);
  }

  const pingResponse = await sendTabMessage(tabId, { action: 'ping' });
  if (needsManualInjection(pingResponse)) {
    throw new Error(
      'Content script did not report ready after injection. Refresh the page (Ctrl+Shift+R).'
    );
  }
}

// The toolbar icon and its keyboard shortcut both toggle the panel in this window.
async function handleActionClick(tab) {
  // An open panel closes itself. A panel opened by this click has not loaded yet, so it stays open.
  chrome.runtime.sendMessage({ type: 'CLOSE_SIDE_PANEL', windowId: tab?.windowId }).catch(() => {});

  if (isRestrictedTab(tab)) {
    console.warn('Drawbridge: Cannot open on restricted page:', tab?.url);
    return;
  }

  try {
    // Open before any asynchronous work consumes the toolbar user gesture.
    await chrome.sidePanel.open({ tabId: tab.id });
    await ensureContentScriptsReady(tab.id);
    console.log('Drawbridge: Side panel opened');
  } catch (error) {
    console.warn('Drawbridge: Failed to open on this page:', error.message);
  }
}

async function captureTabScreenshot(tab) {
  if (!tab?.id) throw new Error('The requesting tab must be active during capture.');
  const query = { active: true, windowId: tab.windowId };
  if ((await chrome.tabs.query(query))[0]?.id !== tab.id) {
    throw new Error('Keep the requesting tab active during capture.');
  }
  const dataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, data => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(data);
    });
  });
  if ((await chrome.tabs.query(query))[0]?.id !== tab.id) {
    throw new Error('The active tab changed during capture.');
  }
  return { success: true, dataUrl };
}

// Handle extension icon click - open the native side panel
chrome.action.onClicked.addListener(handleActionClick);

// Handle screenshot capture requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_SCREENSHOT') {
    captureTabScreenshot(sender.tab).then(sendResponse, error => {
      console.error('Screenshot capture failed:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Required for async sendResponse
  }
  if (message.type === 'CAPTURE_FRAMEWORK_CONTEXT' && sender.tab) {
    const { inspectPageContext, sanitizeFrameworkContext } = globalThis.DrawbridgeFrameworkContext;
    runScriptingMethod('executeScript', {
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      world: 'MAIN',
      func: inspectPageContext,
      args: [message.marker ?? null]
    }).then(
      results => sendResponse(sanitizeFrameworkContext(results?.[0]?.result, sender.tab.url)),
      error => {
        console.warn('Drawbridge: Could not read framework context:', error.message);
        sendResponse(null);
      }
    ).catch(() => sendResponse(null));
    return true; // Required for async sendResponse
  }
  if (message.type === 'RELAY_TO_SIDEPANEL' && sender.tab) {
    // Stamp trusted routing metadata after the payload; the panel filters it.
    chrome.runtime.sendMessage({
      ...message.payload,
      sourceTabId: sender.tab.id,
      sourceWindowId: sender.tab.windowId
    }).catch(() => {});
  }
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RESTRICTED_URL_PREFIXES,
    isRestrictedTab,
    needsManualInjection,
    getExpectedContentScriptBuild,
    handleActionClick,
    ensureContentScriptsReady,
    injectManifestContentScripts
  };
}
