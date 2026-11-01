# Drawbridge — Future Ideas & Experiments

The biggest improvement is to make each saved task a reliable, self-contained **reproduction record**. Today, Drawbridge captures some useful context but drops it before the agent can read it. There are also a few paths where distinct feedback can be merged or lost.

The normal saved task contains a comment, selector, bounding rectangle, screenshot path, status, and timestamp. It may also contain pasted image paths or freeform rectangle data. But the annotation initially includes the page URL, element context, click position, screenshot crop, and session ID; those fields are omitted when it becomes a task. See the [annotation capture](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:3530) and [conversion to task data](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:380).

I’d prioritize the improvements like this:

1. **Save the page and the context already being captured.** Preserve `pageUrl`, `elementContext`, `clickPosition`, `screenshotViewport`, and capture time in the task JSON. Right now, an agent can receive “Make this button smaller” and a selector without knowing which page the button appeared on. Include the page title and preserve useful routing parameters and fragments, with sensitive URL values redacted.

2. **Make saving and synchronization trustworthy.** The disconnected fallback stores annotations in `localStorage`, but connecting a project clears that queue without migrating its items into the project task file. See [queueing](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:3123) and [connection setup](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:1213). Also, each tab has an in-memory task store that writes the whole task array; a stale tab can overwrite tasks or status changes written by another tab or an agent. See [task-store initialization](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:179) and [file writing](/Users/zb/Code/drawbridge/chrome-extension/utils/taskStore.js:355).

   I’d retain queued feedback until it has been durably imported, and give all writers a conflict-aware update protocol. JSON can remain the source of truth, with markdown generated from it.

3. **Fix deduplication before collecting more context.** Tasks are currently considered duplicates based on selector and comment, without considering the page. Freeform selections are saved with the literal selector `freeform`, so two rectangles in completely different locations with the same comment can also collapse into one task. See [conversion](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:408) and [deduplication](/Users/zb/Code/drawbridge/chrome-extension/utils/taskStore.js:189).

   Give every deliberate submission a stable ID and avoid automatically merging it with another submission. If deduplication is needed for retries, use that ID rather than guessing from the comment.

4. **Capture the conditions needed to reproduce the issue.** For both element and rectangle annotations, automatically save viewport width and height, scroll position, device pixel ratio, browser zoom, and relevant display preferences such as light or dark mode. Rectangle annotations already preserve viewport dimensions; regular element annotations do not. See [rectangle capture](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:4332).

   Add optional, lightweight fields for **steps to reproduce**, **what happened**, and **what should happen**. These matter for conditions the browser cannot infer, such as “after switching accounts” or “when the menu is open.” Keep a single comment sufficient for quick feedback.

5. **Make screenshots more informative and reliable.** The current image is a crop around the selection with roughly 100 pixels of padding. That is useful for detail, but it can omit the surrounding layout an agent needs. Also, the screenshot is taken when the comment box opens, while the element rectangle and URL are read later on submission; the page can change between those moments. See [capture](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:3396) and [submission](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:3510).

   Capture the screenshot and its page geometry as one snapshot. Offer a wider viewport image when context is needed, record the crop coordinates, and visibly report capture or save failures. Manage pasted references separately: currently **Clear Screenshots** deletes every file in the screenshots directory, including pasted reference images, while only clearing `screenshotPath` fields. That can leave broken attachment references. See [cleanup](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:5143).

6. **Save stronger clues for finding the element in code.** The selector generator returns the first plausible ID or attribute; if validation finds it is not unique, the code logs a warning but still saves it. See [selector generation](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:3251) and [validation](/Users/zb/Code/drawbridge/chrome-extension/content_script.js:3518).

   Store a small set of complementary clues: a validated selector and match count, tag, role, accessible label, test ID, short visible text, and nearby landmark or heading. Prefer stable, unique attributes and properly escape selector values. A selector is a clue to the rendered DOM; it is not necessarily a source-file location. Source-file hints could be added later through explicit development-build instrumentation.

7. **Give the agent a clear, versioned contract.** Keep the current fields compatible while adding a schema version and structured `page`, `target`, `reproduction`, and `evidence` fields. Separate what the user requested from what the browser observed and what an agent infers. The current markdown truncates comments to 60 characters, so it should remain a readable index that points to the full task rather than being the only source an agent reads. See [markdown generation](/Users/zb/Code/drawbridge/chrome-extension/utils/markdownGenerator.js:101).

   The agent workflow can then record its own outcome separately: files changed, checks performed, whether it reproduced the issue, and any missing information. That makes “done” more meaningful than a status change alone.

An illustrative task could look like this:

```json
{
  "schemaVersion": 2,
  "id": "task-123",
  "comment": "Keep the Save button visible on mobile.",
  "page": {
    "url": "http://localhost:3000/settings?tab=billing",
    "title": "Account settings",
    "viewport": { "width": 390, "height": 844 },
    "scroll": { "x": 0, "y": 640 }
  },
  "target": {
    "kind": "element",
    "selector": "[data-testid=\"save-settings\"]",
    "selectorMatchCount": 1,
    "role": "button",
    "name": "Save"
  },
  "reproduction": {
    "steps": ["Open the Billing tab"],
    "actual": "Save overlaps the bottom navigation.",
    "expected": "Save remains fully visible."
  },
  "screenshotPath": "./screenshots/task-123.png",
  "status": "to do"
}
```

I’d start with **preserving the existing captured fields, preventing lost writes, and fixing deduplication**. Those changes improve every annotation before adding more capture options. As capture expands, keep it bounded: avoid collecting form values, redact sensitive URL data, and let the user see when a wider screenshot is being saved.

I verified the rectangle-deduplication and stale-writer behaviors with small in-memory checks against the current task-store code. I did not run a full browser test or change any files.
