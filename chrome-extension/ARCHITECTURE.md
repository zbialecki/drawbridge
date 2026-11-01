# Drawbridge Architecture

## Extension Modules

- `background.js` opens the native side panel, ensures the content script is available, and handles native screenshot capture.
- `content_script.js` owns annotation interaction, native-image cropping, folder connection, and the message interface used by the side panel.
- `sidepanel/` displays tasks and sends commands to the content script. It does not hold filesystem handles.
- `utils/annotationStore.js` owns the saved annotation layout: folder naming, complete saves, discovery, updates, image reads, and deletion.
- `utils/persistence.js` stores the selected directory handle in IndexedDB and checks browser permissions on restoration.
- `utils/taskStore.js` and `utils/markdownGenerator.js` support existing `.moat` projects.

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

### Existing projects

The store also reads an existing `.moat/moat-tasks-detail.json` array without creating a `.moat` directory or rewriting old files during connection. Legacy images remain relative to that directory. Explicit changes to a legacy task use the existing task store and checklist generator. New annotations always use timestamped folders in the output root.

There is no new shared JSON index or markdown checklist at the root, and connecting must not overwrite project files such as `README.md` or `config.json`.

## Connection and Permissions

The content script calls `showDirectoryPicker({ mode: 'readwrite' })` and retains that selected handle directly. IndexedDB persistence stores the same root handle. Restoring a connection queries permissions and verifies directory access without creating files. If Chrome needs permission again, the extension prompts the user to reconnect through a user action.

Connecting installs `/bridge` prompts under `.claude/commands/`, `.windsurf/workflows/`, and `.codex/prompts/` in the selected folder. Only those tool directories are added to an existing `.gitignore`; annotation folders are not automatically ignored. A separate output folder may be outside the code project, so the user must point their AI tool to it.

## Native Screenshot Capture

Both element (`C`) and rectangle (`R`) annotations send `CAPTURE_SCREENSHOT` to the service worker. Chrome's `captureVisibleTab` returns a viewport PNG without a DOM-rendering library. The content script crops it with viewport-relative coordinates, 100 CSS pixels of padding, and `devicePixelRatio` scaling. Visible annotation overlays are part of the captured image.

## Portable Folder Names

The time separator is a hyphen because Chrome's File System Access API rejects colons in local folder names, even on macOS. All generated names use `YY-MM-DD HH-mm` plus an optional collision index.

## Verification

`utils/annotationStore.test.js` exercises real temporary files through directory-handle mocks, including naming, same-minute collisions, simultaneous saves, retries, metadata preservation, existing-project reads, image paths, updates, and deletion. Content-script tests cover editor retention and side-panel operations. Real Chrome permission prompts and screenshot rendering still require browser verification.
