#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');

// Configuration
const STREAM_FILE = '.moat/.moat-stream.jsonl';
const PROCESSED_FILE = '.moat/.processed-ids.json';

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
};

// Check if we're in a project with Moat
function checkMoatSetup() {
  if (!fs.existsSync('.moat')) {
    console.log(`${colors.yellow}⚠️  No .moat directory found${colors.reset}`);
    console.log(`${colors.yellow}   Run this script in a project connected to Moat${colors.reset}`);
    console.log(`${colors.yellow}   Or connect your project in the Moat extension first${colors.reset}\n`);
    return false;
  }
  return true;
}

// Load processed IDs
function loadProcessedIds() {
  try {
    return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')));
  } catch (e) {
    return new Set();
  }
}

// Save processed IDs
function saveProcessedIds(ids) {
  fs.mkdirSync('.moat', { recursive: true });
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...ids], null, 2));
}

// Copy to clipboard
function copyToClipboard(text) {
  if (process.platform === 'darwin') {
    exec('pbcopy', (err) => {
      if (err) {
        console.error(`${colors.red}Failed to copy to clipboard${colors.reset}`);
      }
    }).stdin.end(text);
  } else if (process.platform === 'win32') {
    exec('clip', (err) => {
      if (err) {
        console.error(`${colors.red}Failed to copy to clipboard${colors.reset}`);
      }
    }).stdin.end(text);
  }
  // Linux support would require xclip/xsel
}

// Process new annotations
async function processNewAnnotations() {
  const processedIds = loadProcessedIds();
  
  if (!fs.existsSync(STREAM_FILE)) {
    return;
  }

  const fileStream = fs.createReadStream(STREAM_FILE);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let hasNewAnnotations = false;
  const newAnnotations = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    
    try {
      const entry = JSON.parse(line);
      const annotation = entry.annotation;
      
      if (!processedIds.has(annotation.id)) {
        hasNewAnnotations = true;
        processedIds.add(annotation.id);
        newAnnotations.push(entry);
      }
    } catch (e) {
      console.error(`${colors.red}Error parsing annotation:${colors.reset}`, e.message);
    }
  }

  // Process each new annotation
  for (const entry of newAnnotations) {
    const annotation = entry.annotation;
    
    console.log(`\n${colors.bright}${colors.blue}📝 New Moat Annotation${colors.reset}`);
    console.log(`${colors.cyan}Element:${colors.reset} ${annotation.elementLabel}`);
    console.log(`${colors.cyan}Issue:${colors.reset} ${annotation.content}`);
    console.log(`${colors.cyan}URL:${colors.reset} ${annotation.pageUrl}`);
    console.log(`${colors.cyan}Selector:${colors.reset} ${annotation.target}`);
    
    if (entry.formatting && entry.formatting.targetFile) {
      console.log(`${colors.cyan}Suggested File:${colors.reset} ${entry.formatting.targetFile}`);
    }
    
    console.log(`\n${colors.bright}Formatted for Cursor:${colors.reset}`);
    console.log(entry.formatting.cursorPrompt);
    console.log('\n' + '─'.repeat(60));
    
    // Copy to clipboard
    copyToClipboard(entry.formatting.cursorPrompt);
    console.log(`${colors.green}✓ Copied to clipboard!${colors.reset}`);
    console.log(`${colors.green}  Press Cmd/Ctrl + K in Cursor to apply${colors.reset}`);
  }

  if (hasNewAnnotations) {
    saveProcessedIds(processedIds);
    
    if (newAnnotations.length > 1) {
      console.log(`\n${colors.yellow}Note: Multiple annotations found. Last one copied to clipboard.${colors.reset}`);
    }
  }
}

// Watch for changes
function watchAnnotations() {
  console.clear();
  console.log(`${colors.bright}${colors.blue}🚀 Moat Watcher Started${colors.reset}`);
  console.log(`${colors.cyan}Project:${colors.reset} ${process.cwd()}`);
  console.log(`${colors.cyan}Watching:${colors.reset} ${STREAM_FILE}`);
  console.log(`\n${colors.yellow}Tips:${colors.reset}`);
  console.log(`  • Create annotations in Moat extension`);
  console.log(`  • Prompts auto-copy to clipboard`);
  console.log(`  • Press Cmd/Ctrl + K in Cursor to apply`);
  console.log(`  • Press Ctrl + C to stop\n`);
  console.log('─'.repeat(60) + '\n');

  // Process existing annotations
  processNewAnnotations();

  // Set up file watching
  let watchTimeout;
  const watchCallback = () => {
    // Debounce to avoid multiple triggers
    clearTimeout(watchTimeout);
    watchTimeout = setTimeout(() => {
      processNewAnnotations();
    }, 100);
  };

  // Watch for changes
  if (fs.existsSync(STREAM_FILE)) {
    fs.watchFile(STREAM_FILE, { interval: 3000 }, watchCallback);
  }
  
  // Also watch the directory in case file is created later
  if (fs.existsSync('.moat')) {
    fs.watch('.moat', { recursive: false }, (eventType, filename) => {
      if (filename === '.moat-stream.jsonl') {
        // Re-setup watch on the file
        fs.unwatchFile(STREAM_FILE);
        fs.watchFile(STREAM_FILE, { interval: 3000 }, watchCallback);
        watchCallback();
      }
    });
  }
}

// Main execution
function main() {
  console.clear();
  
  // Check if Moat is set up
  if (!checkMoatSetup()) {
    process.exit(1);
  }
  
  // Start watching
  watchAnnotations();
}

// Handle exit
process.on('SIGINT', () => {
  console.log(`\n\n${colors.yellow}Moat watcher stopped${colors.reset}`);
  console.log(`${colors.cyan}Thanks for using Moat! 🧭${colors.reset}\n`);
  process.exit(0);
});

// Handle errors
process.on('uncaughtException', (err) => {
  console.error(`\n${colors.red}Unexpected error:${colors.reset}`, err.message);
  process.exit(1);
});

// Start the watcher
main(); 