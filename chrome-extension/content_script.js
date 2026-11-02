// Drawbridge content script
(function() {
  const contentScriptBuild = DrawbridgeBuildInfo.getContentScriptBuild(
    chrome.runtime.getManifest().version
  );

  if (window.__drawbridgeContentScriptBuild === contentScriptBuild) {
    return;
  }

  if (window.__drawbridgeContentScriptLoaded) {
    // An older build is already live in this page. Its event handlers cannot be
    // swapped out in place, so reload once to load the fresh code instead of
    // silently running stale handlers. The per-build sessionStorage flag makes
    // this a single reload and guards against any reload loop.
    const RELOAD_FLAG = '__drawbridgeReloadedForBuild';
    try {
      if (sessionStorage.getItem(RELOAD_FLAG) !== contentScriptBuild) {
        sessionStorage.setItem(RELOAD_FLAG, contentScriptBuild);
        console.warn(
          '[Drawbridge] New build (%s) detected; reloading page to apply it.',
          contentScriptBuild
        );
        location.reload();
        return;
      }
    } catch (e) {
      // sessionStorage may be unavailable (sandboxed frames); fall through.
    }

    window.__drawbridgeNeedsRefresh = true;
    console.warn(
      '[Drawbridge] Extension updated (%s). Refresh this page (Ctrl+Shift+R) to enable deep select.',
      contentScriptBuild
    );
    return;
  }

  window.__drawbridgeContentScriptLoaded = true;
  window.__drawbridgeContentScriptBuild = contentScriptBuild;

  // Host-app modals with a focus trap (e.g. Radix Dialog / focus-lock) reclaim focus
  // whenever it leaves their subtree. Drawbridge's inputs live at <body> level (light DOM),
  // so the trap steals focus the instant you click the comment box -> you can't type.
  // Fix: capture-phase guard that stops focus events on Drawbridge nodes from reaching the
  // app's document-level handlers. Capture runs before the app's bubble-phase focusin handler,
  // and we only stop events originating inside Drawbridge UI, so the app's own focus is untouched.
  const __moatNodeSelector = '[id^="moat-"],[class*="moat"],[class*="float-comment"]';
  for (const __type of ['focusin', 'focusout']) {
    document.addEventListener(__type, (e) => {
      const isDrawbridgeNode = (node) =>
        node instanceof Element && !!node.closest(__moatNodeSelector);
      // focusout originates on the host input when focus enters our editor.
      // Traps inspect relatedTarget and can reclaim focus before focusin fires.
      if (isDrawbridgeNode(e.target) ||
          (__type === 'focusout' && isDrawbridgeNode(e.relatedTarget))) {
        e.stopImmediatePropagation();
      }
    }, true);
  }

  let sidePanelConnections = 0;
  let commentMode = false;
  let hoveredElement = null;
  let commentBox = null;
  let screenBackdrop = null;
  let screenCapturePending = false;
  let annotationCapturePending = false;
  let commentCaptureVersion = 0;
  let highlightedElement = null;
  let deepSelectIndex = 0;
  let pickStack = [];
  let lastPointer = { x: 0, y: 0 };
  let drilledOnPointerdown = false;
  // Track Control via keydown — macOS Ctrl+Click becomes right-click and drops ctrlKey.
  let controlKeyHeld = false;
  let lastTopPickElement = null;

  // Drawing mode state (for free-form rectangle tool)
  let drawingMode = false;
  let drawingTool = null; // Current active tool ('rectangle', 'arrow', etc.)
  let drawingCanvas = null; // Canvas overlay element
  let drawingCtx = null; // Canvas 2D context
  let isDrawing = false; // Whether currently drawing
  let drawStartX = 0;
  let drawStartY = 0;
  let currentRect = null; // Current rectangle being drawn {x, y, width, height}

  // Drawing tools registry (extensible for future tools)
  const drawingTools = {
    rectangle: {
      name: 'rectangle',
      cursor: 'crosshair',
      draw: function(ctx, x, y, width, height) {
        ctx.strokeStyle = '#F59E0B';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
        ctx.fillStyle = 'rgba(245, 158, 11, 0.1)';
        ctx.fillRect(x, y, width, height);
      }
    }
    // Future tools can be added here:
    // arrow: { ... },
    // connector: { ... }
  };

  // Generate unique session ID
  const sessionId = `moat-session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Convert annotation format to TaskStore format (Task 2.1)
  function convertAnnotationToTask(annotation, screenshotPath = '') {
    // Generate a clean title from element label and comment
    // For freeform rectangles, use a default title
    const title = annotation.elementLabel || (annotation.selectorMethod === 'freeform' ? 'Freeform Rectangle Task' : 'UI Element Task');
    
    // Handle bounding rect - support both formats
    let boundingRect;
    if (annotation.boundingBox && annotation.boundingBox.type === 'freeform') {
      // Freeform rectangle - use xywh format
      boundingRect = {
        x: annotation.boundingBox.xywh.x,
        y: annotation.boundingBox.xywh.y,
        w: annotation.boundingBox.xywh.width,
        h: annotation.boundingBox.xywh.height
      };
    } else if (annotation.boundingRect) {
      // Standard element bounding rect
      boundingRect = {
        x: annotation.boundingRect.x,
        y: annotation.boundingRect.y,
        w: annotation.boundingRect.width || annotation.boundingRect.w,
        h: annotation.boundingRect.height || annotation.boundingRect.h
      };
    } else {
      // Fallback
      boundingRect = { x: 0, y: 0, w: 0, h: 0 };
    }

    // For freeform rectangles, selector can be null or a special value
    const selector = annotation.target || (annotation.selectorMethod === 'freeform' ? 'freeform' : null);

    const taskData = {
      title: title,
      comment: annotation.content,
      selector: selector,
      boundingRect: boundingRect,
      screenshotPath: screenshotPath || ''
    };

    // Pasted clipboard reference images (paths under ./screenshots), if any
    if (annotation.attachments?.length) {
      taskData.attachments = annotation.attachments;
    }

    // Add bounding box data for freeform rectangles (preserve all formats)
    if (annotation.boundingBox && annotation.boundingBox.type === 'freeform') {
      taskData.boundingBox = annotation.boundingBox;
    }

    return taskData;
  }

  // Page scripts can dispatch events on the editor, so only a real user action may submit it.
  function isUserAction(event) {
    return event.isTrusted;
  }

  // Let the user move an open editor off whatever it covers. `translate` suits both the fixed and
  // the centered editor, and leaves `transform` free for the shake animation.
  function enableCommentBoxDrag(box) {
    const handle = document.createElement('div');
    handle.className = 'float-comment-drag-handle';
    handle.title = 'Drag to move';
    box.prepend(handle);

    let offsetX = 0;
    let offsetY = 0;
    let drag = null;
    // Keep the caret in the textarea while dragging.
    handle.addEventListener('mousedown', e => e.preventDefault());
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      handle.setPointerCapture(e.pointerId);
      drag = { pointerX: e.clientX, pointerY: e.clientY, offsetX, offsetY, rect: box.getBoundingClientRect() };
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      // The whole editor stays in the viewport so its handle can't be lost.
      const { rect } = drag;
      offsetX = drag.offsetX + Math.min(Math.max(e.clientX - drag.pointerX, -rect.left), window.innerWidth - rect.right);
      offsetY = drag.offsetY + Math.min(Math.max(e.clientY - drag.pointerY, -rect.top), window.innerHeight - rect.bottom);
      box.style.translate = `${offsetX}px ${offsetY}px`;
    });
    handle.addEventListener('lostpointercapture', () => { drag = null; });
  }

  // Keep the editor and its images available when any part of the save fails.
  async function submitCommentAnnotation(box, annotation) {
    if (box.isSubmitting) return false;
    box.isSubmitting = true;
    annotation.timestamp = box.annotationTimestamp ?? (box.annotationTimestamp = annotation.timestamp ?? Date.now());
    if (box.annotationFolderName) annotation.folderName = box.annotationFolderName;
    const submit = box.querySelector('.float-comment-submit');
    submit.disabled = true;
    const errorSlot = box.querySelector('.float-comment-error');
    if (errorSlot) errorSlot.textContent = '';
    try {
      Object.assign(annotation, await box.frameworkContext);
      await addToQueue(annotation);
      return true;
    } catch (error) {
      console.error('Moat: Annotation save failed:', error);
      const message = `Could not save annotation: ${error.message} Your comment and images are still here; retry when ready.`;
      showNotification(message, 'error');
      if (errorSlot) errorSlot.textContent = message;
      return false;
    } finally {
      box.annotationFolderName = annotation.folderName;
      box.isSubmitting = false;
      submit.disabled = false;
    }
  }

  // Wire clipboard-image paste onto a comment box's textarea: store image data
  // URLs on box.pastedImages and render removable thumbnails. Text paste is
  // left untouched (we only intercept when the clipboard carries an image).
  function enablePasteImages(box, textarea) {
    box.pastedImages = [];
    const strip = box.querySelector('.float-comment-attachments');

    const render = () => {
      if (!strip) return;
      strip.replaceChildren();
      box.pastedImages.forEach((dataUrl, index) => {
        const thumb = document.createElement('div');
        thumb.className = 'float-comment-thumb';

        const img = document.createElement('img');
        img.src = dataUrl;
        thumb.appendChild(img);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'float-comment-thumb-remove';
        remove.textContent = '×';
        remove.title = 'Remove';
        remove.addEventListener('click', () => {
          box.pastedImages.splice(index, 1);
          render();
        });
        thumb.appendChild(remove);

        strip.appendChild(thumb);
      });
    };

    textarea.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageItems = [...items].filter(item => item.type.startsWith('image/'));
      if (!imageItems.length) return; // no image on clipboard → normal text paste
      e.preventDefault();
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          box.pastedImages.push(reader.result);
          render();
        };
        reader.readAsDataURL(file);
      }
    });
  }

  /**
   * Capture screenshot using Chrome's native API and crop to specified region
   * @param {Object} captureArea - { x, y, width, height } in viewport/CSS pixels
   * @param {number} padding - Padding already included in captureArea (for metadata)
   * @returns {Promise<{dataUrl: string, viewport: Object}|null>}
   */
  async function captureScreenshotNative(captureArea, padding = 100) {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) return null;

    return new Promise((resolve) => {
      runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
        if (runtime.lastError) {
          console.warn('Screenshot message failed:', runtime.lastError);
          resolve(null);
          return;
        }
        
        if (!response?.success || !response?.dataUrl) {
          console.warn('Native screenshot capture failed:', response?.error);
          resolve(null);
          return;
        }

        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const scale = window.devicePixelRatio || 1;

            // Calculate crop coordinates (captureArea is in CSS pixels, image is in device pixels)
            const cropX = Math.max(0, Math.round(captureArea.x * scale));
            const cropY = Math.max(0, Math.round(captureArea.y * scale));
            const cropW = Math.min(Math.round(captureArea.width * scale), img.width - cropX);
            const cropH = Math.min(Math.round(captureArea.height * scale), img.height - cropY);

            if (cropW <= 0 || cropH <= 0) {
              console.warn('Invalid crop dimensions');
              resolve(null);
              return;
            }

            canvas.width = cropW;
            canvas.height = cropH;

            ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

            resolve({
              dataUrl: canvas.toDataURL('image/png'),
              viewport: {
                x: captureArea.x,
                y: captureArea.y,
                width: captureArea.width,
                height: captureArea.height,
                padding: padding
              }
            });
          } catch (e) {
            console.error('Screenshot crop failed:', e);
            resolve(null);
          }
        };

        img.onerror = () => {
          console.error('Failed to load screenshot image');
          resolve(null);
        };

        img.src = response.dataUrl;
      });
    }).catch(error => {
      console.warn('Screenshot message failed:', error);
      return null;
    });
  }

  // Folder access lives in the side panel, so requests fail if it is closed or showing another tab.
  function sendToSidePanel(message) {
    const unavailable = 'Open the Drawbridge side panel on this tab, then retry.';
    return new Promise((resolve, reject) => {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.sendMessage) {
        reject(new Error(unavailable));
        return;
      }
      try {
        runtime.sendMessage(message, response => {
          if (runtime.lastError || !response) reject(new Error(unavailable));
          else resolve(response);
        });
      } catch {
        reject(new Error(unavailable)); // Reloaded extensions leave old page scripts without a usable runtime.
      }
    });
  }

  // Read React and Next.js details for an annotation. Resolves with null on any
  // failure or after the time limit, so a save is never delayed for long or blocked.
  function captureFrameworkContext(element = null) {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) return Promise.resolve(null);
    const marker = element ? `drawbridge-${Date.now()}-${Math.random().toString(36).slice(2)}` : null;
    element?.setAttribute('data-drawbridge-inspect', marker);
    let timeout;
    return new Promise(resolve => {
      timeout = setTimeout(() => resolve(null), 3000);
      try {
        runtime.sendMessage({ type: 'CAPTURE_FRAMEWORK_CONTEXT', marker }, response => {
          resolve(runtime.lastError ? null : response || null);
        });
      } catch {
        resolve(null); // Reloaded extensions leave old page scripts without a usable runtime.
      }
    }).finally(() => {
      clearTimeout(timeout);
      element?.removeAttribute('data-drawbridge-inspect');
    });
  }

  // Show notifications in the native side panel.
  function showNotification(message, type = 'info') {
    relayToSidePanel({ type: 'SHOW_NOTIFICATION', message, notificationType: type });
  }

  // Add annotation to queue
  async function addToQueue(annotation) {
    const result = await sendToSidePanel({
      type: 'SAVE_ANNOTATION', annotation, taskData: convertAnnotationToTask(annotation)
    });
    // Retries reuse the folder chosen by the panel, including after a partial write.
    annotation.folderName = result.folderName ?? annotation.folderName;
    if (!result.success) throw new Error(result.error);
  }

  // Get user-friendly element label
  function getElementLabel(element) {
    const tagName = element.tagName.toLowerCase();
    
    // For links
    if (tagName === 'a') {
      const text = element.textContent.trim();
      return text ? `Link: ${text}` : 'Link';
    }
    
    // For buttons
    if (tagName === 'button' || element.type === 'button') {
      const text = element.textContent.trim();
      return text ? `Button: ${text}` : 'Button';
    }
    
    // For inputs
    if (tagName === 'input') {
      const type = element.type || 'text';
      const placeholder = element.placeholder;
      const label = element.getAttribute('aria-label') || placeholder;
      return label ? `Input (${type}): ${label}` : `Input (${type})`;
    }
    
    // For images
    if (tagName === 'img') {
      const alt = element.alt;
      return alt ? `Image: ${alt}` : 'Image';
    }
    
    // For divs and containers
    if (tagName === 'div' || tagName === 'section' || tagName === 'article' || tagName === 'main') {
      const role = element.getAttribute('role');
      const ariaLabel = element.getAttribute('aria-label');
      const id = element.id;
      
      if (role) return `Container (${role})`;
      if (ariaLabel) return `Container: ${ariaLabel}`;
      if (id) return `Container #${id}`;
      
      // Check for common class patterns
      const classes = element.className.split(' ').filter(c => c && !c.startsWith('moat-'));
      if (classes.includes('header')) return 'Header Container';
      if (classes.includes('footer')) return 'Footer Container';
      if (classes.includes('sidebar')) return 'Sidebar Container';
      if (classes.includes('nav') || classes.includes('navigation')) return 'Navigation Container';
      if (classes.includes('content') || classes.includes('main')) return 'Main Container';
      
      // If it has background color or image, label it as such
      const computedStyle = window.getComputedStyle(element);
      if (computedStyle.backgroundImage !== 'none') return 'Background Container';
      if (computedStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && 
          computedStyle.backgroundColor !== 'transparent') return 'Colored Container';
      
      return 'Container';
    }
    
    // For lists
    if (tagName === 'ul' || tagName === 'ol') {
      return 'List';
    }
    
    if (tagName === 'li') {
      const text = element.textContent.trim().substring(0, 20);
      return text ? `List Item: ${text}${text.length > 20 ? '...' : ''}` : 'List Item';
    }
    
    // For elements with aria-label
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) {
      return `${tagName}: ${ariaLabel}`;
    }
    
    // For elements with text content
    const text = element.textContent.trim().substring(0, 30);
    if (text) {
      return `${tagName}: ${text}${text.length > 30 ? '...' : ''}`;
    }
    
    // Default - capitalize tag name
    return tagName.charAt(0).toUpperCase() + tagName.slice(1);
  }

  // Get CSS selector for element
  function getSelector(element) {
    // First, check for ID
    if (element.id) {
      return `#${element.id}`;
    }
    
    const tagName = element.tagName.toLowerCase();
    
    // For links, try href attribute
    if (tagName === 'a' && element.href) {
      const href = element.getAttribute('href');
      if (href && href !== '#') {
        return `a[href="${href}"]`;
      }
    }
    
    // Check for unique attributes
    const uniqueAttributes = ['data-testid', 'data-id', 'data-component', 'aria-label', 'name', 'role'];
    for (const attr of uniqueAttributes) {
      const value = element.getAttribute(attr);
      if (value) {
        return `${tagName}[${attr}="${value}"]`;
      }
    }
    
    // For buttons/inputs with specific text
    if (tagName === 'button') {
      const text = element.textContent.trim();
      if (text && document.querySelectorAll(`button`).length > 1) {
        // Use nth-of-type to be more specific
        const parent = element.parentElement;
        const buttons = Array.from(parent.querySelectorAll('button'));
        const index = buttons.indexOf(element) + 1;
        if (index > 0) {
          return `${getSelector(parent)} > button:nth-of-type(${index})`;
        }
      }
    }
    
    // Build path-based selector
    const path = [];
    let current = element;
    
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      
      // Skip if we hit an element with ID
      if (current.id) {
        path.unshift(`#${current.id}`);
        break;
      }
      
      // For containers, try to use semantic selectors
      if (selector === 'div' || selector === 'section' || selector === 'article') {
        const role = current.getAttribute('role');
        const dataTestId = current.getAttribute('data-testid');
        
        if (role) {
          selector = `${selector}[role="${role}"]`;
        } else if (dataTestId) {
          selector = `${selector}[data-testid="${dataTestId}"]`;
        } else {
          // Add classes (but filter out moat classes and common utility classes)
          if (current.className && typeof current.className === 'string') {
            const classes = current.className
              .split(' ')
              .filter(c => c && !c.startsWith('moat-') && !c.match(/^(w-|h-|p-|m-|flex|grid|block|inline)/))
              .slice(0, 2); // Only use first 2 meaningful classes
            
            if (classes.length > 0) {
              selector += `.${classes.join('.')}`;
            }
          }
        }
      } else {
        // For non-containers, add classes
        if (current.className && typeof current.className === 'string') {
          const classes = current.className
            .split(' ')
            .filter(c => c && !c.startsWith('moat-'))
            .slice(0, 2);
          
          if (classes.length > 0) {
            selector += `.${classes.join('.')}`;
          }
        }
      }
      
      // Add nth-child if needed
      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children);
        const index = siblings.indexOf(current) + 1;
        
        // Only add nth-child if there are multiple siblings of same type
        const sameTags = siblings.filter(s => s.tagName === current.tagName);
        if (sameTags.length > 1) {
          selector += `:nth-child(${index})`;
        }
      }
      
      path.unshift(selector);
      current = current.parentElement;
    }
    
    // Return the path, limited to last 3 elements for brevity
    return path.slice(-3).join(' > ');
  }

  // Validate selector returns exactly one element
  function validateSelector(selector, targetElement) {
    try {
      const elements = document.querySelectorAll(selector);
      if (elements.length === 1 && elements[0] === targetElement) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Get enhanced element context
  function getElementContext(element) {
    return {
      tagName: element.tagName.toLowerCase(),
      text: element.textContent.trim().substring(0, 100),
      href: element.href || null,
      type: element.type || null,
      ariaLabel: element.getAttribute('aria-label') || null,
      dataTestId: element.getAttribute('data-testid') || null,
      className: element.className && typeof element.className === 'string' 
        ? element.className.split(' ').filter(c => c && !c.startsWith('moat-')).join(' ')
        : null
    };
  }

  // Create comment input box
  async function createCommentBox(element, x, y) {
    // If comment box already exists, shake it instead of creating new one
    if (commentBox) {
      shakeCommentBox();
      return;
    }
    if (screenCapturePending || annotationCapturePending) return;
    annotationCapturePending = true;
    const captureVersion = commentCaptureVersion;
    const frameworkContext = captureFrameworkContext(element);

    let screenshotData = null;
    try {
      // Let the selected element's overlay render before the screenshot.
      await new Promise(resolve => setTimeout(resolve, 50));
      if (captureVersion !== commentCaptureVersion) return;

      const rect = element.getBoundingClientRect();
      const padding = 100;
      
      // Calculate capture area in viewport coordinates
      const captureX = Math.max(0, rect.x - padding);
      const captureY = Math.max(0, rect.y - padding);
      const captureWidth = Math.min(rect.width + (padding * 2), window.innerWidth - captureX);
      const captureHeight = Math.min(rect.height + (padding * 2), window.innerHeight - captureY);
      
      console.log('📸 Capturing element screenshot at:', {
        element: element.tagName,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        captureArea: { x: captureX, y: captureY, w: captureWidth, h: captureHeight }
      });
      
      screenshotData = await captureScreenshotNative({
        x: captureX,
        y: captureY,
        width: captureWidth,
        height: captureHeight
      }, padding);
      
      if (screenshotData) {
        console.log('✅ Screenshot captured successfully');
      }
    } catch (e) {
      console.warn('Screenshot capture failed:', e);
    } finally {
      annotationCapturePending = false;
    }
    if (captureVersion !== commentCaptureVersion) return;
    
    // Keep the DOM overlay visible while user is commenting
    // Don't remove it - just store reference
    
    commentBox = document.createElement('div');
    commentBox.className = 'float-comment-box';
    commentBox.screenshotData = screenshotData; // Store for later use
    commentBox.frameworkContext = frameworkContext;
    commentBox.highlightedElement = element; // Store element reference
    commentBox.highlightOverlay = hoverOverlay; // Store overlay reference for cleanup
    commentBox.innerHTML = `
      <textarea
        class="float-comment-input"
        aria-label="Feedback description"
        placeholder="What needs to be changed? Markdown supported."
        autofocus
      ></textarea>
      <div class="float-comment-attachments"></div>
      <div class="float-comment-error" role="alert"></div>
      <div class="float-comment-actions">
        <button class="float-comment-cancel">Cancel</button>
        <button class="float-comment-submit" aria-label="Submit (Return)">Submit ⏎</button>
      </div>
    `;
    
    enableCommentBoxDrag(commentBox);

    // Append to shadow root for CSS isolation (if available), otherwise fallback to body
    const container = window.moatShadowRoot || document.body;
    container.appendChild(commentBox);
    
    // Position near cursor (using actual click coordinates)
    const boxWidth = 360;
    const boxHeight = 200; // Approximate height
    const padding = 10;
    
    // Calculate optimal position near cursor
    let left = x + padding;
    let top = y + padding;
    
    // Ensure comment box stays within viewport boundaries
    // Check right edge
    if (left + boxWidth > window.innerWidth) {
      left = x - boxWidth - padding; // Position to the left of cursor
    }
    
    // Check bottom edge
    if (top + boxHeight > window.innerHeight) {
      top = y - boxHeight - padding; // Position above cursor
    }
    
    // Check left edge (in case cursor is very close to left)
    if (left < padding) {
      left = padding;
    }
    
    // Check top edge (in case cursor is very close to top)
    if (top < padding) {
      top = padding;
    }
    
    // Apply position
    commentBox.style.left = `${left}px`;
    commentBox.style.top = `${top}px`;
    
    // Final adjustment after measuring actual box dimensions
    const boxRect = commentBox.getBoundingClientRect();
    if (boxRect.right > window.innerWidth) {
      commentBox.style.left = `${Math.max(padding, window.innerWidth - boxRect.width - padding)}px`;
    }
    if (boxRect.bottom > window.innerHeight) {
      commentBox.style.top = `${Math.max(padding, window.innerHeight - boxRect.height - padding)}px`;
    }
    
    const textarea = commentBox.querySelector('textarea');
    const submitBtn = commentBox.querySelector('.float-comment-submit');
    const cancelBtn = commentBox.querySelector('.float-comment-cancel');
    
    // Focus textarea
    setTimeout(() => textarea.focus(), 50);

    // Allow pasting reference images from the clipboard
    enablePasteImages(commentBox, textarea);
    
    // Handle submit
    const handleSubmit = async () => {
      const box = commentBox;
      if (!box || box.isSubmitting) return;
      const content = textarea.value.trim()
        || (commentBox.pastedImages?.length ? 'See pasted reference image(s).' : '');
      if (!content) return;
      
      const rect = element.getBoundingClientRect();
      const selector = getSelector(element);
      
      // Validate selector
      if (!validateSelector(selector, element)) {
        console.warn('Moat: Selector validation failed, using fallback');
      }
      
      // Calculate click position relative to element (for thumbnail centering)
      const clickX = x - rect.x;
      const clickY = y - rect.y;
      
      // Create annotation object
      const annotation = {
        type: "user_message",
        role: "user",
        content: content,
        target: selector,
        elementLabel: getElementLabel(element),
        elementContext: getElementContext(element),
        selectorMethod: "querySelector",
        boundingRect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        clickPosition: {
          x: Math.round(clickX),
          y: Math.round(clickY),
          elementWidth: Math.round(rect.width),
          elementHeight: Math.round(rect.height)
        },
        pageUrl: window.location.href,
        timestamp: Date.now(),
        sessionId: sessionId,
        status: "to do",
        id: box.annotationId || (box.annotationId = `moat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
      };
      
      // Use pre-captured screenshot (captured when comment box was created)
      if (commentBox.screenshotData) {
        annotation.screenshot = commentBox.screenshotData.dataUrl;
        annotation.screenshotViewport = commentBox.screenshotData.viewport;
        console.log('✅ Moat: Using pre-captured screenshot with visible highlight');
      } else {
        console.log('⚠️ Moat: No pre-captured screenshot available');
      }
      
      annotation.pastedImages = [...box.pastedImages];
      if (!await submitCommentAnnotation(box, annotation)) return;
      if (commentBox !== box) return;

      // Dismiss only after the annotation has been saved or queued.
      exitCommentMode();
    };
    
    // Event listeners
    submitBtn.addEventListener('click', e => (isUserAction(e) ? handleSubmit() : undefined));
    cancelBtn.addEventListener('click', exitCommentMode);
    
    textarea.addEventListener('keydown', (e) => {
      // Skip Enter while IME is composing (Japanese, Chinese, Korean, etc.)
      // keyCode === 229 covers older browsers where isComposing is unreliable on commit
      if (e.key === 'Enter' && isUserAction(e) && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
        exitCommentMode();
      }
    });
  }

  // Shake comment box to indicate it's already open
  function shakeCommentBox() {
    if (!commentBox) return;
    
    commentBox.classList.add('float-shake');
    setTimeout(() => {
      commentBox.classList.remove('float-shake');
    }, 500);
    
    // Also focus the textarea
    const textarea = commentBox.querySelector('textarea');
    if (textarea) textarea.focus();
  }

  // Remove comment box
  function removeCommentBox() {
    if (commentBox) {
      commentBox.remove();
      commentBox = null;
    }
    if (screenBackdrop) {
      screenBackdrop.remove();
      screenBackdrop = null;
    }
  }

  function closeScreenCommentBox() {
    if (!screenBackdrop || commentBox?.isSubmitting) return;
    const previousFocus = screenBackdrop.previousFocus;
    removeCommentBox();
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
      previousFocus.focus();
    }
    relayToSidePanel({ type: 'MODE_CHANGED', mode: null });
  }

  // Capture before showing the modal, so it does not appear in the image.
  async function createScreenCommentBox() {
    if (window.__drawbridgeNeedsRefresh) {
      return { success: false, error: 'Refresh the page for the latest Drawbridge.' };
    }
    if (commentBox) {
      shakeCommentBox();
      return { success: false, error: 'Finish or cancel the current annotation first.' };
    }
    if (screenCapturePending || annotationCapturePending || isDrawing) {
      return { success: false, error: 'Finish the current capture first.' };
    }
    if (document.hidden) {
      return { success: false, error: 'Return to the page before capturing the screen.' };
    }

    screenCapturePending = true;
    const frameworkContext = captureFrameworkContext();
    const previousFocus = document.activeElement;
    const pageUrl = window.location.href;
    const pageTitle = document.title;
    const scrollPosition = { x: window.scrollX, y: window.scrollY };
    const viewport = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    let pageWasHidden = false;
    const onVisibilityChange = () => { if (document.hidden) pageWasHidden = true; };
    const notifications = [...document.querySelectorAll('[data-drawbridge-notification]')].map(node => ({
      node, visibility: node.style.visibility
    }));
    document.addEventListener('visibilitychange', onVisibilityChange);

    try {
      const previousMode = commentMode || drawingMode;
      if (commentMode) exitCommentMode();
      if (drawingMode) exitDrawingMode();
      removeDrawingCanvas();
      if (previousMode) relayToSidePanel({ type: 'MODE_CHANGED', mode: null });
      for (const { node } of notifications) node.style.visibility = 'hidden';
      // Let Chrome paint the removed selection overlay and hidden notifications.
      await new Promise(resolve => setTimeout(resolve, 50));
      if (pageWasHidden || document.hidden) {
        return { success: false, error: 'The page changed during capture. Please try again.' };
      }

      const screenshotData = await captureScreenshotNative(viewport, 0);
      if (!screenshotData?.dataUrl) {
        return { success: false, error: 'Could not capture the screen. Please try again.' };
      }
      if (pageWasHidden || document.hidden || window.location.href !== pageUrl ||
          window.innerWidth !== viewport.width || window.innerHeight !== viewport.height ||
          window.scrollX !== scrollPosition.x || window.scrollY !== scrollPosition.y) {
        return { success: false, error: 'The page changed during capture. Please try again.' };
      }
      if (commentBox || commentMode || drawingMode || isDrawing) {
        if (commentBox) shakeCommentBox();
        return { success: false, error: 'Finish or cancel the current annotation first.' };
      }

      screenBackdrop = document.createElement('div');
      screenBackdrop.className = 'float-screen-backdrop';
      screenBackdrop.previousFocus = previousFocus;
      commentBox = document.createElement('div');
      commentBox.className = 'float-comment-box float-screen-comment-box';
      commentBox.frameworkContext = frameworkContext;
      commentBox.setAttribute('role', 'dialog');
      commentBox.setAttribute('aria-modal', 'true');
      commentBox.setAttribute('aria-label', 'Screen feedback');
      commentBox.innerHTML = `
        <textarea
          class="float-comment-input"
          aria-label="Feedback description"
          placeholder="What needs to be changed? Markdown supported."
        ></textarea>
        <div class="float-comment-attachments"></div>
        <div class="float-comment-error" role="alert"></div>
        <div class="float-comment-actions">
          <button type="button" class="float-comment-cancel">Cancel</button>
          <button type="button" class="float-comment-submit" aria-label="Submit (Return)">Submit ⏎</button>
        </div>
      `;
      const box = commentBox;
      const textarea = box.querySelector('textarea');
      const submitBtn = box.querySelector('.float-comment-submit');
      const cancelBtn = box.querySelector('.float-comment-cancel');
      enableCommentBoxDrag(box);
      enablePasteImages(box, textarea);

      const handleSubmit = async () => {
        if (commentBox !== box || box.isSubmitting) return;
        const content = textarea.value.trim() ||
          (box.pastedImages?.length ? 'See pasted reference image(s).' : '');
        if (!content) return;
        const annotation = {
          type: 'user_message',
          role: 'user',
          content,
          target: null,
          elementLabel: 'Screen',
          selectorMethod: 'screen',
          boundingRect: viewport,
          pageUrl,
          pageTitle,
          scrollPosition,
          timestamp: Date.now(),
          sessionId,
          status: 'to do',
          id: box.annotationId || (box.annotationId = `moat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`),
          screenshot: screenshotData.dataUrl,
          screenshotViewport: screenshotData.viewport,
          pastedImages: [...box.pastedImages]
        };
        if (await submitCommentAnnotation(box, annotation) && commentBox === box) {
          closeScreenCommentBox();
        }
      };

      submitBtn.addEventListener('click', e => (isUserAction(e) ? handleSubmit() : undefined));
      cancelBtn.addEventListener('click', closeScreenCommentBox);
      textarea.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && isUserAction(e) && !e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeScreenCommentBox();
        }
      });
      box.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const active = (window.moatShadowRoot || document).activeElement;
        if (e.shiftKey && active === textarea) {
          e.preventDefault();
          (submitBtn.disabled ? cancelBtn : submitBtn).focus();
        } else if (!e.shiftKey && (active === submitBtn || (submitBtn.disabled && active === cancelBtn))) {
          e.preventDefault();
          textarea.focus();
        }
      });

      screenBackdrop.appendChild(box);
      (window.moatShadowRoot || document.body).appendChild(screenBackdrop);
      relayToSidePanel({ type: 'MODE_CHANGED', mode: 'screen' });
      setTimeout(() => { if (commentBox === box) textarea.focus(); }, 50);
      return { success: true };
    } catch (error) {
      if (screenBackdrop) removeCommentBox();
      console.error('Screen capture failed:', error);
      return { success: false, error: 'Could not capture the screen. Please try again.' };
    } finally {
      for (const { node, visibility } of notifications) node.style.visibility = visibility;
      screenCapturePending = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  }

  // Enter comment mode
  function enterCommentMode() {
    if (screenBackdrop || screenCapturePending) {
      if (commentBox) shakeCommentBox();
      return;
    }
    if (window.__drawbridgeNeedsRefresh) {
      showNotification('Refresh page (Ctrl+Shift+R) for latest Drawbridge', 'error');
      return;
    }
    commentMode = true;
    document.body.classList.add('float-comment-mode');
  }

  // Exit comment mode
  function exitCommentMode() {
    commentMode = false;
    commentCaptureVersion++;
    document.body.classList.remove('float-comment-mode');
    deepSelectIndex = 0;
    pickStack = [];
    lastTopPickElement = null;
    setDeepSelectActive(false);
    
    // The selected overlay and the current hover overlay may differ.
    if (commentBox?.highlightOverlay && commentBox.highlightOverlay !== hoverOverlay) {
      commentBox.highlightOverlay.remove();
    }
    
    removeCommentBox();
    removeHighlight();
  }

  // Create canvas overlay for drawing
  function createDrawingCanvas() {
    if (drawingCanvas) return; // Already exists
    
    drawingCanvas = document.createElement('canvas');
    drawingCanvas.id = 'float-drawing-canvas';
    drawingCanvas.className = 'float-drawing-canvas';
    drawingCanvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: 9999;
      background: transparent;
    `;
    
    // Set canvas size
    drawingCanvas.width = window.innerWidth;
    drawingCanvas.height = window.innerHeight;
    
    drawingCtx = drawingCanvas.getContext('2d');
    
    const container = window.moatShadowRoot || document.body;
    container.appendChild(drawingCanvas);
    
    // Set up mouse handlers
    setupDrawingHandlers();
    
    // Update canvas size on resize
    window.addEventListener('resize', updateCanvasSize);
  }

  // Update canvas size on window resize
  function updateCanvasSize() {
    if (!drawingCanvas) return;
    drawingCanvas.width = window.innerWidth;
    drawingCanvas.height = window.innerHeight;
  }

  // Remove canvas overlay
  function removeDrawingCanvas() {
    if (drawingCanvas) {
      window.removeEventListener('resize', updateCanvasSize);
      removeDrawingHandlers();
      drawingCanvas.remove();
      drawingCanvas = null;
      drawingCtx = null;
    }
  }

  // Enter drawing mode
  function enterDrawingMode(toolName = 'rectangle') {
    if (screenBackdrop || screenCapturePending) {
      if (commentBox) shakeCommentBox();
      return;
    }
    if (drawingMode) return; // Already in drawing mode
    
    // Exit comment mode if active
    if (commentMode) {
      exitCommentMode();
    }
    
    drawingMode = true;
    drawingTool = toolName;
    
    // Create canvas overlay
    createDrawingCanvas();
    
    // Enable pointer events on canvas when drawing
    if (drawingCanvas) {
      drawingCanvas.style.pointerEvents = 'auto';
    }
    
    // Add drawing mode class for cursor styling
    document.body.classList.add('float-drawing-mode');
    
    console.log(`🎨 Entered drawing mode with tool: ${toolName}`);
  }

  // Exit drawing mode
  function exitDrawingMode() {
    if (!drawingMode) return;
    
    drawingMode = false;
    drawingTool = null;
    isDrawing = false;
    currentRect = null;
    
    // Clear canvas
    if (drawingCtx && drawingCanvas) {
      drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    }
    
    // Disable pointer events
    if (drawingCanvas) {
      drawingCanvas.style.pointerEvents = 'none';
    }
    
    // Remove drawing mode class
    document.body.classList.remove('float-drawing-mode');
    
    // Remove canvas overlay (optional - can keep it for performance)
    // removeDrawingCanvas();
    
    console.log('🎨 Exited drawing mode');
  }

  // Create comment box for freeform rectangle
  async function createFreeformCommentBox(rectangleData, x, y) {
    // If comment box already exists, shake it instead of creating new one
    if (commentBox) {
      shakeCommentBox();
      return;
    }
    if (screenCapturePending || annotationCapturePending) return;
    annotationCapturePending = true;
    const frameworkContext = captureFrameworkContext();
    
    // Capture screenshot with rectangle drawn on canvas
    let screenshotData = null;
    try {
      // Draw final rectangle on canvas before capture (ensure it's visible)
      if (drawingCtx && drawingTool) {
        const tool = drawingTools[drawingTool];
        if (tool && tool.draw) {
          tool.draw(drawingCtx, rectangleData.x, rectangleData.y, rectangleData.width, rectangleData.height);
        }
      }
      
      // Brief delay to ensure canvas is rendered before capture
      await new Promise(resolve => setTimeout(resolve, 16));
      
      // Calculate capture area in viewport coordinates
      const padding = 100;
      const captureX = Math.max(0, rectangleData.x - padding);
      const captureY = Math.max(0, rectangleData.y - padding);
      const captureWidth = Math.min(rectangleData.width + (padding * 2), window.innerWidth - captureX);
      const captureHeight = Math.min(rectangleData.height + (padding * 2), window.innerHeight - captureY);
      
      console.log('📸 Capturing rectangle screenshot at:', {
        rect: rectangleData,
        captureArea: { x: captureX, y: captureY, w: captureWidth, h: captureHeight }
      });
      
      screenshotData = await captureScreenshotNative({
        x: captureX,
        y: captureY,
        width: captureWidth,
        height: captureHeight
      }, padding);
      
      if (screenshotData) {
        console.log('✅ Screenshot captured with rectangle');
      }
    } catch (e) {
      console.warn('Screenshot capture failed:', e);
    } finally {
      annotationCapturePending = false;
    }
    
    // Create comment box
    commentBox = document.createElement('div');
    commentBox.className = 'float-comment-box';
    commentBox.screenshotData = screenshotData;
    commentBox.frameworkContext = frameworkContext;
    commentBox.rectangleData = rectangleData; // Store rectangle data
    commentBox.innerHTML = `
      <textarea
        class="float-comment-input"
        aria-label="Feedback description"
        placeholder="What needs to be changed? Markdown supported."
        autofocus
      ></textarea>
      <div class="float-comment-attachments"></div>
      <div class="float-comment-error" role="alert"></div>
      <div class="float-comment-actions">
        <button class="float-comment-cancel">Cancel</button>
        <button class="float-comment-submit" aria-label="Submit (Return)">Submit ⏎</button>
      </div>
    `;
    
    enableCommentBoxDrag(commentBox);

    // Append to shadow root for CSS isolation (if available), otherwise fallback to body
    const container = window.moatShadowRoot || document.body;
    container.appendChild(commentBox);
    
    // Position near cursor (using actual mouse coordinates)
    const boxWidth = 360;
    const boxHeight = 200; // Approximate height
    const padding = 10;
    
    // Calculate optimal position near cursor
    let left = x + padding;
    let top = y + padding;
    
    // Ensure comment box stays within viewport boundaries
    if (left + boxWidth > window.innerWidth) {
      left = x - boxWidth - padding;
    }
    if (top + boxHeight > window.innerHeight) {
      top = y - boxHeight - padding;
    }
    if (left < padding) {
      left = padding;
    }
    if (top < padding) {
      top = padding;
    }
    
    // Apply position
    commentBox.style.left = `${left}px`;
    commentBox.style.top = `${top}px`;
    
    // Final adjustment after measuring actual box dimensions
    const boxRect = commentBox.getBoundingClientRect();
    if (boxRect.right > window.innerWidth) {
      commentBox.style.left = `${Math.max(padding, window.innerWidth - boxRect.width - padding)}px`;
    }
    if (boxRect.bottom > window.innerHeight) {
      commentBox.style.top = `${Math.max(padding, window.innerHeight - boxRect.height - padding)}px`;
    }
    
    const textarea = commentBox.querySelector('textarea');
    const submitBtn = commentBox.querySelector('.float-comment-submit');
    const cancelBtn = commentBox.querySelector('.float-comment-cancel');
    
    // Focus textarea
    setTimeout(() => textarea.focus(), 50);

    // Allow pasting reference images from the clipboard
    enablePasteImages(commentBox, textarea);
    
    // Handle submit
    const handleSubmit = async () => {
      const box = commentBox;
      if (!box || box.isSubmitting) return;
      const content = textarea.value.trim()
        || (commentBox.pastedImages?.length ? 'See pasted reference image(s).' : '');
      if (!content) return;
      
      // Get rectangle data from comment box
      const rectData = commentBox.rectangleData;
      
      // Create annotation object with freeform rectangle data
      const annotation = {
        type: "user_message",
        role: "user",
        content: content,
        target: null, // No element selector for freeform
        selectorMethod: "freeform",
        boundingRect: {
          x: Math.round(rectData.x),
          y: Math.round(rectData.y),
          w: Math.round(rectData.width),
          h: Math.round(rectData.height)
        },
        // Include all bounding box formats
        boundingBox: {
          xyxy: rectData.xyxy,
          xywh: {
            x: rectData.x,
            y: rectData.y,
            width: rectData.width,
            height: rectData.height
          },
          normalized: rectData.normalized,
          viewport: rectData.viewport,
          type: rectData.type
        },
        pageUrl: window.location.href,
        timestamp: Date.now(),
        sessionId: sessionId,
        status: "to do",
        id: box.annotationId || (box.annotationId = `moat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
      };
      
      // Use pre-captured screenshot
      if (commentBox.screenshotData) {
        annotation.screenshot = commentBox.screenshotData.dataUrl;
        annotation.screenshotViewport = commentBox.screenshotData.viewport;
        console.log('✅ Moat: Using pre-captured screenshot with rectangle');
      }
      
      annotation.pastedImages = [...box.pastedImages];
      if (!await submitCommentAnnotation(box, annotation)) return;
      if (commentBox !== box) return;

      // Clear canvas after submission
      if (drawingCtx && drawingCanvas) {
        drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
      }
      
      // Clean up drawing mode completely
      exitDrawingMode();
      removeDrawingCanvas();
      
      removeCommentBox();
    };
    
    // Event listeners
    submitBtn.addEventListener('click', e => (isUserAction(e) ? handleSubmit() : undefined));
    cancelBtn.addEventListener('click', () => {
      // Clear canvas and exit drawing mode
      if (drawingCtx && drawingCanvas) {
        drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
      }
      exitDrawingMode();
      removeDrawingCanvas();
      removeCommentBox();
    });
    
    textarea.addEventListener('keydown', (e) => {
      // Skip Enter/Escape while IME is composing (Japanese, Chinese, Korean, etc.)
      if (e.key === 'Enter' && isUserAction(e) && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
        // Clear canvas and exit drawing mode
        if (drawingCtx && drawingCanvas) {
          drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
        }
        exitDrawingMode();
        removeDrawingCanvas();
        removeCommentBox();
      }
    });
  }

  // Global hover overlay element
  let hoverOverlay = null;

  function getElementPicker() {
    return window.MoatElementPicker;
  }

  function setControlKeyHeld(held) {
    controlKeyHeld = !!held;
  }

  function isDeepSelectModifier(event) {
    const pickerApi = getElementPicker();
    if (pickerApi && typeof pickerApi.isDeepSelectControlActive === 'function') {
      return pickerApi.isDeepSelectControlActive(event, controlKeyHeld);
    }
    // Fallback if picker script failed to inject
    return !!(
      controlKeyHeld ||
      (event &&
        (event.ctrlKey ||
          (event.getModifierState && event.getModifierState('Control'))))
    );
  }

  // Capture Control held-state before OS remaps Ctrl+Click on macOS/Linux.
  document.addEventListener(
    'keydown',
    (e) => {
      const pickerApi = getElementPicker();
      if (pickerApi && typeof pickerApi.isControlKeyEvent === 'function') {
        if (pickerApi.isControlKeyEvent(e)) {
          setControlKeyHeld(true);
        }
        return;
      }
      if (e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight') {
        setControlKeyHeld(true);
      }
    },
    true
  );

  document.addEventListener(
    'keyup',
    (e) => {
      const pickerApi = getElementPicker();
      if (pickerApi && typeof pickerApi.isControlKeyEvent === 'function') {
        if (pickerApi.isControlKeyEvent(e)) {
          setControlKeyHeld(false);
        }
        return;
      }
      if (e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight') {
        setControlKeyHeld(false);
      }
    },
    true
  );

  window.addEventListener('blur', () => setControlKeyHeld(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      setControlKeyHeld(false);
    }
  });

  function setDeepSelectActive(active) {
    document.body.classList.toggle('float-deep-select-active', active);
  }

  function refreshPickAtPointer(clientX, clientY) {
    const pickerApi = getElementPicker();
    if (!pickerApi) {
      return null;
    }

    lastPointer = { x: clientX, y: clientY };

    const pick = pickerApi.pickElementAtPoint(clientX, clientY, deepSelectIndex);
    pickStack = pick.stack;

    if (!pick.element) {
      hoveredElement = null;
      removeHighlight();
      setDeepSelectActive(false);
      return null;
    }

    hoveredElement = pick.element;
    const isDeep = deepSelectIndex > 0 && pick.total > 1;
    highlightElement(pick.element, isDeep);
    setDeepSelectActive(isDeep);
    return pick.element;
  }

  function drillDeeperAtPointer() {
    const pickerApi = getElementPicker();
    if (!pickerApi) {
      console.warn('[Drawbridge] Deep select unavailable — MoatElementPicker missing. Refresh the page.');
      showNotification('Refresh page for deep select', 'error');
      return null;
    }

    // A tap or a click immediately after entering the mode may have no hover.
    // Recompute the stack at the actual gesture coordinates before cycling.
    refreshPickAtPointer(lastPointer.x, lastPointer.y);
    if (pickStack.length <= 1) {
      showNotification('Only one layer under cursor', 'info');
      console.info('[Drawbridge] Deep select: single layer at pointer');
      return null;
    }

    deepSelectIndex = pickerApi.cycleDepthIndex(deepSelectIndex, pickStack.length, 1);
    const element = refreshPickAtPointer(lastPointer.x, lastPointer.y);
    const pick = pickerApi.pickElementAtPoint(lastPointer.x, lastPointer.y, deepSelectIndex);

    console.info(
      '[Drawbridge] Deep select drill → layer',
      pick.depth + '/' + pick.total,
      pick.element?.tagName?.toLowerCase(),
      pick.element?.className || pick.element?.id || ''
    );
    showNotification(`Layer ${pick.depth}/${pick.total} — click to comment`, 'info');

    return element;
  }

  // Trackpads often skip pointerdown with ctrlKey; click may be the only signal.
  // pointerdown+click from a mouse should drill only once per gesture.
  function handleDeepSelectDrill() {
    return drillDeeperAtPointer();
  }

  // Highlight element on hover with DOM overlay
  function highlightElement(element, isDeepSelect = false) {
    removeHighlight();
    highlightedElement = element;
    
    // Create overlay div for both hover and click
    const rect = element.getBoundingClientRect();
    hoverOverlay = document.createElement('div');
    hoverOverlay.className = isDeepSelect
      ? 'float-hover-overlay float-hover-overlay-deep'
      : 'float-hover-overlay';
    const borderColor = isDeepSelect ? '#F59E0B' : '#3B82F6';
    const bgColor = isDeepSelect ? 'rgba(245, 158, 11, 0.12)' : 'rgba(59, 130, 246, 0.1)';
    hoverOverlay.style.cssText = `
      position: absolute;
      left: ${rect.x + window.scrollX}px;
      top: ${rect.y + window.scrollY}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 1px solid ${borderColor};
      border-radius: 0;
      background-color: ${bgColor};
      pointer-events: none;
      z-index: 9998;
      box-sizing: border-box;
    `;
    document.body.appendChild(hoverOverlay);
  }

  // Remove highlight
  function removeHighlight() {
    if (hoverOverlay) {
      hoverOverlay.remove();
      hoverOverlay = null;
    }
    highlightedElement = null;
  }

  // Export annotations
  async function exportAnnotations() {
    let queue;
    try {
      const result = await sendToSidePanel({ type: 'LIST_ANNOTATIONS' });
      if (!result.success) throw new Error(result.error);
      queue = result.tasks;
    } catch (error) {
      showNotification(`Could not export annotations: ${error.message}`, 'error');
      return false;
    }
    const exportData = {
      version: '1.0.0',
      sessionId,
      timestamp: Date.now(),
      url: window.location.href,
      protocol: 'file',
      annotations: queue
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `moat-annotations-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    showNotification(`Exported ${queue.length} annotations`);
    return true;
  }

  // Mouse move handler
  document.addEventListener('mousemove', (e) => {
    if (!commentMode || commentBox || annotationCapturePending) return;

    // Use composedPath() to properly detect if hovering over Shadow DOM elements
    const path = e.composedPath();
    const hoveringOverMoatUI = path.some(el => 
      el.classList && (
        el.classList.contains('float-moat') || 
        el.classList.contains('float-comment-box')
      )
    );
    
    if (hoveringOverMoatUI) return;

    const pickerApi = getElementPicker();
    if (pickerApi) {
      const topPick = pickerApi.pickElementAtPoint(e.clientX, e.clientY, 0);
      if (topPick.element !== lastTopPickElement) {
        deepSelectIndex = 0;
        lastTopPickElement = topPick.element;
      }
    }

    refreshPickAtPointer(e.clientX, e.clientY);
  });

  // Drawing mode mouse handlers
  function setupDrawingHandlers() {
    if (!drawingCanvas) return;
    
    // Mouse down - start drawing
    drawingCanvas.addEventListener('mousedown', handleDrawingMouseDown, true);
    
    // Mouse move - update preview
    drawingCanvas.addEventListener('mousemove', handleDrawingMouseMove, true);
    
    // Mouse up - finalize rectangle
    drawingCanvas.addEventListener('mouseup', handleDrawingMouseUp, true);
    
    // Mouse leave - cancel drawing if mouse leaves canvas
    drawingCanvas.addEventListener('mouseleave', handleDrawingMouseLeave, true);
  }

  function removeDrawingHandlers() {
    if (!drawingCanvas) return;
    
    drawingCanvas.removeEventListener('mousedown', handleDrawingMouseDown, true);
    drawingCanvas.removeEventListener('mousemove', handleDrawingMouseMove, true);
    drawingCanvas.removeEventListener('mouseup', handleDrawingMouseUp, true);
    drawingCanvas.removeEventListener('mouseleave', handleDrawingMouseLeave, true);
  }

  function handleDrawingMouseDown(e) {
    if (!drawingMode || !drawingTool) return;
    
    // Check if clicking on Moat UI elements
    const path = e.composedPath();
    const clickingOnMoatUI = path.some(el => 
      el.classList && (
        el.classList.contains('float-moat') || 
        el.classList.contains('float-comment-box') ||
        el.id === 'moat-shadow-host'
      )
    );
    
    if (clickingOnMoatUI) {
      return; // Don't start drawing if clicking on Moat UI
    }
    
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
    isDrawing = true;
    
    // Get coordinates relative to viewport (clientX/Y already accounts for scroll)
    drawStartX = e.clientX;
    drawStartY = e.clientY;
    
    currentRect = {
      x: drawStartX,
      y: drawStartY,
      width: 0,
      height: 0
    };
    
    console.log('🎨 Started drawing at:', drawStartX, drawStartY);
  }

  function handleDrawingMouseMove(e) {
    if (!drawingMode || !isDrawing || !drawingTool) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    // Calculate current rectangle (clientX/Y is viewport-relative)
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    currentRect = {
      x: Math.min(drawStartX, currentX),
      y: Math.min(drawStartY, currentY),
      width: Math.abs(currentX - drawStartX),
      height: Math.abs(currentY - drawStartY)
    };
    
    // Redraw canvas with preview
    redrawCanvas();
  }

  function handleDrawingMouseUp(e) {
    if (!drawingMode || !isDrawing || !drawingTool) return;
    
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
    // Finalize rectangle
    if (currentRect && currentRect.width > 5 && currentRect.height > 5) {
      // Rectangle is large enough, show comment box
      finalizeRectangle(e.clientX, e.clientY);
    } else {
      // Rectangle too small, cancel
      cancelDrawing();
    }
  }

  function handleDrawingMouseLeave(e) {
    if (!drawingMode || !isDrawing) return;
    
    // Cancel drawing if mouse leaves canvas
    cancelDrawing();
  }

  function redrawCanvas() {
    if (!drawingCtx || !drawingCanvas || !currentRect) return;
    
    // Clear canvas
    drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    
    // Draw current rectangle preview
    const tool = drawingTools[drawingTool];
    if (tool && tool.draw) {
      tool.draw(drawingCtx, currentRect.x, currentRect.y, currentRect.width, currentRect.height);
    }
  }

  function cancelDrawing() {
    isDrawing = false;
    currentRect = null;
    
    // Clear canvas
    if (drawingCtx && drawingCanvas) {
      drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    }
  }

  function finalizeRectangle(mouseX, mouseY) {
    if (!currentRect || !drawingTool) return;
    
    const rect = currentRect;
    isDrawing = false;
    
    // Store rectangle data for screenshot capture
    // Note: rect coordinates are viewport-relative (clientX/Y), which is correct for canvas overlay
    const rectangleData = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      // Calculate normalized coordinates (0-1)
      normalized: {
        x: rect.x / window.innerWidth,
        y: rect.y / window.innerHeight,
        width: rect.width / window.innerWidth,
        height: rect.height / window.innerHeight
      },
      // Calculate xyxy format (x1, y1, x2, y2)
      xyxy: {
        x1: rect.x,
        y1: rect.y,
        x2: rect.x + rect.width,
        y2: rect.y + rect.height
      },
      // Calculate xywh format (x, y, width, height) - same as base but explicit
      xywh: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      },
      // Viewport info
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      type: 'freeform'
    };
    
    console.log('🎨 Finalized rectangle:', rectangleData);
    
    // Exit drawing mode (but keep canvas visible for screenshot)
    drawingMode = false;
    drawingTool = null;
    document.body.classList.remove('float-drawing-mode');
    
    // Show comment box at cursor position
    createFreeformCommentBox(rectangleData, mouseX, mouseY);
  }

  // Helper: does the event target sit inside Moat's own UI?
  function isEventInMoatUI(e) {
    const path = e.composedPath();
    const insideMoatUI = path.some(el =>
      el.classList && (
        el.classList.contains('float-moat') ||
        el.classList.contains('float-comment-box')
      )
    );
    if (insideMoatUI) return true;
    const element = e.target;
    if (element && element.id === 'moat-shadow-host') return true;
    return false;
  }

  // Click handler — plain click opens comment; Ctrl+Click drills (trackpad fallback)
  document.addEventListener('click', (e) => {
    if (!commentMode) return;
    if (isEventInMoatUI(e)) return;
    if (commentBox || annotationCapturePending) {
      e.preventDefault();
      e.stopPropagation();
      if (commentBox) shakeCommentBox();
      return;
    }

    if (isDeepSelectModifier(e)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (drilledOnPointerdown) {
        drilledOnPointerdown = false;
        return;
      }
      lastPointer = { x: e.clientX, y: e.clientY };
      handleDeepSelectDrill();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // Resolve at click time, preserving the layer chosen with Control.
    // Keyboard activation and touch need not produce a preceding mousemove.
    const target = refreshPickAtPointer(e.clientX, e.clientY) || e.target;
    if (!target) return;

    createCommentBox(target, e.clientX, e.clientY);
  }, true);

  // macOS: Ctrl+Click is remapped to contextmenu / secondary click.
  // Catch it here using controlKeyHeld (event.ctrlKey is often false).
  document.addEventListener(
    'contextmenu',
    (e) => {
      if (!commentMode || commentBox) return;
      if (isEventInMoatUI(e)) return;
      if (!isDeepSelectModifier(e)) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      lastPointer = { x: e.clientX, y: e.clientY };

      if (drilledOnPointerdown) {
        drilledOnPointerdown = false;
        return;
      }
      handleDeepSelectDrill();
    },
    true
  );

  // Pointerdown: Ctrl+Click drills (Win/Linux + Mac with held-state); else swallow press
  document.addEventListener('pointerdown', (e) => {
    if (!commentMode || commentBox) return;
    if (isEventInMoatUI(e)) return;

    if (isDeepSelectModifier(e)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      lastPointer = { x: e.clientX, y: e.clientY };
      handleDeepSelectDrill();
      drilledOnPointerdown = true;
      return;
    }

    // Ignore non-primary buttons when not deep-selecting (e.g. two-finger right-click)
    if (typeof e.button === 'number' && e.button !== 0) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!commentMode) return;
    if (isEventInMoatUI(e)) return;
    if (isDeepSelectModifier(e)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
    if (typeof e.button === 'number' && e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  // Global variables for new notification system
  let hasPressedC = false;

  // Listen for keyboard events
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && screenBackdrop && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      closeScreenCommentBox();
      return;
    }

    // Exit drawing mode with Escape
    if (e.key === 'Escape' && drawingMode) {
      e.preventDefault();
      exitDrawingMode();
      // Clean up canvas overlay when exiting via Esc
      removeDrawingCanvas();
      return;
    }
    
    // Exit comment mode with Escape (works on all tabs, even if not visible)
    if (e.key === 'Escape' && commentMode) {
      e.preventDefault();
      exitCommentMode();
      return;
    }
    
    // Don't process keyboard shortcuts if in input fields
    if (e.target.matches('input, textarea')) {
      return;
    }
    
    // Check if sidebar is visible (for C key)
    const sidebarVisible = sidePanelConnections > 0;
    const canUseShortcuts = !document.hidden && sidebarVisible;
    
    // Check if user has started interacting (can't switch tools once started)
    // - If commentBox exists, they've started/finished a comment or drawing
    // - If isDrawing is true, they're actively drawing a rectangle
    const hasStartedComment = commentBox !== null;
    const hasStartedDrawing = isDrawing === true;
    const canSwitchTools = !hasStartedComment && !hasStartedDrawing &&
      !screenCapturePending && !annotationCapturePending;

    // Screen capture is a plain S only, never a browser shortcut or text input.
    if ((e.key === 'S' || e.key === 's') && canSwitchTools && canUseShortcuts &&
        !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !e.isComposing && e.keyCode !== 229 &&
        !e.target.isContentEditable && !e.target.closest?.('[contenteditable], [role="textbox"]') &&
        !e.target.matches('select')) {
      e.preventDefault();
      createScreenCommentBox().then(result => {
        if (!result.success) showNotification(result.error, 'error');
      });
      return;
    }
    
    // Toggle between Comment and Rectangle modes with C and R keys
    if ((e.key === 'R' || e.key === 'r') && canSwitchTools && canUseShortcuts) {
      e.preventDefault();
      
      if (commentMode) {
        // Switch from comment mode to rectangle mode
        exitCommentMode();
        enterDrawingMode('rectangle');
        showNotification('Switched to Rectangle tool', 'info');
      } else if (!drawingMode) {
        // Enter rectangle mode (not switching, just entering)
        enterDrawingMode('rectangle');
      }
      return;
    }
    
    // 'C' key should ONLY work when sidebar is visible on the active tab
    if ((e.key === 'C' || e.key === 'c') && canSwitchTools && canUseShortcuts) {
      e.preventDefault();
      
      if (drawingMode) {
        // Switch from drawing mode to comment mode
        exitDrawingMode();
        
        // Mark that C has been pressed
        if (!hasPressedC) {
          hasPressedC = true;
        }
        
        enterCommentMode();
        showNotification('Switched to Comment tool', 'info');
      } else if (!commentMode) {
        // Enter comment mode (not switching, just entering)
        
        // Mark that C has been pressed
        if (!hasPressedC) {
          hasPressedC = true;
          // Show the click instruction notification
          showNotification('Click to comment · Ctrl+Click deep select', 'info', 'click-instruction');
        }
        
        enterCommentMode();
      }
      return;
    }
    
    // Export annotations with Cmd+Shift+E
    if (e.key === 'e' && e.metaKey && e.shiftKey) {
      e.preventDefault();
      exportAnnotations();
    }
    
  });

  // Listen for messages from background script (extension icon click) and side panel
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      // Simple ping to check if content script is ready
      sendResponse({
        success: true,
        ready: true,
        contentScriptBuild: window.__drawbridgeContentScriptBuild || null,
        hasElementPicker: !!window.MoatElementPicker,
        needsRefresh: !!window.__drawbridgeNeedsRefresh
      });

    }

    // Side Panel message types
    else if (request.type === 'CAPTURE_SCREEN') {
      createScreenCommentBox().then(sendResponse).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    }

    else if (request.type === 'ENTER_COMMENT_MODE') {
      if (screenBackdrop || screenCapturePending) {
        if (commentBox) shakeCommentBox();
        sendResponse({ success: false, error: 'Finish or cancel the current annotation first.' });
        return true;
      }
      enterCommentMode();
      relayToSidePanel({ type: 'MODE_CHANGED', mode: 'comment' });
      sendResponse({ success: true });
    }

    else if (request.type === 'ENTER_DRAWING_MODE') {
      if (screenBackdrop || screenCapturePending) {
        if (commentBox) shakeCommentBox();
        sendResponse({ success: false, error: 'Finish or cancel the current annotation first.' });
        return true;
      }
      enterDrawingMode('rectangle');
      relayToSidePanel({ type: 'MODE_CHANGED', mode: 'drawing' });
      sendResponse({ success: true });
    }

    else if (request.type === 'EXIT_ANNOTATION_MODE') {
      if (screenBackdrop || screenCapturePending) {
        if (commentBox) shakeCommentBox();
        sendResponse({ success: false, error: 'Finish or cancel the current annotation first.' });
        return true;
      }
      exitCommentMode();
      exitDrawingMode();
      relayToSidePanel({ type: 'MODE_CHANGED', mode: null });
      sendResponse({ success: true });
    }

    return true; // Keep message channel open for async response
  });

  // Helper to relay messages to side panel via background
  function relayToSidePanel(payload) {
    try {
      globalThis.chrome?.runtime?.sendMessage({ type: 'RELAY_TO_SIDEPANEL', payload }).catch(() => {
        // Side panel might not be open.
      });
    } catch {
      // Reloaded extensions leave old page scripts without a usable runtime.
    }
  }

  // Earlier versions kept the folder handle in this site's own storage, where page scripts could reach it.
  function removeLegacyPageStorage() {
    try {
      indexedDB.deleteDatabase('MoatPersistence');
      localStorage.removeItem(`moat.project.${location.origin}`);
      localStorage.removeItem('moat.queue');
    } catch {
      // Storage may be unavailable, such as in a sandboxed page.
    }
  }
  removeLegacyPageStorage();

  // The native panel owns a port only while it is showing this tab.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'drawbridge-sidepanel') return;
    sidePanelConnections++;
    port.onDisconnect.addListener(() => { sidePanelConnections = Math.max(0, sidePanelConnections - 1); });
  });

  window.__drawbridgeDebug = {
    build: contentScriptBuild,
    hasElementPicker: !!window.MoatElementPicker,
    deepSelect: true
  };
  console.info('[Drawbridge] Loaded', window.__drawbridgeDebug);
})();
