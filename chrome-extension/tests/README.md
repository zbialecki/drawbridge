# Drawbridge Test Framework

## Overview

This directory contains a lightweight test framework for Drawbridge that runs without npm dependencies, alongside the extension's Jest integration tests.

## Architecture

### Test Runner (`test-runner.js`)
- Minimal Jest/Mocha-style test framework
- Supports `describe`, `it`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll`
- Built-in assertion library with `expect()` API
- No external dependencies

### Mocks (`chrome-mock.js`)
- Chrome Extension API mocks (`chrome.runtime`, `chrome.tabs`, `chrome.storage`, etc.)
- File System Access API mocks (`showDirectoryPicker`, directory handles, file handles)
- IndexedDB mocks for persistence testing
- DOM mocks for browser environment

### Test Files

1. **`connection.test.js`** - JTBD-01 to JTBD-13
   - Connection & Project Setup
   - Directory selection
   - Template deployment
   - Persistence & restoration

2. **`tasks.test.js`** - JTBD-42 to JTBD-56
   - Task Management (CRUD)
   - Task creation
   - Status updates
   - Deduplication
   - Statistics

3. **`markdown.test.js`** - JTBD-57 to JTBD-66
   - Markdown Generation
   - Task formatting
   - Checkbox conversion
   - Comment truncation
   - File writing

4. **`filesystem.test.js`**
   - File System Access and persistence

5. **`architecture.test.js`**
   - Side panel and extension message passing

6. **`run-all.js`**
   - Entry point for running all tests
   - Generates a Markdown report

## Running Tests

### Node.js

From the repository root, run the five lightweight suites with:

```bash
node chrome-extension/tests/run-all.js
```

The runner loads the extension utilities and writes a report under `chrome-extension/tests/results/`. The repository's Jest suites can be run separately with `npm test`.

### Browser and manual runners

`test-runner.html` is an older browser runner. Its test scripts currently conflict over shared global names, so use the Node.js runner above for the complete suite. `manual-test.js` is a separate Chromium-based check; it requires `puppeteer-core` and a Chromium executable at the path configured in that script.

## Test Structure

Each test file follows this pattern:

```javascript
const runner = new TestRunner();
const { describe, it, beforeEach, afterEach, expect } = (() => {
  return {
    describe: runner.describe.bind(runner),
    it: runner.it.bind(runner),
    beforeEach: runner.beforeEach.bind(runner),
    afterEach: runner.afterEach.bind(runner),
    expect
  };
})();

describe('JTBD-XX: Job description', () => {
  let mocks;

  beforeEach(() => {
    mocks = setupMocks();
  });

  afterEach(() => {
    mocks.reset();
  });

  it('should do something', () => {
    // Test code
    expect(actual).toBe(expected);
  });
});
```

## Assertion API

```javascript
expect(value).toBe(expected)              // Strict equality (===)
expect(value).toEqual(expected)           // Deep equality (JSON.stringify)
expect(value).toBeTruthy()                // Truthy check
expect(value).toBeFalsy()                 // Falsy check
expect(value).toBeNull()                  // Null check
expect(value).toBeUndefined()             // Undefined check
expect(array).toContain(item)             // Array/string contains
expect(array).toHaveLength(length)        // Length check
expect(obj).toHaveProperty(prop, value)   // Property check
expect(fn).toThrow(error)                 // Exception check
expect(value).toBeInstanceOf(constructor) // Instance check

// Negation
expect(value).not.toBe(expected)
```

## Adding New Tests

1. **Identify the behavior** the test should cover
2. **Create or add to test file** for the appropriate category
3. **Write test case**:
   ```javascript
   describe('JTBD-XX: Job description', () => {
     it('should verify specific behavior', () => {
       // Arrange
       const input = setupTestData();
       
       // Act
       const result = functionUnderTest(input);
       
       // Assert
       expect(result).toBe(expected);
     });
   });
   ```
4. **Update `run-all.js`** if needed to include new test file
5. **Run tests** and verify

## Debugging Tests

### Enable Verbose Logging

```javascript
// In chrome-mock.js
const mocks = setupMocks();
mocks.chromeMock.enableDebug();
```

### Check Available Modules

```javascript
console.log('TaskStore:', !!window.MoatTaskStore);
console.log('MarkdownGenerator:', !!window.MoatMarkdownGenerator);
console.log('Persistence:', !!window.MoatPersistence);
```

### Inspect Test Results

```javascript
const results = await runner.run();
console.log(results.stats);
console.log(results.failedTests);
```

## Current Status

Run tests to see current status. Results will show:
- ✅ Passing tests
- ❌ Failing tests
- ⏳ Not yet tested

## Continuous Testing

For development:
1. Write tests BEFORE implementing features (TDD)
2. Run tests AFTER each change
3. Keep the suite passing as behavior changes

## Troubleshooting

### "Module not found" errors
- Ensure utility files are loaded before tests
- Check file paths in script tags
- Verify files exist in expected locations

### Tests fail with "not available" messages
- Utility modules (TaskStore, MarkdownGenerator, etc.) are not loaded
- Load them before running tests

### File System Access API errors
- Mocks should handle this automatically
- Verify `setupMocks()` is called in `beforeEach`

### IndexedDB errors
- Mocks should handle this automatically
- Check that `indexedDB` is properly mocked

## Contributing

When adding tests:
1. Follow existing patterns
2. Reference JTBD ID in test name
3. Keep tests focused and isolated
4. Use mocks to avoid side effects
5. Document complex test logic

## License

Same as Drawbridge project.
