# Drawbridge Tests

Run the automated tests from the repository root:

```sh
npm install
npm test
```

Jest discovers `*.test.js` files throughout the repository. To run one suite while working on it, use for example:

```sh
npx jest chrome-extension/utils/annotationStore.test.js --runInBand
```

The tests cover annotation storage, screenshots and editor behavior, project connection, side-panel messaging, and the extension's manifest. `directory-handle.js` provides a temporary-directory implementation of the File System Access API for tests that need real file reads and writes. The integration tests also exercise the supported older `.moat` JSON and Markdown format.

Automated tests use mocks for Chrome APIs. For a browser check, load the unpacked extension in Chrome, open a local website, and connect a temporary output folder. Exercise the annotation tools, saving, status changes, and deletion there. Chrome permission prompts and actual screenshot rendering require a real browser.
