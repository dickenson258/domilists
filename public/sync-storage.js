// Large libraries can exceed the localStorage limit. Keep their current copy in IndexedDB.
let database;
function openDatabase() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open('domi-library', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => { database = null; throw error; });
  return database;
}

async function readSnapshot(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('snapshots').objectStore('snapshots').get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeSnapshot(key, serialized) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put(serialized, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('storage_aborted'));
  });
}

export const readLargeLibrary = () => readSnapshot('library');
export const writeLargeLibrary = (serialized) => writeSnapshot('library', serialized);
export const readSyncBackup = () => readSnapshot('sync-backup');
export const writeSyncBackup = (serialized) => writeSnapshot('sync-backup', serialized);
