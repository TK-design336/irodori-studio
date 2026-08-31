/** IndexedDB audio cache: chunks keyed by hash, grouped by page for concat/eviction. */

const DB_NAME = "irodori-reader-cache";
const DB_VERSION = 2;
const STORE = "audio";
const META = "meta";
const PAGES = "pages";
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
      if (!db.objectStoreNames.contains(PAGES)) {
        const p = db.createObjectStore(PAGES, { keyPath: "key" });
        p.createIndex("lastAccess", "lastAccess");
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

export async function pageCacheKey({ url, speakerId, chunkChars }) {
  return sha256Hex(["page", url || "", speakerId || "", String(chunkChars ?? "")].join("\0"));
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

/**
 * Replace the page index and drop audio that no longer belongs to this page.
 */
export async function beginPageCache({ url, title, speakerId, chunkChars, chunks }) {
  const key = await pageCacheKey({ url, speakerId, chunkChars });
  const texts = (chunks || []).map((t) => String(t || ""));
  const db = await openDb();
  const old = await new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES, "readonly");
    const g = tx.objectStore(PAGES).get(key);
    g.onsuccess = () => resolve(g.result || null);
    g.onerror = () => reject(g.error);
  });
  const staleKeys = [];
  if (old?.audioKeys?.length) {
    for (let i = 0; i < old.audioKeys.length; i++) {
      const prevText = old.chunks?.[i];
      const nextText = texts[i];
      if (prevText !== nextText && old.audioKeys[i]) staleKeys.push(old.audioKeys[i]);
    }
    if (old.audioKeys.length > texts.length) {
      for (let i = texts.length; i < old.audioKeys.length; i++) {
        if (old.audioKeys[i]) staleKeys.push(old.audioKeys[i]);
      }
    }
  }
  const audioKeys = texts.map((_, i) => (old?.chunks?.[i] === texts[i] ? old.audioKeys[i] : "") || "");
  await new Promise((resolve, reject) => {
    const tx = db.transaction([PAGES, STORE], "readwrite");
    tx.objectStore(PAGES).put({
      key,
      url: url || "",
      title: title || "",
      speakerId: speakerId || "",
      chunkChars: chunkChars ?? 0,
      chunks: texts,
      audioKeys,
      size: old?.size || 0,
      lastAccess: Date.now(),
    });
    const store = tx.objectStore(STORE);
    for (const k of staleKeys) store.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return key;
}

export async function rememberPageChunk({
  url,
  title,
  speakerId,
  chunkChars,
  index,
  text,
  audioKey,
  blobSize,
}) {
  const key = await pageCacheKey({ url, speakerId, chunkChars });
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES, "readwrite");
    const store = tx.objectStore(PAGES);
    const g = store.get(key);
    g.onsuccess = () => {
      const now = Date.now();
      const row = g.result || {
        key,
        url: url || "",
        title: title || "",
        speakerId: speakerId || "",
        chunkChars: chunkChars ?? 0,
        chunks: [],
        audioKeys: [],
        size: 0,
        lastAccess: now,
      };
      if (title) row.title = title;
      if (index >= row.chunks.length) {
        row.chunks.length = index + 1;
        row.audioKeys.length = index + 1;
      }
      const prevKey = row.audioKeys[index];
      row.chunks[index] = text;
      row.audioKeys[index] = audioKey;
      if (blobSize && prevKey !== audioKey) {
        row.size = (row.size || 0) + blobSize;
      }
      row.lastAccess = now;
      store.put(row);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putPageAudio({
  url,
  title,
  speakerId,
  chunkChars,
  index,
  text,
  blob,
}) {
  const key = await cacheKey({ url, text, speakerId, speed: 1 });
  await putCached(key, blob);
  await rememberPageChunk({
    url,
    title,
    speakerId,
    chunkChars,
    index,
    text,
    audioKey: key,
    blobSize: blob.size || 0,
  });
  return key;
}

export async function loadCachedPageAudio({ url, speakerId, chunks }) {
  const blobs = [];
  const missing = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    const key = await cacheKey({ url, text, speakerId, speed: 1 });
    const blob = await getCached(key);
    if (blob) blobs.push(blob);
    else {
      blobs.push(null);
      missing.push(i);
    }
  }
  return { blobs, missing };
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

async function deletePage(db, page) {
  await new Promise((resolve, reject) => {
    const tx = db.transaction([PAGES, STORE], "readwrite");
    const store = tx.objectStore(STORE);
    for (const k of page.audioKeys || []) {
      if (k) store.delete(k);
    }
    tx.objectStore(PAGES).delete(page.key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function evictIfNeeded() {
  const db = await openDb();
  let size = await totalSize(db);
  if (size <= MAX_BYTES) return;

  const pages = await new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(PAGES)) {
      resolve([]);
      return;
    }
    const tx = db.transaction(PAGES, "readonly");
    const req = tx.objectStore(PAGES).index("lastAccess").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  pages.sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0));
  for (const page of pages) {
    if (size <= MAX_BYTES * 0.85) break;
    await deletePage(db, page);
    size -= page.size || 0;
  }

  size = await totalSize(db);
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
    const names = [STORE];
    if (db.objectStoreNames.contains(PAGES)) names.push(PAGES);
    const tx = db.transaction(names, "readwrite");
    tx.objectStore(STORE).clear();
    if (db.objectStoreNames.contains(PAGES)) tx.objectStore(PAGES).clear();
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
  let pageCount = 0;
  if (db.objectStoreNames.contains(PAGES)) {
    pageCount = await new Promise((resolve, reject) => {
      const tx = db.transaction(PAGES, "readonly");
      const req = tx.objectStore(PAGES).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }
  return {
    count: rows.length,
    pageCount,
    bytes: rows.reduce((a, r) => a + (r.size || 0), 0),
    maxBytes: MAX_BYTES,
  };
}
