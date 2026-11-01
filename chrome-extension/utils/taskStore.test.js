// Unit tests for taskStore.js
// Run with: npm test

const {
    TaskStore,
    TASK_STATUS,
    generateUUID,
    createTaskObject,
    validateTaskObject,
    sortTasksByTimestamp
} = require('./taskStore.js');
const fs = require('node:fs');
const path = require('node:path');
const { directoryFixture } = require('../tests/directory-handle');

describe('UUID Generation', () => {
    test('generateUUID should create valid UUID v4', () => {
        const uuid = generateUUID();
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test('generateUUID should create unique UUIDs', () => {
        const uuid1 = generateUUID();
        const uuid2 = generateUUID();
        expect(uuid1).not.toBe(uuid2);
    });
});

describe('Task Object Creation', () => {
    const validTaskData = {
        title: 'Test Task',
        comment: 'This is a test comment',
        selector: '.test-element',
        boundingRect: { x: 10, y: 20, w: 100, h: 50 },
        screenshotPath: './screenshots/test.png'
    };

    test('createTaskObject should create valid task', () => {
        const task = createTaskObject(validTaskData);
        
        expect(task).toMatchObject({
            title: 'Test Task',
            comment: 'This is a test comment',
            selector: '.test-element',
            boundingRect: { x: 10, y: 20, w: 100, h: 50 },
            screenshotPath: './screenshots/test.png',
            status: TASK_STATUS.TO_DO
        });
        expect(task.id).toBeDefined();
        expect(task.timestamp).toBeDefined();
    });

    test('createTaskObject should handle missing optional fields', () => {
        const minimalData = {
            title: 'Minimal Task',
            comment: 'Minimal comment',
            selector: '.minimal'
        };
        
        const task = createTaskObject(minimalData);
        expect(task.boundingRect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
        expect(task.screenshotPath).toBe('');
    });

    test('createTaskObject should throw error for missing required fields', () => {
        expect(() => createTaskObject({})).toThrow('Task must have title and comment');
        expect(() => createTaskObject({ title: 'Test' })).toThrow();
        expect(createTaskObject({ title: 'Test', comment: 'Comment' }).selector).toBeNull();
    });
});

describe('Task Validation', () => {
    test('validateTaskObject should pass for valid task', () => {
        const validTask = {
            id: generateUUID(),
            title: 'Test',
            comment: 'Comment',
            selector: '.test',
            status: TASK_STATUS.TO_DO,
            timestamp: Date.now()
        };
        
        expect(validateTaskObject(validTask)).toBe(true);
    });

    test('validateTaskObject should throw for missing fields', () => {
        const invalidTask = { title: 'Test' };
        expect(() => validateTaskObject(invalidTask)).toThrow('Task missing required field');
    });

    test('validateTaskObject should throw for invalid status', () => {
        const invalidTask = {
            id: generateUUID(),
            title: 'Test',
            comment: 'Comment',
            selector: '.test',
            status: 'invalid-status',
            timestamp: Date.now()
        };
        
        expect(() => validateTaskObject(invalidTask)).toThrow('Invalid task status');
    });
});

describe('Task Sorting', () => {
    test('sortTasksByTimestamp should sort newest first', () => {
        const tasks = [
            { timestamp: 1000 },
            { timestamp: 3000 },
            { timestamp: 2000 }
        ];
        
        const sorted = sortTasksByTimestamp(tasks);
        expect(sorted[0].timestamp).toBe(3000);
        expect(sorted[1].timestamp).toBe(2000);
        expect(sorted[2].timestamp).toBe(1000);
    });

    test('sortTasksByTimestamp should not mutate original array', () => {
        const tasks = [{ timestamp: 1000 }, { timestamp: 2000 }];
        const original = [...tasks];
        
        sortTasksByTimestamp(tasks);
        expect(tasks).toEqual(original);
    });
});

describe('TaskStore Class', () => {
    let taskStore;

    beforeEach(() => {
        taskStore = new TaskStore();
    });

    test('should initialize empty', () => {
        expect(taskStore.getTasks()).toEqual([]);
        expect(taskStore.getTaskStats().total).toBe(0);
    });

    test('addTask should create and store task', () => {
        const taskData = {
            title: 'Test Task',
            comment: 'Test comment',
            selector: '.test'
        };
        
        const task = taskStore.addTask(taskData);
        expect(task.id).toBeDefined();
        expect(taskStore.getTasks()).toHaveLength(1);
        expect(taskStore.getTaskById(task.id)).toBe(task);
    });

    test('addTask should detect functional duplicates', () => {
        const taskData = {
            title: 'Test Task',
            comment: 'Same comment',
            selector: '.same-selector'
        };
        
        const task1 = taskStore.addTask(taskData);
        const task2 = taskStore.addTask(taskData);
        
        expect(taskStore.getTasks()).toHaveLength(1);
        expect(task1.id).toBe(task2.id);
    });

    test('addTask should update existing task when ID provided', () => {
        const task = taskStore.addTask({
            title: 'Original Title',
            comment: 'Original comment',
            selector: '.test'
        });
        
        const updatedTask = taskStore.addTask({
            id: task.id,
            title: 'Updated Title',
            comment: 'Updated comment',
            selector: '.test'
        });
        
        expect(updatedTask.id).toBe(task.id);
        expect(updatedTask.title).toBe('Updated Title');
        expect(taskStore.getTasks()).toHaveLength(1);
    });

    test('updateTaskStatus should update status', () => {
        const task = taskStore.addTask({
            title: 'Test',
            comment: 'Comment',
            selector: '.test'
        });
        
        const updated = taskStore.updateTaskStatus(task.id, TASK_STATUS.DONE);
        expect(updated.status).toBe(TASK_STATUS.DONE);
        expect(updated.lastModified).toBeDefined();
    });

    test('updateTaskStatus should return null for non-existent task', () => {
        const result = taskStore.updateTaskStatus('non-existent-id', TASK_STATUS.DONE);
        expect(result).toBeNull();
    });

    test('updateTaskStatus should throw for invalid status', () => {
        const task = taskStore.addTask({
            title: 'Test',
            comment: 'Comment',
            selector: '.test'
        });
        
        expect(() => taskStore.updateTaskStatus(task.id, 'invalid-status')).toThrow();
    });

    test('getTaskStats should return correct statistics', () => {
        taskStore.addTask({ title: 'Task 1', comment: 'Comment 1', selector: '.test1' });
        taskStore.addTask({ title: 'Task 2', comment: 'Comment 2', selector: '.test2' });
        
        const task3 = taskStore.addTask({ title: 'Task 3', comment: 'Comment 3', selector: '.test3' });
        taskStore.updateTaskStatus(task3.id, TASK_STATUS.DONE);
        
        const stats = taskStore.getTaskStats();
        expect(stats.total).toBe(3);
        expect(stats['to do']).toBe(2);
        expect(stats.done).toBe(1);
    });

    test('getAllTasks should be alias for getTasks', () => {
        taskStore.addTask({ title: 'Test', comment: 'Comment', selector: '.test' });
        expect(taskStore.getAllTasks()).toEqual(taskStore.getTasks());
    });

    test('clear should remove all tasks', () => {
        taskStore.addTask({ title: 'Test', comment: 'Comment', selector: '.test' });
        expect(taskStore.getTasks()).toHaveLength(1);
        
        taskStore.clear();
        expect(taskStore.getTasks()).toHaveLength(0);
    });
});

describe('Error Scenarios', () => {
    let taskStore;

    beforeEach(() => {
        taskStore = new TaskStore();
    });

    test('rejects corrupt task data before writing a legacy task file', async () => {
        const fixture = directoryFixture();
        try {
            taskStore.initialize(fixture.directory);
            taskStore.tasks.push({ invalid: 'task' });
            await expect(taskStore.saveTasksToFile()).rejects.toThrow('Task missing required field');
            expect(fixture.exists('moat-tasks-detail.json')).toBe(false);
        } finally {
            fixture.cleanup();
        }
    });

    test('should handle file path not set', async () => {
        await expect(taskStore.loadTasksFromFile()).rejects.toThrow('TaskStore not initialized with directory handle');
        await expect(taskStore.saveTasksToFile()).rejects.toThrow('TaskStore not initialized with directory handle');
    });

    test('should handle invalid task data in addTask', () => {
        expect(() => taskStore.addTask({})).toThrow();
        expect(() => taskStore.addTask({ title: 'No comment or selector' })).toThrow();
    });

    test('should handle empty or null inputs', () => {
        expect(() => createTaskObject(null)).toThrow();
        expect(() => validateTaskObject(null)).toThrow();
        expect(sortTasksByTimestamp([])).toEqual([]);
    });
});

describe('Legacy task file operations', () => {
    let fixture;
    let taskStore;

    beforeEach(() => {
        fixture = directoryFixture();
        taskStore = new TaskStore();
        taskStore.initialize(fixture.directory);
    });

    afterEach(() => fixture.cleanup());

    test('saves and reloads task data using the selected directory handle', async () => {
        const task = await taskStore.addTaskAndSave({ title: 'Test Task', comment: 'Test comment', selector: '.test' });
        expect(JSON.parse(fixture.read('moat-tasks-detail.json'))).toMatchObject([
            { id: task.id, comment: 'Test comment', status: 'to do' }
        ]);

        const reloaded = new TaskStore();
        reloaded.initialize(fixture.directory);
        expect(await reloaded.loadTasksFromFile()).toMatchObject([{ id: task.id, selector: '.test' }]);
    });

    test('creates a timestamped backup containing the saved tasks', async () => {
        const task = await taskStore.addTaskAndSave({ title: 'Test Task', comment: 'Test comment' });
        expect(await taskStore.createBackup()).toBe(true);
        const backup = fs.readdirSync(fixture.root).find(name => /^moat-tasks-detail\.backup\..*\.json$/.test(name));
        expect(backup).toBeDefined();
        expect(JSON.parse(fixture.read(backup))).toMatchObject([{ id: task.id, comment: 'Test comment' }]);
    });

    test('reports malformed legacy JSON without overwriting it', async () => {
        fs.writeFileSync(path.join(fixture.root, 'moat-tasks-detail.json'), '{invalid json');
        await expect(taskStore.loadTasksFromFile()).rejects.toThrow('Failed to load tasks');
        expect(fixture.read('moat-tasks-detail.json')).toBe('{invalid json');
    });

    test('cannot create a backup without a directory', async () => {
        expect(await new TaskStore().createBackup()).toBe(false);
    });
});
