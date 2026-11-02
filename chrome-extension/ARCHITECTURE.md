# Drawbridge Architecture

## Extension Modules

- `background.js` opens the native side panel, ensures the content script is available, and handles native screenshot capture.
- `content_script.js` owns annotation interaction and native-image cropping. It has no file access: it sends finished annotations to the side panel.
- `sidepanel/` displays tasks, sends commands to the content script, and owns all access to the connected folder. `sidepanel/projectSetup.js` installs the `/bridge` commands.
- `utils/frameworkContext.js` reads React and Next.js details from the page and sanitizes them.
- `utils/annotationStore.js` owns the saved annotation layout: folder naming, complete saves, discovery, updates, image reads, and deletion.
- `utils/persistence.js` stores each site's directory handle in the extension's IndexedDB and checks browser permissions on restoration. Only extension pages may load it.

## Storage

The folder selected by the user is the output root. New annotations are individual subfolders named with local time, `YY-MM-DD HH-mm`. Collisions use `_2`, `_3`, etc.

```text
selected-folder/
└── 26-11-01 15-42/
    ├── screenshot.png
    ├── comment.md
    ├── metadata.json
    └── reference-1.png
```

`metadata.json` contains one task object identified by `format: "drawbridge-annotation"`. It preserves the annotation's ID, full comment, timestamp, status, URL, element context, click position, crop information, and bounding geometry. Screenshot and attachment paths are relative to this metadata file. The store prefixes paths with the annotation folder when returning tasks to the panel, so image reads remain rooted at the selected handle.

`comment.md` is a readable mirror containing the full comment, a status checkbox, and image links. Screenshots are optional; pasted references remain separate files in the same folder.

### Save and retry

The store claims `metadata.json` with an exclusive writable stream before writing assets. This prevents simultaneous tabs from choosing the same folder. Images and the comment are written first; metadata is published last, so incomplete saves are not listed as completed annotations. Retries keep the annotation ID and original timestamp, find the same folder, and do not duplicate a successful save.

Write failures propagate to the editor, which retains the draft and references for retry. Capture failure is different: the annotation is saved normally without a screenshot.

Status updates re-read the annotation's metadata, preserve unrelated fields, and update the same metadata/comment files. Deletion checks the folder name, metadata format, and task ID before removing the annotation folder. Image paths are checked before filesystem traversal. Clearing screenshots removes only capture images, not pasted references.

### Project files

There is no new shared JSON index or markdown checklist at the root, and connecting must not overwrite project files such as `README.md` or `config.json`.

## Connection and Permissions

Folder handles live only on extension pages. A content script shares IndexedDB with the page it runs in, so a handle stored there could be read by any script on that site, which could then read and write the selected folder. The side panel calls `showDirectoryPicker({ mode: 'readwrite' })` and stores the handle in the extension's own IndexedDB, keyed by the site's origin. Earlier versions stored handles in the page's storage; the content script deletes that `MoatPersistence` database and the old `moat.*` keys on load, so upgrading requires reconnecting once.

Each site has its own connection, so a page on one site cannot save into a folder connected for another. When a site has no connection, the panel offers the most recently connected folder in one click, without another picker. Restoring queries permission without prompting. If Chrome needs permission again, the panel offers a reconnect button, because `requestPermission` needs a click in the panel.

The panel must be open to save. The content script sends `SAVE_ANNOTATION` to the panel, which accepts it only from the top frame of the tab and site it is showing. Page scripts cannot send extension messages, and they can dispatch events on the editor, so the editor only submits on trusted events. Page scripts can still edit the editor's text before a real submit, because it lives in the page's DOM. If the panel is closed or on another tab, the save fails and the editor keeps the draft and shows the reason on the page.

Task data can come from files that agents and other tools edit, so the panel escapes every value it renders, including attributes.

Connecting a site installs `/bridge` prompts, once per panel session, under `.claude/commands/`, `.windsurf/workflows/`, and `.codex/prompts/` in the selected folder. Only those tool directories are added to an existing `.gitignore`; annotation folders are not automatically ignored. A separate output folder may be outside the code project, so the user must point their AI tool to it.

## Native Screenshot Capture

Both element (`C`) and rectangle (`R`) annotations send `CAPTURE_SCREENSHOT` to the service worker. Chrome's `captureVisibleTab` returns a viewport PNG without a DOM-rendering library. The content script crops it with viewport-relative coordinates, 100 CSS pixels of padding, and `devicePixelRatio` scaling. Visible annotation overlays are part of the captured image.

## React and Next.js Context

React fibers and page globals are invisible to the content script's isolated world. When an annotation starts, the content script marks the selected element with a temporary `data-drawbridge-inspect` attribute and asks the service worker to run `inspectPageContext` in the page's `MAIN` world through `chrome.scripting`. Nothing stays injected between annotations, and the function removes the attribute as soon as it finds the element.

The function reads fiber owner chains and `_debugInfo`, and maps `_debugStack` frames to source through Next's dev-only `/__nextjs_original-stack-frames` endpoint. It takes route files from Next's MCP `get_page_metadata` tool, falling back to `SegmentViewNode` props. It reads no props or state values. On production builds it returns only build identity.

Everything it returns is page-controlled. The service worker passes it through `sanitizeFrameworkContext`, which caps strings and lists, rejects absolute or parent-relative paths, and builds `mcpEndpoint` from the tab's own URL for loopback hosts only, so a page cannot direct an agent to another server.

Capture runs beside the screenshot, and `submitCommentAnnotation` awaits the result for at most three seconds from the start of capture. A failure or timeout saves the annotation without this data. These fiber fields and Next endpoints are private and can change between versions.

## Portable Folder Names

The time separator is a hyphen because Chrome's File System Access API rejects colons in local folder names, even on macOS. All generated names use `YY-MM-DD HH-mm` plus an optional collision index.

## Verification

`sidepanel/folderConnection.test.js` drives the real panel against real temporary files, covering connection, restoration, per-site separation, save origin checks, and hostile metadata. `manifest.test.js` guards against loading file access code into web pages. `utils/annotationStore.test.js` exercises real temporary files through directory-handle mocks, including naming, same-minute collisions, simultaneous saves, retries, metadata preservation, image paths, updates, and deletion. `utils/frameworkContext.test.js` exercises the page reader against simulated fibers and page payloads, and the sanitizer against hostile values. Content-script tests cover editor retention and side-panel operations. Real Chrome permission prompts and screenshot rendering still require browser verification.
