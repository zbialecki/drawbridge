/**
 * Drawbridge Side Panel
 *
 * Handles UI rendering and owns access to the connected project folder.
 * Folder handles stay on this extension page, where site scripts cannot reach them.
 * Content scripts send annotations here to be saved.
 */

// State
let contentPort = null;
let activeTabId = null;
let panelWindowId = null;
let tabEpoch = 0;
let currentTab = 'to do';
let tasks = [];
let isConnected = false;
let projectPath = '';
let panelOrigin = null;
let annotationStore = null;
// A folder this site can use in one click: its own after permission expired, or another site's.
let folderOffer = null;
const installedOrigins = new Set();
let currentMode = null; // 'comment', 'drawing', 'screen', or null

const trashIcon = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6"/>
  </svg>
`;

// Thumbnail cache
const thumbnailCache = new Map();

// DOM Elements
const taskContainer = document.getElementById('task-container');
const connectionBanner = document.getElementById('connection-banner');
const connectBtn = document.getElementById('connect-btn');
const reuseBtn = document.getElementById('reuse-btn');
const chooseBtn = document.getElementById('choose-btn');
const projectBtn = document.getElementById('project-btn');
const projectMenu = document.getElementById('project-menu');
const statusText = connectionBanner.querySelector('.status-text');
const toolsBtn = document.getElementById('tools-btn');
const toolsMenu = document.getElementById('tools-menu');
const settingsBtn = document.getElementById('settings-btn');
const notificationContainer = document.getElementById('notification-container');
const tabs = document.querySelectorAll('.tab');
const todoBadge = document.getElementById('todo-badge');
const doingBadge = document.getElementById('doing-badge');
const doneBadge = document.getElementById('done-badge');

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupEventListeners();
  chrome.tabs.onActivated.addListener(handleTabChange);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === activeTabId && changeInfo.status === 'loading') handleTabChange();
    if (tabId === activeTabId && changeInfo.status === 'complete') handleTabChange();
  });
  await loadTheme();
  await handleTabChange();
}

// Invalidate outstanding reads before loading another tab's state.
async function handleTabChange(info) {
  if (info?.windowId != null && panelWindowId != null && info.windowId !== panelWindowId) return;
  const epoch = ++tabEpoch;
  if (contentPort) { contentPort.disconnect(); contentPort = null; }
  activeTabId = null;
  contentScriptReady = false;
  isConnected = false;
  projectPath = '';
  panelOrigin = null;
  annotationStore = null;
  folderOffer = null;
  currentMode = null;
  tasks = [];
  thumbnailCache.clear();
  updateConnectionBanner();
  updateToolsButtonState();
  renderTasks();
  updateBadges();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (epoch !== tabEpoch || !tab?.id) return;
  activeTabId = tab.id;
  panelWindowId = tab.windowId;
  panelOrigin = tabOrigin(tab.url);
  await restoreFolder(epoch);
  // Pages such as chrome:// never have a content script to wait for.
  if (epoch !== tabEpoch || !panelOrigin) return;
  const ready = await connectWithRetry(5);
  if (epoch !== tabEpoch || !ready) return;
  contentPort = chrome.tabs.connect(tab.id, { name: 'drawbridge-sidepanel' });
}

// Each site has its own connection, so one site's page cannot save into another site's folder.
function tabOrigin(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return 'file://';
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

// Reconnect without prompting; permission prompts wait for a click in the panel.
async function restoreFolder(epoch) {
  const persistence = window.moatPersistence;
  if (!panelOrigin || !persistence) return;
  const origin = panelOrigin;
  const restored = await persistence.restoreProjectConnection({ origin });
  if (epoch !== tabEpoch) return;
  if (restored.success) {
    await openFolder(restored.directoryHandle, restored.path, origin);
    return;
  }
  if (restored.requiresReconnection) {
    folderOffer = { path: restored.path, reconnect: true };
  } else {
    const recent = await persistence.getMostRecentConnection();
    if (epoch !== tabEpoch) return;
    folderOffer = recent ? { path: recent.path, handle: recent.handle } : null;
  }
  updateConnectionBanner();
  renderTasks();
}

// Keeps folder access after the panel closes, until Chrome restarts. See offscreen/folderAccess.js.
async function holdFolderAccess() {
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen/folderAccess.html'),
      reasons: ['BLOBS'],
      justification: 'Keep access to the connected project folder while the side panel is closed'
    });
  } catch {
    // Only one can exist, so have the open one pick up the change.
    await chrome.runtime.sendMessage({ type: 'HOLD_FOLDERS' }).catch(error => {
      console.warn('Drawbridge: Could not keep folder access:', error);
    });
  }
}

async function openFolder(directoryHandle, path, origin) {
  const store = new window.DrawbridgeAnnotationStore.AnnotationStore();
  store.initialize(directoryHandle);
  annotationStore = store;
  isConnected = true;
  projectPath = path;
  folderOffer = null;
  updateConnectionBanner();
  holdFolderAccess();
  if (!installedOrigins.has(origin)) {
    installedOrigins.add(origin);
    await window.DrawbridgeProjectSetup.installProjectFiles(directoryHandle);
  }
  await requestTasks();
}

async function connectFolder(directoryHandle, path) {
  const origin = panelOrigin;
  if (!await window.moatPersistence.persistProjectConnection(directoryHandle, path, origin)) {
    console.warn('Drawbridge: Could not remember the project connection');
  }
  await openFolder(directoryHandle, path, origin);
  showNotification('Project connected', 'success');
}

async function chooseFolder() {
  if (!panelOrigin) {
    showNotification('Open a website before connecting a project', 'error');
    return;
  }
  try {
    const directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
    await connectFolder(directoryHandle, directoryHandle.name);
  } catch (error) {
    if (error.name === 'AbortError') showNotification('Project connection cancelled', 'info');
    else showNotification(`Could not connect project: ${error.message}`, 'error');
  }
}

async function acceptFolderOffer() {
  const offer = folderOffer;
  if (!offer || !panelOrigin) return;
  try {
    if (offer.reconnect) {
      const restored = await window.moatPersistence.restoreProjectConnection({
        origin: panelOrigin, allowPermissionPrompt: true
      });
      if (!restored.success) throw new Error(restored.reason);
      await openFolder(restored.directoryHandle, restored.path, panelOrigin);
      showNotification('Project connected', 'success');
      return;
    }
    if (!await window.moatPersistence.verifyPermission(offer.handle) &&
        !await window.moatPersistence.requestPermission(offer.handle)) {
      throw new Error('Permission denied');
    }
    await connectFolder(offer.handle, offer.path);
  } catch (error) {
    showNotification(`Could not connect project: ${error.message}`, 'error');
  }
}

// Event Listeners
function setupEventListeners() {
  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const status = tab.dataset.status;
      setActiveTab(status);
    });
  });

  // Connect buttons
  connectBtn.addEventListener('click', chooseFolder);
  reuseBtn.addEventListener('click', acceptFolderOffer);
  chooseBtn.addEventListener('click', chooseFolder);

  // Project button (opens dropdown)
  projectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleProjectMenu();
  });

  // Project menu items
  projectMenu.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', async () => {
      const action = item.dataset.action;
      hideProjectMenu();

      if (action === 'disconnect') {
        await window.moatPersistence.removeProjectConnection(panelOrigin);
        holdFolderAccess();
        annotationStore = null;
        isConnected = false;
        projectPath = '';
        tasks = [];
        thumbnailCache.clear();
        await restoreFolder(tabEpoch);
        updateConnectionBanner();
        renderTasks();
        updateBadges();
        showNotification('Project disconnected', 'success');
      } else if (action === 'refresh') {
        showNotification('Refreshing data...', 'info');
        requestTasks();
      } else if (action === 'clear-screenshots') {
        const store = annotationStore;
        if (!store) return;
        const count = (await store.loadTasksFromFile()).filter(task => task.screenshotPath).length;

        if (count === 0) {
          showNotification('No screenshots to clear', 'info');
          return;
        }

        if (confirm(`Clear ${count} screenshot${count !== 1 ? 's' : ''}? This cannot be undone.`)) {
          try {
            await store.clearScreenshots();
            showNotification(`${count} screenshot${count !== 1 ? 's' : ''} cleared`, 'success');
            thumbnailCache.clear();
            requestTasks();
          } catch {
            showNotification('Failed to clear screenshots', 'error');
          }
        }
      }
    });
  });

  // Tools dropdown
  toolsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleToolsMenu();
  });

  // Tool menu items
  toolsMenu.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', async () => {
      const action = item.dataset.action;
      hideToolsMenu();

      // Check if content script is ready
      if (!contentScriptReady) {
        const ready = await connectWithRetry(2);
        if (!ready) {
          showNotification('Please refresh the page first', 'error');
          return;
        }
      }

      // Toggle mode off if already active
      if ((action === 'comment' && currentMode === 'comment') ||
          (action === 'rectangle' && currentMode === 'drawing')) {
        sendToContentScript({ type: 'EXIT_ANNOTATION_MODE' }, false);
      } else if (action === 'comment') {
        sendToContentScript({ type: 'ENTER_COMMENT_MODE' }, false);
      } else if (action === 'rectangle') {
        sendToContentScript({ type: 'ENTER_DRAWING_MODE' }, false);
      } else if (action === 'screen') {
        await requestScreenCapture();
      }
    });
  });

  // The panel can have keyboard focus after opening the tools menu.
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 's' || e.ctrlKey || e.metaKey || e.altKey ||
        e.repeat || e.isComposing || e.keyCode === 229 || document.hidden ||
        e.target?.matches?.('input, textarea, select') || e.target?.isContentEditable ||
        e.target?.closest?.('[contenteditable], [role="textbox"]')) return;
    e.preventDefault();
    hideToolsMenu();
    requestScreenCapture();
  });

  // Settings button (theme toggle for now)
  settingsBtn.addEventListener('click', toggleTheme);

  // Close menus on outside click
  document.addEventListener('click', () => {
    hideToolsMenu();
    hideProjectMenu();
  });

  // Listen for messages from content script via background
  chrome.runtime.onMessage.addListener(handleMessage);
}

async function requestScreenCapture() {
  if (!contentScriptReady && !await connectWithRetry(2)) {
    showNotification('Please refresh the page first', 'error');
    return;
  }
  const result = await sendToContentScript({ type: 'CAPTURE_SCREEN' }, false);
  if (!result?.success) {
    showNotification(result?.error || 'Could not capture the screen. Please refresh the page and try again.', 'error');
  }
}

// Message Handling
function handleMessage(message, sender, sendResponse) {
  if (message.type === 'CLOSE_SIDE_PANEL') {
    if (!sender.tab && message.windowId === panelWindowId) window.close();
    return false;
  }
  if (message.type === 'SAVE_ANNOTATION' || message.type === 'LIST_ANNOTATIONS') {
    if (!isFromActiveTab(sender)) return false;
    handlePageRequest(message).then(sendResponse);
    return true;
  }
  if (message.sourceTabId !== activeTabId || message.sourceWindowId !== panelWindowId) return false;
  console.log('[SidePanel] Received message:', message.type);

  switch (message.type) {
    case 'SHOW_NOTIFICATION':
      if (typeof message.message === 'string' && message.message.trim()) {
        const type = ['info', 'success', 'warning', 'error'].includes(message.notificationType)
          ? message.notificationType : 'info';
        showNotification(message.message, type);
      }
      break;

    case 'MODE_CHANGED':
      currentMode = message.mode;
      updateToolsButtonState();
      if (message.mode === 'comment' || message.mode === 'drawing') {
        showNotification(`${message.mode === 'comment' ? 'Comment' : 'Rectangle'} mode active - click on page`, 'info');
      }
      break;
  }

  return true;
}

// Saves only come from the top frame of the tab and site this panel is showing.
function isFromActiveTab(sender) {
  return sender.id === chrome.runtime.id && sender.tab?.id === activeTabId &&
    sender.tab.windowId === panelWindowId && (sender.frameId ?? 0) === 0 &&
    !!panelOrigin && tabOrigin(sender.tab.url) === panelOrigin;
}

async function handlePageRequest(message) {
  const folderName = message.annotation?.folderName;
  const store = annotationStore;
  if (!store) return { success: false, error: 'Connect a project in the Drawbridge side panel.', folderName };
  try {
    if (message.type === 'LIST_ANNOTATIONS') {
      return { success: true, tasks: await store.loadTasksFromFile() };
    }
    const saved = await store.saveAnnotation(message.annotation, message.taskData);
    showNotification('Annotation saved', 'success');
    requestTasks();
    return { success: true, folderName: saved.folderName };
  } catch (error) {
    return { success: false, error: error.message, folderName: message.annotation?.folderName };
  }
}

// Communication with Content Script
let lastErrorTime = 0;
let contentScriptReady = false;

async function sendToContentScript(message, showError = true) {
  const epoch = tabEpoch;
  try {
    if (!globalThis.chrome?.tabs?.query) {
      contentScriptReady = false;
      updatePageStatus();
      return null;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (epoch !== tabEpoch || !tab?.id || tab.id !== activeTabId) {
      console.warn('[SidePanel] No active tab');
      return null;
    }

    // Check for restricted pages
    const restrictedSchemes = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://'];
    if (tab.url && restrictedSchemes.some(scheme => tab.url.startsWith(scheme))) {
      return null;
    }

    if (!globalThis.chrome?.tabs?.sendMessage || !globalThis.chrome?.runtime) {
      contentScriptReady = false;
      updatePageStatus();
      return null;
    }

    return await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (epoch !== tabEpoch || tab.id !== activeTabId) { resolve(null); return; }
        const runtime = globalThis.chrome?.runtime;
        if (!runtime || runtime.lastError) {
          if (runtime?.lastError) console.warn('[SidePanel] Send failed:', runtime.lastError.message);
          contentScriptReady = false;
          updatePageStatus();
          // Debounce error notifications (only show once per 5 seconds)
          const now = Date.now();
          if (showError && now - lastErrorTime > 5000) {
            lastErrorTime = now;
            showNotification('Page needs refresh to connect', 'error');
          }
          resolve(null);
        } else {
          contentScriptReady = true;
          updatePageStatus();
          resolve(response);
        }
      });
    });
  } catch (error) {
    if (epoch === tabEpoch) {
      contentScriptReady = false;
      updatePageStatus();
    }
    console.warn('[SidePanel] Error sending message:', error);
    return null;
  }
}

// Ping content script to check if it's ready
async function pingContentScript() {
  const epoch = tabEpoch;
  try {
    if (!globalThis.chrome?.tabs?.query) return false;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (epoch !== tabEpoch || !tab?.id || tab.id !== activeTabId) return false;

    const restrictedSchemes = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://'];
    if (tab.url && restrictedSchemes.some(scheme => tab.url.startsWith(scheme))) {
      return false;
    }

    if (!globalThis.chrome?.tabs?.sendMessage || !globalThis.chrome?.runtime) return false;
    return await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'ping' }, (response) => {
        if (epoch !== tabEpoch || tab.id !== activeTabId) { resolve(false); return; }
        if (!globalThis.chrome?.runtime || chrome.runtime.lastError) {
          resolve(false);
        } else {
          resolve(response?.ready === true);
        }
      });
    });
  } catch {
    return false;
  }
}

// Retry connection with backoff
async function connectWithRetry(maxRetries = 3) {
  const epoch = tabEpoch;
  for (let i = 0; i < maxRetries; i++) {
    const ready = await pingContentScript();
    if (epoch !== tabEpoch) return false;
    if (ready) {
      contentScriptReady = true;
      updatePageStatus();
      return true;
    }
    // Wait before retry (200ms, 400ms, 800ms)
    await new Promise(r => setTimeout(r, 200 * Math.pow(2, i)));
  }
  contentScriptReady = false;
  updatePageStatus();
  return false;
}

// Update UI based on page connection status
function updatePageStatus() {
  // Don't disable buttons - we'll handle connection issues when user clicks
  // This provides a better UX than showing disabled buttons
}

async function requestTasks() {
  const store = annotationStore;
  if (!store) return;
  try {
    const loaded = await store.loadTasksFromFile();
    if (store !== annotationStore) return;
    tasks = loaded;
    renderTasks();
    updateBadges();
  } catch (error) {
    if (store === annotationStore) showNotification(`Could not load tasks: ${error.message}`, 'error');
  }
}

// UI Updates
function updateConnectionBanner() {
  if (isConnected) {
    connectionBanner.classList.remove('disconnected');
    connectionBanner.classList.add('connected');
    statusText.textContent = projectPath || 'Connected';
  } else {
    connectionBanner.classList.remove('connected');
    connectionBanner.classList.add('disconnected');
  }
  const offer = !isConnected ? folderOffer : null;
  reuseBtn.style.display = offer ? 'block' : 'none';
  reuseBtn.textContent = offer ? `${offer.reconnect ? 'Reconnect' : 'Use'} ${offer.path}` : '';
  reuseBtn.title = reuseBtn.textContent;
  connectBtn.style.display = offer ? 'none' : '';
  chooseBtn.style.display = offer ? 'flex' : 'none';
}

function setActiveTab(status) {
  currentTab = status;
  tabs.forEach(tab => {
    const selected = tab.dataset.status === status;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-pressed', selected);
  });
  renderTasks();
}

function updateBadges() {
  const counts = {
    'to do': 0,
    'doing': 0,
    'done': 0
  };

  tasks.forEach(task => {
    const status = (task.status || 'to do').toLowerCase();
    if (counts.hasOwnProperty(status)) {
      counts[status]++;
    }
  });

  todoBadge.textContent = counts['to do'];
  todoBadge.style.display = counts['to do'] > 0 ? 'inline' : 'none';

  doingBadge.textContent = counts['doing'];
  doingBadge.style.display = counts['doing'] > 0 ? 'inline' : 'none';

  doneBadge.textContent = counts['done'];
  doneBadge.style.display = counts['done'] > 0 ? 'inline' : 'none';
}

// Task Rendering
function renderTasks() {
  // Show connect prompt if not connected (whether or not content script is ready)
  if (!isConnected) {
    taskContainer.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
        </svg>
        <p>Connect a project to get started</p>
        <p class="hint">${folderOffer ? 'Use the folder above, or choose another' : 'Click "Connect Project" to select a folder'}</p>
      </div>
    `;
    return;
  }

  const filteredTasks = tasks.filter(task => {
    const taskStatus = (task.status || 'to do').toLowerCase();
    return taskStatus === currentTab;
  });

  if (filteredTasks.length === 0) {
    const emptyMessages = {
      'to do': 'No recorded tasks',
      'doing': 'No tasks in progress',
      'done': 'No completed tasks'
    };
    taskContainer.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
        </svg>
        <p>${emptyMessages[currentTab] || 'No tasks'}</p>
        <p class="hint">Use + Add to annotate elements on the page</p>
      </div>
    `;
    return;
  }

  // Sort tasks chronologically (oldest first)
  const sortedTasks = [...filteredTasks].sort((a, b) => {
    return (a.timestamp || a.createdAt || 0) - (b.timestamp || b.createdAt || 0);
  });

  taskContainer.innerHTML = sortedTasks.map(task => renderTaskCard(task)).join('');

  // Load thumbnails for tasks with screenshots
  loadThumbnails();

  // Add event listeners to task cards
  addTaskEventListeners();
}

function addTaskEventListeners() {
  taskContainer.querySelectorAll('.task-card').forEach(card => {
    const taskId = card.dataset.taskId;

    // Status dropdown
    const statusSelect = card.querySelector('.status-select');
    if (statusSelect) {
      statusSelect.addEventListener('change', async (e) => {
        try {
          await annotationStore.updateTaskStatusAndSave(taskId, e.target.value);
          await requestTasks();
        } catch (error) {
          showNotification(`Could not update task: ${error.message}`, 'error');
        }
      });
    }

    // Delete button (on card or thumbnail)
    card.querySelectorAll('.delete-btn, .thumbnail-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm('Delete this task and its saved files?')) {
          try {
            if (!await annotationStore?.removeTaskAndSave(taskId)) {
              throw new Error('Task not found. Refresh and try again.');
            }
            await requestTasks();
          } catch (error) {
            showNotification(`Could not delete task: ${error.message}`, 'error');
          }
        }
      });
    });
  });
}

// Load thumbnails for tasks with screenshots
async function loadThumbnails() {
  const store = annotationStore;
  const thumbnailContainers = taskContainer.querySelectorAll('.thumbnail-container');

  for (const container of thumbnailContainers) {
    const screenshotPath = container.dataset.screenshotPath;
    if (!screenshotPath) continue;

    if (!thumbnailCache.has(screenshotPath)) {
      try {
        const dataUrl = await readDataUrl(await store.getImageFile(screenshotPath));
        if (store !== annotationStore) return;
        thumbnailCache.set(screenshotPath, dataUrl);
      } catch (error) {
        console.warn('Failed to load thumbnail:', error);
        continue;
      }
    }
    setThumbnailSrc(container, thumbnailCache.get(screenshotPath));
  }
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function setThumbnailSrc(container, src) {
  const img = container.querySelector('.thumbnail-img');
  if (img) {
    img.src = src;
    img.style.display = 'block';
  }
}

function renderTaskCard(task) {
  const statusClass = (task.status || 'to do').toLowerCase().replace(' ', '-');
  const timestamp = task.timestamp || task.createdAt;
  const timeAgo = timestamp ? formatTime(timestamp) : '';
  const hasScreenshot = !!task.screenshotPath;
  const isCompleted = task.status === 'done';

  // Calculate thumbnail focus point if available
  let thumbnailStyle = '';
  if (hasScreenshot && task.clickPosition && task.screenshotViewport) {
    const clickAbsoluteX = (task.boundingRect?.x || 0) + (task.clickPosition?.x || 0);
    const clickAbsoluteY = (task.boundingRect?.y || 0) + (task.clickPosition?.y || 0);
    const clickInViewportX = clickAbsoluteX - (task.screenshotViewport?.x || 0);
    const clickInViewportY = clickAbsoluteY - (task.screenshotViewport?.y || 0);
    const xPercent = (clickInViewportX / (task.screenshotViewport?.width || 1)) * 100;
    const yPercent = (clickInViewportY / (task.screenshotViewport?.height || 1)) * 100;
    thumbnailStyle = `object-position: ${xPercent}% ${yPercent}%;`;
  }

  return `
    <div class="task-card status-${escapeHtml(statusClass)} ${isCompleted ? 'completed' : ''}" data-task-id="${escapeHtml(task.id)}">
      <div class="task-layout">
        <div class="task-content-area">
          <div class="task-header">
            <span class="task-time">${timeAgo}</span>
            ${!hasScreenshot ? `
              <button type="button" class="delete-btn" title="Delete task and files" aria-label="Delete task and files">
                ${trashIcon}
              </button>
            ` : ''}
          </div>
          <div class="task-content">${escapeHtml(task.comment || task.content || 'No comment')}</div>
          ${task.selector ? `<div class="task-selector">${escapeHtml(task.selector)}</div>` : ''}
        </div>
        ${hasScreenshot ? `
          <div class="thumbnail-container" data-task-id="${escapeHtml(task.id)}" data-screenshot-path="${escapeHtml(task.screenshotPath)}">
            <img class="thumbnail-img" style="${thumbnailStyle} display: none;" alt="Screenshot" />
            <button type="button" class="thumbnail-delete-btn" title="Delete task and files" aria-label="Delete task and files">
              ${trashIcon}
            </button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(text) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, character => entities[character]);
}

// Tools Menu
function toggleToolsMenu() {
  toolsMenu.classList.toggle('hidden');
}

function hideToolsMenu() {
  toolsMenu.classList.add('hidden');
}

// Project Menu
function toggleProjectMenu() {
  projectMenu.classList.toggle('hidden');
  hideToolsMenu();
}

function hideProjectMenu() {
  projectMenu.classList.add('hidden');
}

function updateToolsButtonState() {
  if (currentMode) {
    toolsBtn.title = currentMode === 'screen' ? 'Screen feedback open' :
      `${currentMode === 'comment' ? 'Comment' : 'Rectangle'} mode active`;
  } else {
    toolsBtn.title = 'Add annotation';
  }

  // Update menu items
  toolsMenu.querySelectorAll('.menu-item').forEach(item => {
    const action = item.dataset.action;
    const isActive = (action === 'comment' && currentMode === 'comment') ||
                     (action === 'rectangle' && currentMode === 'drawing') ||
                     (action === 'screen' && currentMode === 'screen');
    item.classList.toggle('active', isActive);
  });
}

// Theme
async function loadTheme() {
  const result = await chrome.storage.local.get('theme');
  const theme = result.theme || 'light';
  document.documentElement.setAttribute('data-theme', theme);
}

async function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  await chrome.storage.local.set({ theme: next });
}

// Notifications
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;

  notificationContainer.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('removing');
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}
