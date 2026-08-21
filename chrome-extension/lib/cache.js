/** IndexedDB audio cache: key = hash(url + text + speakerId + speed). */

const DB_NAME = "irodori-reader-cache";
const DB_VERSION = 1;
const STORE = "audio";
const META = "meta";
const MAX_BYTES = 500 * 1024 * 1024;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "key" });
        s.createIndex("lastAccess", "lastAccess");
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cacheKey({ url, text, speakerId, speed }) {
  return sha256Hex([url || "", text, speakerId || "", String(speed ?? 1)].join("\0"));
}

export async function getCached(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const g = store.get(key);
    g.onsuccess = () => {
      const row = g.result;
      if (!row) {
        resolve(null);
        return;
      }
      row.lastAccess = Date.now();
      store.put(row);
      resolve(row.blob);
    };
    g.onerror = () => reject(g.error);
  });
}

export async function putCached(key, blob) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      key,
      blob,
      size: blob.size || 0,
      lastAccess: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await evictIfNeeded();
}

async function totalSize(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = req.result || [];
      resolve(rows.reduce((a, r) => a + (r.size || 0), 0));
    };
    req.onerror = () => reject(req.error);
  });
}

async function evictIfNeeded() {
  const db = await openDb();
  let size = await totalSize(db);
  if (size <= MAX_BYTES) return;
  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("lastAccess").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  rows.sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0));
  for (const row of rows) {
    if (size <= MAX_BYTES * 0.85) break;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(row.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    size -= row.size || 0;
  }
}

export async function clearCache() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function cacheStats() {
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return {
    count: rows.length,
    bytes: rows.reduce((a, r) => a + (r.size || 0), 0),
    maxBytes: MAX_BYTES,
  };
}
