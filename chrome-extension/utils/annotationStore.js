// One annotation per timestamped folder in the user-selected directory.
(function () {
  const TASK_STATUS = { TO_DO: 'to do', DOING: 'doing', DONE: 'done' };
  const FOLDER_PATTERN = /^\d{2}-\d{2}-\d{2} \d{2}-\d{2}(?:_[1-9]\d*)?$/;

  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function timestampFolder(timestamp) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid annotation timestamp');
    const two = value => String(value).padStart(2, '0');
    return `${two(date.getFullYear() % 100)}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}-${two(date.getMinutes())}`;
  }

  async function writeFile(directory, name, content) {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ mode: 'exclusive', keepExistingData: false });
    try {
      await writable.write(content);
      await writable.close();
    } catch (error) {
      await writable.abort?.().catch(() => {});
      throw error;
    }
  }

  function commentMarkdown(task) {
    const checkbox = task.status === 'done' ? '[x]' : task.status === 'doing' ? '[~]' : '[ ]';
    let text = `# ${task.title}\n\n- ${checkbox} ${task.status}\n\n${task.comment}\n`;
    if (task.screenshotPath) text += `\n![Screenshot](${task.screenshotPath})\n`;
    for (const reference of task.attachments || []) text += `\n[Reference image](${reference})\n`;
    return text;
  }

  function validateMetadata(task) {
    for (const field of ['id', 'title', 'comment', 'status', 'timestamp']) {
      if (!Object.prototype.hasOwnProperty.call(task, field)) {
        throw new Error(`Task missing required field: ${field}`);
      }
    }
    if (task.selector != null && typeof task.selector !== 'string') {
      throw new Error(`Task selector must be a string or null, got: ${typeof task.selector}`);
    }
    if (!Object.values(TASK_STATUS).includes(task.status)) {
      throw new Error(`Invalid task status: ${task.status}`);
    }
    if (task.format !== 'drawbridge-annotation') throw new Error('Not a Drawbridge annotation');
    if (task.screenshotPath && task.screenshotPath !== './screenshot.png') {
      throw new Error('Invalid screenshot path');
    }
    if (task.attachments && (!Array.isArray(task.attachments) ||
        !task.attachments.every(p => /^\.\/reference-\d+\.[a-z0-9]+$/.test(p)))) {
      throw new Error('Invalid reference image path');
    }
  }

  function displayTask(task, folderName) {
    return {
      ...task,
      folderName,
      screenshotPath: task.screenshotPath ? `./${folderName}/${task.screenshotPath.slice(2)}` : '',
      attachments: (task.attachments || []).map(p => `./${folderName}/${p.slice(2)}`)
    };
  }

  class AnnotationStore {
    constructor() {
      this.tasks = [];
      this.directoryHandle = null;
    }

    initialize(directory) { this.directoryHandle = directory; }
    isInitialized() { return !!this.directoryHandle; }
    getAllTasks() { return [...this.tasks].sort((a, b) => b.timestamp - a.timestamp); }
    getTaskById(id) { return this.tasks.find(task => task.id === id) || null; }

    async loadTasksFromFile() {
      if (!this.directoryHandle) throw new Error('No folder connected');
      const tasks = [];
      for await (const entry of this.directoryHandle.values()) {
        if (entry.kind !== 'directory' || !FOLDER_PATTERN.test(entry.name)) continue;
        try {
          const file = await (await entry.getFileHandle('metadata.json')).getFile();
          const text = await file.text();
          if (!text.trim()) continue; // A save may still be in progress.
          const task = JSON.parse(text);
          validateMetadata(task);
          tasks.push(displayTask(task, entry.name));
        } catch (error) {
          if (error.name !== 'NotFoundError') console.warn(`Could not load annotation ${entry.name}:`, error);
        }
      }

      this.tasks = tasks;
      return this.getAllTasks();
    }

    async saveAnnotation(annotation, taskData) {
      if (!this.directoryHandle) throw new Error('Connect a folder before saving annotations.');
      const id = annotation.id || (annotation.id = generateUUID());
      const timestamp = annotation.timestamp ?? (annotation.timestamp = Date.now());
      const base = timestampFolder(timestamp);

      for (let suffix = 0; ; suffix++) {
        const folderName = suffix ? `${base}_${suffix + 1}` : base;
        let directory;
        let created = false;
        try {
          directory = await this.directoryHandle.getDirectoryHandle(folderName);
        } catch (error) {
          if (error.name === 'TypeMismatchError') continue;
          if (error.name !== 'NotFoundError') throw error;
          try {
            directory = await this.directoryHandle.getDirectoryHandle(folderName, { create: true });
          } catch (createError) {
            if (createError.name === 'TypeMismatchError') continue;
            throw createError;
          }
          created = true;
        }
        if (!created) {
          try {
            const file = await (await directory.getFileHandle('metadata.json')).getFile();
            if (!(await file.text()).trim() && annotation.folderName !== folderName) continue;
          } catch (error) {
            if (error.name === 'NotFoundError') continue;
            throw error;
          }
        }
        const handle = await directory.getFileHandle('metadata.json', { create: true });
        let writable;
        try {
          // Claim the metadata file before writing images, including across tabs.
          writable = await handle.createWritable({ mode: 'exclusive', keepExistingData: false });
        } catch (error) {
          if (error.name === 'NoModificationAllowedError') continue;
          throw error;
        }
        try {
          const existing = await (await handle.getFile()).text();
          let previous = {};
          if (existing.trim()) {
            let owner;
            try { owner = JSON.parse(existing); } catch (_) { /* Occupied by an unrelated file. */ }
            if (owner?.id !== id || owner?.format !== 'drawbridge-annotation') {
              await writable.abort();
              continue;
            }
            previous = owner;
          }
          annotation.folderName = folderName; // Retries reuse the same folder.
          const { screenshot, pastedImages, folderName: unusedFolder, ...context } = annotation;
          const task = {
            ...previous,
            ...context,
            ...taskData,
            id,
            timestamp,
            format: 'drawbridge-annotation',
            status: previous.status || 'to do',
            screenshotPath: '',
            attachments: []
          };
          if (screenshot) {
            await writeFile(directory, 'screenshot.png', this.imageBlob(screenshot).blob);
            task.screenshotPath = './screenshot.png';
          }
          for (const [index, dataUrl] of (pastedImages || []).entries()) {
            const { blob, extension } = this.imageBlob(dataUrl);
            const filename = `reference-${index + 1}.${extension}`;
            await writeFile(directory, filename, blob);
            task.attachments.push(`./${filename}`);
          }
          validateMetadata(task);
          await writeFile(directory, 'comment.md', commentMarkdown(task));
          // Publish metadata last so incomplete folders are never shown as saved tasks.
          await writable.write(JSON.stringify(task, null, 2));
          await writable.close();
          const saved = displayTask(task, folderName);
          this.tasks = this.tasks.filter(t => t.id !== id);
          this.tasks.push(saved);
          return saved;
        } catch (error) {
          await writable.abort?.().catch(() => {});
          throw error;
        }
      }
    }

    imageBlob(dataUrl) {
      const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(dataUrl);
      if (!match) throw new Error('An annotation image could not be read. Remove it and paste it again.');
      const [, mime, base64] = match;
      const extension = mime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      if (!/^[a-z0-9]+$/.test(extension)) throw new Error('Unsupported image format');
      return { blob: new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: mime }), extension };
    }

    async annotationDirectory(task) {
      if (!FOLDER_PATTERN.test(task.folderName)) throw new Error('Invalid annotation folder');
      const directory = await this.directoryHandle.getDirectoryHandle(task.folderName);
      const metadata = JSON.parse(await (await (await directory.getFileHandle('metadata.json')).getFile()).text());
      validateMetadata(metadata);
      if (metadata.id !== task.id) throw new Error('Annotation folder belongs to another task');
      return { directory, metadata };
    }

    async updateTask(id, changes) {
      const task = this.getTaskById(id);
      if (!task) throw new Error('Annotation not found');
      const { directory, metadata } = await this.annotationDirectory(task);
      Object.assign(metadata, changes);
      validateMetadata(metadata);
      await writeFile(directory, 'comment.md', commentMarkdown(metadata));
      await writeFile(directory, 'metadata.json', JSON.stringify(metadata, null, 2));
      Object.assign(task, displayTask(metadata, task.folderName));
      return task;
    }

    async updateTaskStatusAndSave(id, status) {
      if (!Object.values(TASK_STATUS).includes(status)) throw new Error(`Invalid status: ${status}`);
      return this.updateTask(id, { status, lastModified: Date.now() });
    }

    async updateTaskCommentAndSave(id, comment) {
      comment = String(comment || '').trim();
      if (!comment) throw new Error('Task comment cannot be empty');
      return this.updateTask(id, { comment, content: comment, lastModified: Date.now() });
    }

    async removeTaskAndSave(id) {
      const task = this.getTaskById(id);
      if (!task) return false;
      await this.annotationDirectory(task);
      await this.directoryHandle.removeEntry(task.folderName, { recursive: true });
      this.tasks = this.tasks.filter(task => task.id !== id);
      return true;
    }

    imagePath(path) {
      const parts = path.replace(/^\.\//, '').split('/');
      const current = parts.length === 2 && FOLDER_PATTERN.test(parts[0]) &&
        /^(?:screenshot\.png|reference-\d+\.[a-z0-9]+)$/.test(parts[1]);
      if (!current || parts.some(p => !p || p === '..' || p.includes('\\'))) {
        throw new Error('Invalid annotation image path');
      }
      return parts;
    }

    async imageDirectory(path) {
      const parts = this.imagePath(path);
      const filename = parts.pop();
      let directory = this.directoryHandle;
      for (const name of parts) directory = await directory.getDirectoryHandle(name);
      return { directory, filename };
    }

    async getImageFile(path) {
      const { directory, filename } = await this.imageDirectory(path);
      return (await directory.getFileHandle(filename)).getFile();
    }

    async clearScreenshots() {
      let deleted = 0;
      for (const task of this.tasks) {
        if (!task.screenshotPath) continue;
        const { directory, filename } = await this.imageDirectory(task.screenshotPath);
        try {
          await directory.removeEntry(filename);
        } catch (error) {
          if (error.name !== 'NotFoundError') throw error;
        }
        await this.updateTask(task.id, { screenshotPath: '' });
        deleted++;
      }
      return deleted;
    }
  }

  const api = { AnnotationStore, timestampFolder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.DrawbridgeAnnotationStore = api;
})();
