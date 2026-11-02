#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateMetadata } = require('../chrome-extension/utils/annotationStore');

const FOLDER_PATTERN = /^\d{2}-\d{2}-\d{2} \d{2}-\d{2}(?:_[1-9]\d*)?$/;

function readAnnotations(root) {
  const annotations = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !FOLDER_PATTERN.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8'));
      validateMetadata(metadata);
      if (metadata.status === 'done') continue;
      const files = ['comment.md', ...(metadata.screenshotPath ? [metadata.screenshotPath] : []), ...(metadata.attachments || [])];
      if (!files.every(file => {
        const target = path.join(directory, file);
        if (!fs.statSync(target).isFile()) return false;
        fs.accessSync(target, fs.constants.R_OK);
        return true;
      })) continue;
      annotations.push({ directory, metadata });
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        console.error(`Could not read ${entry.name}: ${error.message}`);
      }
    }
  }
  return annotations.sort((a, b) => a.metadata.timestamp - b.metadata.timestamp);
}

function copyToClipboard(text) {
  const command = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip' : null;
  if (!command) {
    console.warn('Clipboard copying is supported on macOS and Windows only.');
    return false;
  }
  const result = spawnSync(command, { input: text, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error('Failed to copy to clipboard:', result.error?.message || result.stderr);
    return false;
  }
  return true;
}

function processAnnotations(root, copy = copyToClipboard) {
  const pending = [];
  for (const { directory, metadata } of readAnnotations(root)) {
    const receipt = path.join(directory, 'watcher.json');
    try {
      if (JSON.parse(fs.readFileSync(receipt, 'utf8')).id === metadata.id) continue;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const prompt = [
      metadata.needsDiscussion
        ? 'Needs Discussion: Discuss this issue with the user and obtain approval before implementing:'
        : 'Fix this UI issue:', metadata.comment,
      `Annotation: ${directory}`,
      `Selector: ${metadata.selector || 'freeform rectangle'}`,
      `URL: ${metadata.pageUrl || ''}`,
      metadata.react?.component && `Component: ${metadata.react.component}${metadata.react.componentEnv ? ` (${metadata.react.componentEnv})` : ''}`,
      metadata.react?.source && `Source: ${metadata.react.source}`,
      metadata.react?.route && `Route: ${metadata.react.route}`,
      metadata.framework?.buildId && `Build: ${metadata.framework.buildId}`,
      'Read this folder’s metadata.json, comment.md, screenshot, and reference images before editing.'
    ].filter(Boolean).join('\n');
    console.log(`\n📝 ${path.basename(directory)}\n${prompt}`);
    pending.push({ receipt, id: metadata.id, prompt });
  }
  if (!pending.length || !copy(pending.map(entry => entry.prompt).join('\n\n---\n\n'))) return;
  for (const { receipt, id } of pending) {
    // Keep watcher state beside the annotation, separate from agent-editable metadata.
    fs.writeFileSync(receipt, JSON.stringify({ id, copiedAt: Date.now() }, null, 2));
  }
  console.log('✓ Copied to clipboard');
}

function main() {
  const root = process.cwd();
  console.log(`Drawbridge watcher: ${root}\nPress Ctrl+C to stop.`);
  const poll = () => {
    try { processAnnotations(root); }
    catch (error) { console.error('Could not process annotations:', error.message); }
  };
  poll();
  // Poll only annotation directories; recursive project watches can include node_modules.
  const timer = setInterval(poll, 3000);
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
}

if (require.main === module) main();
module.exports = { readAnnotations, processAnnotations };
