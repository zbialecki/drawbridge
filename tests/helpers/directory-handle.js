const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real temporary files with the browser semantics used by the storage modules.
function directoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-'));
  const locks = new Map();
  const state = { failWrite: null };
  function component(name) {
    if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /^\s|[\s.]$/.test(name)) {
      throw new TypeError('Invalid entry name');
    }
  }
  function handle(fullPath) {
    return {
      kind: 'directory', name: path.basename(fullPath),
      async getDirectoryHandle(name, { create = false } = {}) {
        component(name);
        const child = path.join(fullPath, name);
        if (fs.existsSync(child) && !fs.statSync(child).isDirectory()) {
          throw new DOMException('Not a directory', 'TypeMismatchError');
        }
        if (create) fs.mkdirSync(child, { recursive: true });
        if (!fs.existsSync(child)) throw new DOMException('Directory not found', 'NotFoundError');
        return handle(child);
      },
      async getFileHandle(name, { create = false } = {}) {
        component(name);
        const filename = path.join(fullPath, name);
        if (fs.existsSync(filename) && fs.statSync(filename).isDirectory()) {
          throw new DOMException('Not a file', 'TypeMismatchError');
        }
        if (!fs.existsSync(filename)) {
          if (!create) throw new DOMException('File not found', 'NotFoundError');
          fs.writeFileSync(filename, '');
        }
        return {
          kind: 'file', name,
          async getFile() { return new Blob([fs.readFileSync(filename)]); },
          async createWritable({ mode = 'siloed', keepExistingData = false } = {}) {
            const writers = locks.get(filename) || new Set();
            if ([...writers].some(writer => writer.mode === 'exclusive') || (mode === 'exclusive' && writers.size)) {
              throw new DOMException('File locked', 'NoModificationAllowedError');
            }
            const writer = { mode };
            writers.add(writer);
            locks.set(filename, writers);
            let buffer = keepExistingData ? fs.readFileSync(filename) : Buffer.alloc(0);
            let closed = false;
            const release = () => {
              writers.delete(writer);
              if (!writers.size) locks.delete(filename);
              closed = true;
            };
            const ensureOpen = () => {
              if (closed) throw new DOMException('Stream closed', 'InvalidStateError');
            };
            return {
              async write(data) {
                ensureOpen();
                if (state.failWrite === name) throw new Error('Write denied');
                buffer = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : Buffer.from(data);
              },
              async close() {
                ensureOpen();
                try { fs.writeFileSync(filename, buffer); }
                finally { release(); }
              },
              async abort() { release(); }
            };
          }
        };
      },
      async removeEntry(name, { recursive = false } = {}) {
        component(name);
        const child = path.join(fullPath, name);
        if (!fs.existsSync(child)) throw new DOMException('Entry not found', 'NotFoundError');
        if (fs.statSync(child).isDirectory() && !recursive) fs.rmdirSync(child);
        else fs.rmSync(child, { recursive });
      },
      async *values() {
        for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
          yield entry.isDirectory() ? handle(path.join(fullPath, entry.name)) : await this.getFileHandle(entry.name);
        }
      }
    };
  }
  return {
    root, state, directory: handle(root),
    read: name => fs.readFileSync(path.join(root, name), 'utf8'),
    exists: name => fs.existsSync(path.join(root, name)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}
module.exports = { directoryFixture };
