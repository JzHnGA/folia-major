// electron/appleMusic/artworkIndex.cjs
// Remembers which cover asset belongs to which Music track. It lives in its own file (not the shared settings
// store, which is cloned to the renderer and fully rewritten on every change). Storage is injected so the module
// stays free of Electron and fs and can be unit-tested with fake timers.

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// read() returns the persisted plain object (it may throw or return anything: a bad file just means an empty
// index); write(plainObject) persists it. Entries are ordered from least to most recently set, the oldest go
// first once `limit` is exceeded, and writes are coalesced into one that runs `debounceMs` after the first change.
function createArtworkIndex({
  read,
  write,
  limit = 5000,
  debounceMs = 1000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let entries = null;
  let timer = null;
  let pending = false;

  function trim(map) {
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  // Reads the persisted index on first use only.
  function load() {
    if (entries) return entries;
    let stored = null;
    try {
      stored = read();
    } catch {
      stored = null;
    }
    entries = new Map(isRecord(stored) ? Object.entries(stored).filter(([, assetId]) => typeof assetId === 'string') : []);
    trim(entries);
    return entries;
  }

  // Cancels the scheduled write and persists the current entries now; a failing write is logged, never thrown.
  function persist() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending = false;
    try {
      write(Object.fromEntries(entries));
    } catch (error) {
      console.warn('[AppleMusic] artwork index write failed:', error && error.message);
    }
  }

  function get(trackId) {
    return load().get(trackId);
  }

  // A new or changed mapping becomes the most recent one; setting the value it already has changes nothing.
  function set(trackId, assetId) {
    const map = load();
    if (map.get(trackId) === assetId) return;
    map.delete(trackId);
    map.set(trackId, assetId);
    trim(map);
    pending = true;
    if (timer === null) {
      timer = setTimer(() => {
        timer = null;
        persist();
      }, debounceMs);
    }
  }

  // Writes a pending change right away (used on quit); does nothing when nothing changed.
  function flush() {
    if (pending) persist();
  }

  // Empties the index and persists the empty object immediately, without reading the old file first.
  function clear() {
    entries = new Map();
    persist();
  }

  return { get, set, flush, clear };
}

module.exports = { createArtworkIndex };
