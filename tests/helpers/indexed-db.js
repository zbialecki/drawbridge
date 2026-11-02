// Callback-style IndexedDB subset. Handles remain references, not browser structured clones.
function indexedDBFixture() {
  const databases = new Map();
  const state = { fail: null };
  function request(operation, action) {
    const result = {};
    queueMicrotask(() => {
      try {
        if (state.fail === operation) throw new Error(`${operation} denied`);
        result.result = action(result);
        result.onsuccess?.({ target: result });
      } catch (error) {
        result.error = error;
        result.onerror?.({ target: result });
      }
    });
    return result;
  }
  const indexedDB = {
    open(name, version) {
      return request('open', req => {
        let db = databases.get(name);
        if (!db) {
          const stores = new Map();
          db = {
            version,
            objectStoreNames: { contains: key => stores.has(key) },
            createObjectStore(key, { keyPath }) {
              const data = new Map();
              const store = {
                indexNames: [],
                createIndex(index) { this.indexNames.push(index); },
                put: value => request('put', () => {
                  if (value[keyPath] == null) throw new Error('Missing primary key');
                  data.set(value[keyPath], { ...value });
                  return value[keyPath];
                }),
                get: id => request('get', () => data.has(id) ? { ...data.get(id) } : undefined),
                delete: id => request('delete', () => { data.delete(id); }),
                getAll: () => request('getAll', () => [...data.values()].map(value => ({ ...value })))
              };
              stores.set(key, store);
              return store;
            },
            transaction(names) {
              return { objectStore(key) {
                if (!names.includes(key) || !stores.has(key)) throw new Error(`Missing object store: ${key}`);
                return stores.get(key);
              } };
            }
          };
          databases.set(name, db);
          req.result = db;
          req.onupgradeneeded?.({ target: req, oldVersion: 0, newVersion: version });
        }
        return db;
      });
    }
  };
  return { indexedDB, state };
}
module.exports = { indexedDBFixture };
