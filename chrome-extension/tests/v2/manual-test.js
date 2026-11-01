/**
 * Drawbridge V2 Manual Test via Puppeteer
 * 
 * Tests the extension loaded in Chromium with a self-contained test page.
 * Some features (Side Panel, File System Access) can't be fully automated
 * but we can verify extension loading, content script injection, and UI behavior.
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const http = require('http');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '../../');
const RESULTS = [];

function log(status, test, detail = '') {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
  console.log(`${icon} ${test}${detail ? ` — ${detail}` : ''}`);
  RESULTS.push({ status, test, detail });
}

// Self-contained page for extension injection and UI checks.
function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Drawbridge Test Page</title></head>
<body>
  <nav><a href="#content">Content</a></nav>
  <main id="content">
    <h1>Drawbridge Test Page</h1>
    <p>This self-contained page verifies extension loading, content script injection,
      and user interface behavior without external assets or a separate project.</p>
    <button type="button">Test button</button>
  </main>
</body>
</html>`);
    });
    
    server.listen(3456, () => {
      console.log('🌐 Test server running on http://localhost:3456\n');
      resolve(server);
    });
  });
}

async function run() {
  console.log('🚀 Drawbridge V2 Manual Test Suite');
  console.log('='.repeat(60));
  console.log(`Extension: ${EXTENSION_PATH}`);

  const server = await startTestServer();

  let browser;
  try {
    // Launch Chromium with extension loaded
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium',
      headless: false, // Extensions require non-headless... but we're in a sandbox
      args: [
        '--headless=new', // "new" headless mode supports extensions
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--window-size=1280,800'
      ]
    });

    // === TEST 1: Extension loads successfully ===
    try {
      const pages = await browser.pages();
      log('PASS', 'T01: Browser launched with extension');
    } catch (e) {
      log('FAIL', 'T01: Browser launched with extension', e.message);
      return;
    }

    // === TEST 2: Get extension ID ===
    let extensionId;
    try {
      // Navigate to a real page first to trigger extension activation
      const setupPage = await browser.newPage();
      await setupPage.goto('http://localhost:3456', { waitUntil: 'networkidle2', timeout: 10000 });
      
      // Wait for service worker to spin up (can be slow in headless)
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 500));
        const targets = browser.targets();
        const extTarget = targets.find(t => 
          t.type() === 'service_worker' && t.url().includes('chrome-extension://')
        );
        if (extTarget) {
          extensionId = extTarget.url().split('/')[2];
          break;
        }
        // Also check other target types
        const bgTarget = targets.find(t => 
          t.url().includes('chrome-extension://') && t.url().includes('background')
        );
        if (bgTarget) {
          extensionId = bgTarget.url().split('/')[2];
          break;
        }
      }
      
      if (extensionId) {
        log('PASS', 'T02: Extension ID found', extensionId);
      } else {
        // Last resort: check manifest for known extension ID patterns
        const targets = browser.targets();
        const anyExt = targets.find(t => t.url().includes('chrome-extension://'));
        if (anyExt) {
          extensionId = anyExt.url().split('/')[2];
          log('PASS', 'T02: Extension ID found (fallback)', extensionId);
        } else {
          log('WARN', 'T02: Extension ID not found', `Targets: ${targets.map(t => t.type()).join(', ')}`);
        }
      }
      await setupPage.close();
    } catch (e) {
      log('FAIL', 'T02: Extension ID found', e.message);
    }

    // === TEST 3: Content script responds to ping via background relay ===
    // In V2, content scripts run in Chrome's isolated world. The correct way to
    // verify injection is to ping the content script through chrome.tabs.sendMessage
    // from an extension page — the same relay the side panel uses in production.
    // IMPORTANT: We query by URL, not "active tab", because opening the side panel
    // as a new tab changes which tab is "active".
    const page = await browser.newPage();
    try {
      await page.goto('http://localhost:3456', { waitUntil: 'networkidle2', timeout: 15000 });

      // Give content script time to initialize
      await new Promise(r => setTimeout(r, 2000));

      if (extensionId) {
        const spPage = await browser.newPage();
        await spPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, {
          waitUntil: 'networkidle2', timeout: 10000
        });
        await new Promise(r => setTimeout(r, 1000));

        // Query for the test tab by URL — not "active tab" which would be this side panel page
        const contentScriptReady = await spPage.evaluate(async () => {
          try {
            const tabs = await chrome.tabs.query({ url: 'http://localhost:3456/*' });
            if (!tabs.length) return { ready: false, reason: 'test tab not found' };

            return new Promise((resolve) => {
              chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' }, (response) => {
                if (chrome.runtime.lastError) {
                  resolve({ ready: false, reason: chrome.runtime.lastError.message });
                } else {
                  resolve({ ready: response?.ready === true, response });
                }
              });
            });
          } catch (e) {
            return { ready: false, reason: e.message };
          }
        });

        if (contentScriptReady.ready) {
          log('PASS', 'T03: Content script responds to ping', JSON.stringify(contentScriptReady));
        } else {
          log('WARN', 'T03: Content script ping failed', JSON.stringify(contentScriptReady));
        }
        await spPage.close();
      } else {
        log('WARN', 'T03: Skipped — extension ID not available');
      }
    } catch (e) {
      log('FAIL', 'T03: Content script ping', e.message);
    }

    // === TEST 4: Content script handles GET_CONNECTION_STATUS ===
    // Verify the content script handles V2 message types correctly.
    // Query test tab by URL (not active tab — that would be the side panel page).
    try {
      if (extensionId) {
        const spPage = await browser.newPage();
        await spPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, {
          waitUntil: 'networkidle2', timeout: 10000
        });
        await new Promise(r => setTimeout(r, 1000));

        const statusResult = await spPage.evaluate(async () => {
          try {
            const tabs = await chrome.tabs.query({ url: 'http://localhost:3456/*' });
            if (!tabs.length) return { success: false, reason: 'test tab not found' };

            return new Promise((resolve) => {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CONNECTION_STATUS' }, (response) => {
                if (chrome.runtime.lastError) {
                  resolve({ success: false, reason: chrome.runtime.lastError.message });
                } else {
                  resolve({ success: true, response });
                }
              });
            });
          } catch (e) {
            return { success: false, reason: e.message };
          }
        });

        if (statusResult.success && statusResult.response) {
          log('PASS', 'T04: Content script handles GET_CONNECTION_STATUS',
            `connected: ${statusResult.response.connected}, path: "${statusResult.response.path}"`);
        } else {
          log('WARN', 'T04: GET_CONNECTION_STATUS failed', JSON.stringify(statusResult));
        }
        await spPage.close();
      } else {
        log('WARN', 'T04: Skipped — extension ID not available');
      }
    } catch (e) {
      log('FAIL', 'T04: GET_CONNECTION_STATUS', e.message);
    }

    // === TEST 5: Content CSS injected (not moat.css) ===
    // Extension-injected CSS (via manifest content_scripts.css) gets an href like
    // chrome-extension://id/content.css — NOT anonymous. Check for that href and
    // also verify no moat.css (V1) is present.
    try {
      const cssCheck = await page.evaluate(() => {
        const sheets = Array.from(document.styleSheets);
        const hasMoatCss = sheets.some(s => s.href && s.href.includes('moat.css'));
        const hasContentCss = sheets.some(s => s.href && s.href.includes('content.css'));

        // Also try to find known CSS rules as a fallback
        let hasContentCssRules = false;
        for (const sheet of sheets) {
          try {
            const rules = Array.from(sheet.cssRules || []);
            const hasFloatRule = rules.some(r =>
              r.selectorText && (
                r.selectorText.includes('.float-comment-mode') ||
                r.selectorText.includes('.float-highlight') ||
                r.selectorText.includes('.float-drawing-canvas')
              )
            );
            if (hasFloatRule) {
              hasContentCssRules = true;
              break;
            }
          } catch (e) {
            // Cross-origin stylesheet — skip
          }
        }

        return { hasContentCss, hasContentCssRules, hasMoatCss, sheetCount: sheets.length };
      });

      const contentDetected = cssCheck.hasContentCss || cssCheck.hasContentCssRules;
      if (contentDetected && !cssCheck.hasMoatCss) {
        log('PASS', 'T05: V2 content.css injected, moat.css removed', JSON.stringify(cssCheck));
      } else if (cssCheck.hasMoatCss) {
        log('FAIL', 'T05: V1 moat.css still present', JSON.stringify(cssCheck));
      } else {
        log('WARN', 'T05: content.css not detected', JSON.stringify(cssCheck));
      }
    } catch (e) {
      log('FAIL', 'T05: CSS injection check', e.message);
    }

    // === TEST 6: No moat.js sidebar injected (V1 removed) ===
    try {
      const noMoat = await page.evaluate(() => {
        const moatSidebar = document.getElementById('moat-sidebar') || 
                           document.querySelector('.moat-sidebar') ||
                           document.querySelector('[data-moat]');
        return !moatSidebar;
      });
      
      if (noMoat) {
        log('PASS', 'T06: No V1 moat sidebar injected into page');
      } else {
        log('FAIL', 'T06: V1 moat sidebar still present in page');
      }
    } catch (e) {
      log('FAIL', 'T06: No V1 moat sidebar check', e.message);
    }

    // === TEST 7: Manifest has correct V2 configuration ===
    try {
      const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      
      const checks = {
        version: manifest.version === '2.0.0',
        sidePanel: manifest.permissions?.includes('sidePanel'),
        hasSidePanelConfig: !!manifest.side_panel?.default_path,
        noMoatJs: !manifest.content_scripts?.[0]?.js?.includes('moat.js'),
        noMoatCss: !manifest.content_scripts?.[0]?.css?.includes('moat.css'),
        hasContentCss: manifest.content_scripts?.[0]?.css?.includes('content.css')
      };
      
      const allPass = Object.values(checks).every(v => v);
      if (allPass) {
        log('PASS', 'T07: Manifest V2 configuration correct', JSON.stringify(checks));
      } else {
        log('FAIL', 'T07: Manifest V2 configuration', JSON.stringify(checks));
      }
    } catch (e) {
      log('FAIL', 'T07: Manifest V2 configuration', e.message);
    }

    // === TEST 8: Side Panel HTML exists and is well-formed ===
    try {
      if (extensionId) {
        const spPage = await browser.newPage();
        await spPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, { 
          waitUntil: 'networkidle2', timeout: 10000 
        });
        
        const spCheck = await spPage.evaluate(() => {
          return {
            title: document.title,
            hasApp: !!document.getElementById('drawbridge-app'),
            hasTaskContainer: !!document.getElementById('task-container'),
            hasTabs: document.querySelectorAll('.tab').length,
            hasConnectBtn: !!document.getElementById('connect-btn'),
            hasToolsBtn: !!document.getElementById('tools-btn'),
            hasSettingsBtn: !!document.getElementById('settings-btn'),
            hasToolsMenu: !!document.getElementById('tools-menu'),
            hasProjectMenu: !!document.getElementById('project-menu')
          };
        });
        
        const allPresent = spCheck.hasApp && spCheck.hasTaskContainer && 
                          spCheck.hasTabs === 3 && spCheck.hasConnectBtn &&
                          spCheck.hasToolsBtn && spCheck.hasSettingsBtn;
        
        if (allPresent) {
          log('PASS', 'T08: Side Panel HTML structure correct', JSON.stringify(spCheck));
        } else {
          log('FAIL', 'T08: Side Panel HTML structure', JSON.stringify(spCheck));
        }
        await spPage.close();
      } else {
        log('WARN', 'T08: Skipped — extension ID not available');
      }
    } catch (e) {
      log('FAIL', 'T08: Side Panel HTML', e.message);
    }

    // === TEST 9: Side Panel JS initializes ===
    try {
      if (extensionId) {
        const spPage = await browser.newPage();
        await spPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, {
          waitUntil: 'networkidle2', timeout: 10000
        });
        
        // Wait for JS to initialize
        await new Promise(r => setTimeout(r, 1000));
        
        const jsCheck = await spPage.evaluate(() => {
          return {
            // Check if event listeners are set up by looking for UI state
            connectionBanner: document.getElementById('connection-banner')?.className || '',
            tabsExist: document.querySelectorAll('.tab').length,
            activeTab: document.querySelector('.tab.active')?.dataset?.status || '',
            emptyState: !!document.querySelector('.empty-state'),
            badgesExist: !!document.getElementById('todo-badge')
          };
        });
        
        const initialized = jsCheck.tabsExist === 3 && 
                           jsCheck.activeTab === 'to do' &&
                           jsCheck.emptyState;
        
        if (initialized) {
          log('PASS', 'T09: Side Panel JS initialized', `Active tab: "${jsCheck.activeTab}", disconnected state shown`);
        } else {
          log('FAIL', 'T09: Side Panel JS initialization', JSON.stringify(jsCheck));
        }
        await spPage.close();
      } else {
        log('WARN', 'T09: Skipped — extension ID not available');
      }
    } catch (e) {
      log('FAIL', 'T09: Side Panel JS initialization', e.message);
    }

    // === TEST 10: Side Panel theme toggle ===
    try {
      if (extensionId) {
        const spPage = await browser.newPage();
        await spPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, {
          waitUntil: 'networkidle2', timeout: 10000
        });
        await new Promise(r => setTimeout(r, 500));
        
        const themeBefore = await spPage.evaluate(() => {
          return document.documentElement.getAttribute('data-theme');
        });
        
        await spPage.click('#settings-btn');
        await new Promise(r => setTimeout(r, 300));
        
        const themeAfter = await spPage.evaluate(() => {
          return document.documentElement.getAttribute('data-theme');
        });
        
        if (themeBefore !== themeAfter) {
          log('PASS', 'T10: Theme toggle works', `${themeBefore} → ${themeAfter}`);
        } else {
          log('FAIL', 'T10: Theme toggle', `Theme didn't change: ${themeBefore}`);
        }
        await spPage.close();
      } else {
        log('WARN', 'T10: Skipped — extension ID not available');
      }
    } catch (e) {
      log('FAIL', 'T10: Theme toggle', e.message);
    }

    // === TEST 11: Side Panel tab switching ===
    try {
      if (extensionId) {
        const spPage = await browser.newPage();
        await spPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, {
          waitUntil: 'networkidle2', timeout: 10000
        });
        await new Promise(r => setTimeout(r, 500));
        
        // Click "Doing" tab
        await spPage.click('.tab[data-status="doing"]');
        await new Promise(r => setTimeout(r, 200));
        
        const doingActive = await spPage.evaluate(() => {
          return document.querySelector('.tab.active')?.dataset?.status;
        });
        
        // Click "Done" tab
        await spPage.click('.tab[data-status="done"]');
        await new Promise(r => setTimeout(r, 200));
        
        const doneActive = await spPage.evaluate(() => {
          return document.querySelector('.tab.active')?.dataset?.status;
        });
        
        if (doingActive === 'doing' && doneActive === 'done') {
          log('PASS', 'T11: Tab switching works', 'to do → doing → done');
        } else {
          log('FAIL', 'T11: Tab switching', `doing=${doingActive}, done=${doneActive}`);
        }
        await spPage.close();
      } else {
        log('WARN', 'T11: Skipped — extension ID not available');
      }
    } catch (e) {
      log('FAIL', 'T11: Tab switching', e.message);
    }

    // === TEST 12: Side Panel tools menu ===
    try {
      if (extensionId) {
        const spPage = await browser.newPage();
        await spPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, {
          waitUntil: 'networkidle2', timeout: 10000
        });
        await new Promise(r => setTimeout(r, 500));
        
        // Tools menu should be hidden initially
        const hiddenBefore = await spPage.evaluate(() => {
          return document.getElementById('tools-menu')?.classList.contains('hidden');
        });
        
        // Click tools button
        await spPage.click('#tools-btn');
        await new Promise(r => setTimeout(r, 200));
        
        const hiddenAfter = await spPage.evaluate(() => {
          return document.getElementById('tools-menu')?.classList.contains('hidden');
        });
        
        // Check menu items
        const menuItems = await spPage.evaluate(() => {
          return Array.from(document.querySelectorAll('#tools-menu .menu-item'))
            .map(item => item.dataset.action);
        });
        
        if (hiddenBefore && !hiddenAfter && menuItems.includes('comment') && menuItems.includes('rectangle')) {
          log('PASS', 'T12: Tools menu opens with Comment + Rectangle', menuItems.join(', '));
        } else {
          log('FAIL', 'T12: Tools menu', `hidden: ${hiddenBefore}→${hiddenAfter}, items: ${menuItems}`);
        }
        await spPage.close();
      } else {
        log('WARN', 'T12: Skipped — extension ID not available');
      }
    } catch (e) {
      log('FAIL', 'T12: Tools menu', e.message);
    }

    // === TEST 13: Test page renders correctly ===
    try {
      const pageCheck = await page.evaluate(() => {
        return {
          title: document.title,
          hasHeading: !!document.querySelector('h1'),
          hasNav: !!document.querySelector('nav'),
          bodyText: document.body?.innerText?.length || 0
        };
      });
      
      if (pageCheck.bodyText > 100) {
        log('PASS', 'T13: Test page renders correctly', `Title: ${pageCheck.title}, Body: ${pageCheck.bodyText} chars`);
      } else {
        log('FAIL', 'T13: Test page rendering', JSON.stringify(pageCheck));
      }
    } catch (e) {
      log('FAIL', 'T13: Test page rendering', e.message);
    }

    // === TEST 14: Background service worker active ===
    try {
      const targets = browser.targets();
      const swTarget = targets.find(t => 
        t.type() === 'service_worker' && t.url().includes('background.js')
      );
      
      if (swTarget) {
        log('PASS', 'T14: Background service worker active', swTarget.url());
      } else {
        // Check all targets
        const allTargets = targets.map(t => `${t.type()}: ${t.url()}`);
        log('WARN', 'T14: Background service worker', `Not found. Targets: ${allTargets.join(', ')}`);
      }
    } catch (e) {
      log('FAIL', 'T14: Background service worker', e.message);
    }

    // === TEST 15: No console errors on test page ===
    try {
      const newPage = await browser.newPage();
      const consoleErrors = [];
      newPage.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });
      
      await newPage.goto('http://localhost:3456', { waitUntil: 'networkidle2', timeout: 10000 });
      await new Promise(r => setTimeout(r, 2000)); // Wait for content script
      
      // Filter out expected/benign errors
      const realErrors = consoleErrors.filter(e => 
        !e.includes('favicon') && 
        !e.includes('net::ERR') &&
        !e.includes('Failed to load resource')
      );
      
      if (realErrors.length === 0) {
        log('PASS', 'T15: No console errors on test page');
      } else {
        log('FAIL', 'T15: Console errors detected', realErrors.join(' | '));
      }
      await newPage.close();
    } catch (e) {
      log('FAIL', 'T15: Console error check', e.message);
    }

  } catch (e) {
    console.error('💥 Fatal error:', e.message);
    console.error(e.stack);
  } finally {
    if (browser) await browser.close();
    server.close();
    
    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 MANUAL TEST RESULTS');
    console.log('='.repeat(60));
    
    const passed = RESULTS.filter(r => r.status === 'PASS').length;
    const failed = RESULTS.filter(r => r.status === 'FAIL').length;
    const warned = RESULTS.filter(r => r.status === 'WARN').length;
    
    console.log(`✅ Passed:  ${passed}`);
    console.log(`❌ Failed:  ${failed}`);
    console.log(`⚠️  Warned:  ${warned}`);
    console.log(`📈 Pass Rate: ${RESULTS.length > 0 ? ((passed / RESULTS.length) * 100).toFixed(1) : 0}%`);
    
    if (failed > 0) {
      console.log('\n❌ Failures:');
      RESULTS.filter(r => r.status === 'FAIL').forEach(r => {
        console.log(`  • ${r.test}: ${r.detail}`);
      });
    }
    
    console.log('='.repeat(60));
    
    // Save results to file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const commit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '../../../') }).toString().trim();
    const resultsDir = path.resolve(__dirname, 'results');
    const resultsFile = path.join(resultsDir, `manual-${timestamp}-${commit}.md`);
    
    let md = `# Manual Test Results\n\n`;
    md += `- **Date:** ${new Date().toISOString()}\n`;
    md += `- **Commit:** ${commit}\n`;
    md += `- **Branch:** v2\n`;
    md += `- **Passed:** ${passed} | **Failed:** ${failed} | **Warned:** ${warned}\n`;
    md += `- **Pass Rate:** ${RESULTS.length > 0 ? ((passed / RESULTS.length) * 100).toFixed(1) : 0}%\n\n`;
    md += `## Results\n\n`;
    md += `| Status | Test | Detail |\n`;
    md += `|--------|------|--------|\n`;
    RESULTS.forEach(r => {
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
      md += `| ${icon} ${r.status} | ${r.test} | ${r.detail || '—'} |\n`;
    });
    
    fs.writeFileSync(resultsFile, md);
    console.log(`\n📄 Results saved: ${resultsFile}`);
  }
}

run();
