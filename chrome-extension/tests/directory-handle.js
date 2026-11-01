const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real temporary files behind the browser's directory-handle interface.
function directoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-'));
  const locks = new Set();
  const state = { failWrite: null };
  function handle(fullPath) {
    return {
      kind: 'directory', name: path.basename(fullPath),
      async getDirectoryHandle(name, { create = false } = {}) {
        // Chrome rejects colons even on filesystems that permit them.
        if (name.includes(':')) throw new TypeError('Invalid directory name');
        const child = path.join(fullPath, name);
        if (fs.existsSync(child) && !fs.statSync(child).isDirectory()) {
          throw new DOMException('Not a directory', 'TypeMismatchError');
        }
        if (create) fs.mkdirSync(child, { recursive: true });
        if (!fs.existsSync(child)) throw new DOMException('Directory not found', 'NotFoundError');
        return handle(child);
      },
      async getFileHandle(name, { create = false } = {}) {
        const filename = path.join(fullPath, name);
        if (!fs.existsSync(filename)) {
          if (!create) throw new DOMException('File not found', 'NotFoundError');
          fs.writeFileSync(filename, '');
        }
        return {
          kind: 'file', name,
          async getFile() { return new Blob([fs.readFileSync(filename)]); },
          async createWritable() {
            if (locks.has(filename)) throw new DOMException('File locked', 'NoModificationAllowedError');
            locks.add(filename);
            let buffer;
            return {
              async write(data) {
                if (state.failWrite === name) throw new Error('Write denied');
                buffer = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : data;
              },
              async close() {
                try { fs.writeFileSync(filename, buffer); }
                finally { locks.delete(filename); }
              },
              async abort() { locks.delete(filename); }
            };
          }
        };
      },
      async removeEntry(name, { recursive = false } = {}) {
        fs.rmSync(path.join(fullPath, name), { recursive });
      },
      async *values() {
        for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
          yield entry.isDirectory() ? handle(path.join(fullPath, entry.name)) : { name: entry.name, kind: 'file' };
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
