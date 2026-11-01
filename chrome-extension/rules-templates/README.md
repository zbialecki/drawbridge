# Drawbridge Annotation Files

Drawbridge saves each annotation in its own folder directly inside the folder you select. Names use local time: `YY-MM-DD HH-mm`. Annotations in the same minute get `_2`, `_3`, and so on.

Each annotation contains:

- `metadata.json`: one task object with the comment, status, page/element context, geometry, and relative image paths.
- `comment.md`: the full comment and a readable status checkbox.
- `screenshot.png`: the native viewport capture cropped around the selection, when capture succeeds.
- `reference-N.ext`: any images pasted into the editor.

Use `C` to annotate an element, `R` to draw a rectangle, or `S` to capture the visible viewport. Submit to save the folder; failures keep the editor and pasted images available for retry.

Run `/bridge` in Claude Code, Codex, or Windsurf to process saved annotations. Choose `step bridge`, `batch bridge`, or `yolo bridge` to control approval and grouping. Image paths are relative to the annotation folder. Status progresses from `to do` to `doing` to `done`.

The extension remembers the selected folder when browser permissions permit. Reconnect from the project menu if access expires. Existing `.moat` annotations are still readable and remain in place; new annotations do not use that hidden folder.
