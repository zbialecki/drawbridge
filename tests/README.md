# Tests

All `*.test.js` files live here, mirroring the production directories:

```text
tests/
├── chrome-extension/   # Extension behavior and utils/ and sidepanel/ suites
├── scripts/            # Watcher tests
└── helpers/            # Shared filesystem, IndexedDB, and source-extraction fixtures
```

From the repository root:

```sh
npm ci
npm test
npm run test:coverage

# Run one suite
npm test -- tests/chrome-extension/utils/annotationStore.test.js --runInBand
```

Jest is configured in `package.json` to discover tests only under `tests/` and clear/restore mocks between tests. Tests use temporary directories and mock clipboard commands; they do not write into your projects or change your clipboard.

The suite focuses on saved data, failures/retries, messaging, and user interactions. Repeated integration tests and overlapping helper-level tests were removed.

## Limits

- Filesystem tests use real temporary files with simulated browser writer semantics. IndexedDB tests model requests and database reuse, not native handle structured-cloning or transaction aborts.
- jsdom checks selectors, focus events, and production side-panel markup, not browser layout or screenshot rendering. Chrome APIs are mocked.
- Content-script tests execute checked source sections. Moving functions may require updating those boundaries. VM-executed files appear as 0% in Jest's imported-module coverage; the report includes all production files rather than hiding them or counting fixtures.

Before shipping browser-facing changes, use Chrome to verify native C/R/S captures, high-DPI crops, permission loss/reconnection, saves/retries, and deletion against a temporary output folder. Preserve unsaved drafts before reloading the extension or refreshing a page.
