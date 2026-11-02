# Drawbridge Chrome Extension

Annotate a running page and save each comment, screenshot, and metadata together for an AI coding assistant.

## Setup

Requires Chrome 121 or newer.

1. Open `chrome://extensions`, enable Developer mode, and load this directory unpacked.
2. Pin Drawbridge and open the page you want to annotate.
3. Click the extension icon, then **Connect Project**, and select an output folder.
4. Approve browser file access. The selected folder is used directly.

Choose your code project's root to install `/bridge` commands there. If you choose another output folder, tell your AI tool where to find it. For `file://` pages, enable **Allow access to file URLs** in the extension's details.

## Annotate

- `C`: select an element and leave a comment. Ctrl+Click drills through nested elements.
- `R`: draw a rectangle and leave a comment.
- `S`: capture the visible viewport and describe it in the centered editor.
- Paste images into the editor to attach design references.
- `Enter`: submit; `Shift+Enter`: a newline; `Esc`: cancel.

All three options use Chrome's native `captureVisibleTab` API. Comment and Rectangle crop the image around the selection with padding and high-DPI scaling, and can still be submitted if capture fails. Screen captures the full viewport before showing its editor and can be retried if capture fails. File-write failures keep the comment and pasted images available for retry.

## Saved Files

```text
selected-folder/
├── 26-11-01 15-42/
│   ├── screenshot.png
│   ├── comment.md
│   ├── metadata.json
│   └── reference-1.png
└── 26-11-01 15-42_2/
    ├── screenshot.png
    ├── comment.md
    └── metadata.json
```

Names use local time: `YY-MM-DD HH-mm`. Additional annotations in that minute get `_2`, `_3`, etc., without overwriting an existing annotation.

- `metadata.json` is one object with `format: "drawbridge-annotation"`, a stable ID, full comment, status, timestamp, page URL, element context, geometry, and relative image paths.
- `comment.md` contains the full comment, image links, and `[ ]`, `[~]`, or `[x]` for `to do`, `doing`, or `done`.
- `screenshot.png` is present only if capture succeeded.
- `reference-N.ext` files are present only when images were pasted.

The side panel reloads these folders and writes status changes to their existing files. Deleting an annotation deletes its folder and associated images.

New annotations always use the selected folder directly. New annotation folders are not automatically git-ignored.

## Process with an AI Tool

Explicitly connecting creates missing `/bridge` prompts in `.claude/commands/`, `.windsurf/workflows/`, and `.codex/prompts/` under the selected folder. Existing commands and the project's README are never overwritten. Restoring a connection does not install project files. Update an older command manually from `rules-templates/bridge.md` when needed.

Run `/bridge` or `bridge`, optionally prefixed with `step`, `batch`, or `yolo`. The prompt discovers timestamped annotation folders and reads each metadata object, comment, screenshot, and pasted reference. Status follows `to do` → `doing` → `done`.

## Files

- `manifest.json`: extension configuration and script ordering.
- `background.js`: toolbar action and native screenshot capture.
- `content_script.js`: annotation UI and side-panel messages. It has no file access.
- `content.css`: annotation styles.
- `sidepanel/`: native side-panel UI, and all access to the connected folder.
- `utils/frameworkContext.js`: React and Next.js details read from the page.
- `utils/annotationStore.js`: timestamp naming, per-annotation files, image loading, updates, and deletion.
- `sidepanel/projectSetup.js`: installs the `/bridge` commands in a connected folder.
- `utils/persistence.js`: remembered directory handles and permission checks, for extension pages only.
- `offscreen/folderAccess.js`: hidden document that keeps folder access while the side panel is closed.
- `rules-templates/bridge.md`: AI task-processing instructions.

## Troubleshooting

- Reload the extension and refresh an already-open page after a storage-format update.
- Click **Reconnect** in the panel header after restarting Chrome or reloading the extension.
- For missing annotations, verify the selected output folder and check its timestamped directories.
