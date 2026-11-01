---
description: Process Drawbridge timestamped annotation folders with Step, Batch, or YOLO workflows
alwaysApply: false
---

# Drawbridge Workflow

Use `bridge.md` in this directory for the task discovery, image-path, status-update, and error-handling rules. Each timestamped annotation folder contains one `metadata.json`, a full `comment.md`, and any screenshot or pasted references. Paths in metadata are relative to its own folder, not a shared hidden directory.

## Dependency Detection Patterns

Read all pending annotations before planning. Group changes that touch the same element, file, or layout. Make foundational layout or design-token changes before their dependent details. Respect explicit dependencies, ask about contradictory requests, and do not merge distinct annotations merely because their selectors or comments match.

## Screenshot Validation & Attachment

Open each annotation's screenshot and all pasted reference images before writing code. Compare the image with its recorded URL, selector, bounding rectangle, and crop metadata. If a screenshot is absent, use the comment and available context; if a referenced image is missing, report that limitation.

## Framework Detection & Adaptation

Inspect the project's framework, component structure, style conventions, and design tokens before changing it. Reuse its existing modules, tokens, and accessibility patterns. Verify at relevant viewport sizes; prefer semantic HTML, modern layout primitives, and project-native styling to broad overrides or arbitrary values.

## Modes and verification

- **Step:** explain one annotation's plan, implement with approval, verify, then ask before the next.
- **Batch:** explain related groups and dependencies, get approval, implement and verify each group.
- **YOLO:** implement pending annotations autonomously, verify each, and report unresolved blockers.

For every mode, mark the annotation `doing` before editing and `done` only after the requested change and relevant checks are complete. Keep its JSON status and markdown checkbox consistent. Report changed files and checks in a concise summary, preserving all unrelated annotation metadata and project files.
