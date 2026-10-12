const { createHash } = require('crypto');
const { StringDecoder } = require('string_decoder');
const { MUSIC_APP_JXA_SOURCE } = require('./musicAppScript.cjs');

// electron/appleMusic/musicAppBridge.cjs
// Drives macOS Music.app through one long-lived `osascript -l JavaScript` child: stdin/stdout carry one JSON
// object per line, every request has an id and a timeout, and a dead child is restarted lazily with backoff.
// The module imports nothing from Electron and takes every dependency by injection, so it is unit-testable
// with a fake spawn. It never throws and request() never rejects: failures come back as provider error codes.

const ID_PATTERN = /^[0-9A-F]{16}$/i;
const MAX_QUERY_LENGTH = 200;
const MAX_SEARCH_LIMIT = 100;
const STDERR_LOG_LIMIT = 200;

const isPersistentId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isPlaylistId = (value) => value === 'library' || isPersistentId(value);
const isQuery = (value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_QUERY_LENGTH;
const isLimit = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_SEARCH_LIMIT;
const isPosition = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isVolume = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

// Each entry validates and rebuilds the arguments sent to the script (null means invalid), so only known
// fields ever reach the JXA process. `list` operations get the long timeout.
const OPERATIONS = {
  probe: { prepare: () => ({}) },
  listPlaylists: { prepare: () => ({}), list: true },
  getPlaylistTracks: { prepare: (args) => (isPlaylistId(args.playlistId) ? { playlistId: args.playlistId } : null), list: true },
  searchLibrary: {
    prepare: (args) => (isQuery(args.query) && isLimit(args.limit) ? { query: args.query, limit: args.limit } : null),
    list: true,
  },
  getTrack: { prepare: (args) => (isPersistentId(args.id) ? { id: args.id } : null) },
  getArtwork: { prepare: (args) => (isPersistentId(args.id) ? { id: args.id } : null) },
  play: { prepare: (args) => (isPersistentId(args.id) && isPosition(args.position) ? { id: args.id, position: args.position } : null) },
  pause: { prepare: () => ({}) },
  resume: { prepare: () => ({}) },
  seek: { prepare: (args) => (isPosition(args.position) ? { position: args.position } : null) },
  // The script takes Music's 0-100 scale; callers speak 0..1.
  setVolume: { prepare: (args) => (isVolume(args.volume) ? { volume: Math.round(args.volume * 100) } : null) },
  stop: { prepare: () => ({}) },
  getState: { prepare: () => ({}) },
};

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

// Maps an AppleScript error number reported by the script to a provider error code.
function scriptFailure(error) {
  const number = error && typeof error.number === 'number' ? error.number : null;
  const message = String((error && error.message) || 'Music app error').slice(0, 300);
  if (number === -1743) return failure('auth-required', message);
  if (number === -1728) return failure('not-playable', message);
  return failure('unavailable', message);
}

// Music reports 'fast forwarding' / 'rewinding' while it is still producing audio, so both count as playing.
function normalizePlayerState(raw) {
  if (raw === 'playing' || raw === 'fast forwarding' || raw === 'rewinding') return 'playing';
  if (raw === 'paused') return 'paused';
  return 'stopped';
}

// Picks the container format from the leading magic bytes; anything else is not a cover we can serve.
function detectImageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function createMusicAppBridge({
  spawn,
  platform = process.platform,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onState = () => {},
  artwork,
  artworkIndex,
  controlTimeoutMs = 8000,
  listTimeoutMs = 30000,
  pollIntervalMs = 1000,
  startupPollIntervalMs = 250,
  startupPollWindowMs = 8000,
  restartDelaysMs = [500, 2000, 10000],
} = {}) {
  const available = platform === 'darwin';
  const pending = new Map();
  let child = null;
  let decoder = null;
  let partialLine = '';
  let nextId = 1;
  let consecutiveFailures = 0;
  let spawnNotBefore = 0;
  let restartTimer = null;
  let disposed = false;
  let monitoring = false;
  let pollTimer = null;
  let pollInFlight = false;
  let startupPollUntil = 0;
  let ownsPlayback = false;

  // --- process lifecycle ---

  // Resolves one request exactly once and releases its timer.
  function settle(entry, result) {
    if (!pending.delete(entry.id)) return;
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.resolve(result);
  }

  function failAll(code, message) {
    for (const entry of [...pending.values()]) settle(entry, failure(code, message));
  }

  function writePending(entry) {
    if (!child || entry.written) return;
    entry.written = true;
    entry.sentAt = now();
    try {
      child.stdin.write(entry.line);
    } catch {
      settle(entry, failure('network', 'Music app bridge write failed'));
    }
  }

  function flushPending() {
    for (const entry of [...pending.values()]) writePending(entry);
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    consecutiveFailures = 0;
    const receivedAt = now();
    if (message.ok === true) settle(entry, { ok: true, data: message.data === undefined ? null : message.data, sentAt: entry.sentAt, receivedAt });
    else settle(entry, scriptFailure(message.error));
  }

  function handleStdout(proc, chunk) {
    if (proc !== child) return;
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let start = 0;
    let newline;
    while ((newline = text.indexOf('\n', start)) >= 0) {
      const line = (partialLine + text.slice(start, newline)).trim();
      partialLine = '';
      start = newline + 1;
      if (line) handleLine(line);
    }
    partialLine += text.slice(start);
  }

  // Counts one more failure in a row and blocks respawning until the matching restart delay has passed.
  function recordFailure() {
    consecutiveFailures += 1;
    const delay = restartDelaysMs[Math.min(consecutiveFailures, restartDelaysMs.length) - 1] ?? 0;
    spawnNotBefore = now() + delay;
  }

  // The child is gone (exit or spawn error): fail what was in flight and start the backoff.
  function handleGone(proc) {
    if (proc !== child) return;
    child = null;
    decoder = null;
    partialLine = '';
    recordFailure();
    for (const entry of [...pending.values()]) {
      if (entry.written) settle(entry, failure('network', 'Music app bridge process exited'));
    }
  }

  function startChild() {
    let proc;
    try {
      proc = spawn('osascript', ['-l', 'JavaScript', '-e', MUSIC_APP_JXA_SOURCE]);
    } catch {
      // Treated like an immediate exit so the usual backoff applies.
      recordFailure();
      failAll('network', 'Music app bridge could not start');
      return;
    }
    child = proc;
    decoder = new StringDecoder('utf8');
    partialLine = '';
    proc.stdout.on('data', (chunk) => handleStdout(proc, chunk));
    proc.stderr.on('data', (chunk) => {
      console.warn('[AppleMusic] osascript stderr:', String(chunk).slice(0, STDERR_LOG_LIMIT));
    });
    // A broken pipe on stdin would otherwise surface as an uncaught error in the main process.
    if (proc.stdin && typeof proc.stdin.on === 'function') proc.stdin.on('error', () => {});
    proc.on('exit', () => handleGone(proc));
    proc.on('error', () => handleGone(proc));
    flushPending();
  }

  // Starts the child now, or after the remaining backoff when it died recently.
  function ensureChild() {
    if (disposed || child) return;
    const wait = spawnNotBefore - now();
    if (wait > 0) {
      if (restartTimer !== null) return;
      restartTimer = setTimer(() => {
        restartTimer = null;
        if (disposed || child) return;
        if ([...pending.values()].some((entry) => !entry.written)) startChild();
      }, wait);
      return;
    }
    startChild();
  }

  // Queues one line for the script; the timeout covers any backoff wait as well, so callers are never left hanging.
  function dispatch(op, args, timeoutMs) {
    return new Promise((resolve) => {
      const id = nextId;
      nextId += 1;
      const entry = { id, resolve, line: JSON.stringify({ id, op, args }) + '\n', timer: null, written: false, sentAt: 0 };
      pending.set(id, entry);
      entry.timer = setTimer(() => settle(entry, failure('network', 'Music app bridge timed out')), timeoutMs);
      if (child) writePending(entry);
      else ensureChild();
    });
  }

  // --- result shaping ---

  function shapeTrack(raw) {
    if (!isRecord(raw) || typeof raw.id !== 'string') return null;
    const track = { id: raw.id, name: raw.name, artist: raw.artist, albumArtist: raw.albumArtist, album: raw.album, duration: raw.duration };
    const artworkAssetId = artworkIndex ? artworkIndex.get(raw.id) : undefined;
    if (artworkAssetId) track.artworkAssetId = artworkAssetId;
    return track;
  }

  function shapeTrackList(data) {
    if (!Array.isArray(data)) return failure('invalid-response', 'Music app returned an unexpected track list');
    return { ok: true, data: data.map(shapeTrack).filter(Boolean) };
  }

  function shapePlaylists(data) {
    if (!Array.isArray(data)) return failure('invalid-response', 'Music app returned an unexpected playlist list');
    const playlists = data
      .filter((item) => isRecord(item) && typeof item.id === 'string')
      .map((item) => ({ id: item.id, name: item.name, kind: item.kind }));
    return { ok: true, data: playlists };
  }

  function shapeState(raw, sentAt, receivedAt) {
    if (!isRecord(raw)) return failure('invalid-response', 'Music app returned an unexpected player state');
    const position = typeof raw.position === 'number' && Number.isFinite(raw.position) ? raw.position : 0;
    const duration = typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? raw.duration : null;
    return {
      ok: true,
      data: {
        state: normalizePlayerState(raw.state),
        mediaId: typeof raw.persistentId === 'string' ? raw.persistentId : null,
        positionSec: position,
        durationSec: duration,
        // The position was read somewhere between sending and receiving; the midpoint is the best estimate.
        sampledAtMs: (sentAt + receivedAt) / 2,
      },
    };
  }

  // Decodes the hex the script extracted, stores the image under its content hash and records it for the track.
  async function storeArtwork(trackId, data) {
    if (!artwork || !isRecord(data) || typeof data.hex !== 'string') return { ok: true, data: null };
    const hex = data.hex;
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return { ok: true, data: null };
    const bytes = Buffer.from(hex, 'hex');
    const mime = detectImageMime(bytes);
    if (!mime) return { ok: true, data: null };
    const assetId = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    if (!(await artwork.has(assetId))) await artwork.write(assetId, bytes, mime);
    if (artworkIndex) artworkIndex.set(trackId, assetId);
    return { ok: true, data: { assetId } };
  }

  async function shapeResult(op, prepared, raw) {
    switch (op) {
      case 'getPlaylistTracks':
      case 'searchLibrary':
        return shapeTrackList(raw.data);
      case 'listPlaylists':
        return shapePlaylists(raw.data);
      case 'getTrack': {
        const track = shapeTrack(raw.data);
        return track ? { ok: true, data: track } : failure('invalid-response', 'Music app returned an unexpected track');
      }
      case 'getArtwork':
        return storeArtwork(prepared.id, raw.data);
      case 'getState':
        return shapeState(raw.data, raw.sentAt, raw.receivedAt);
      default:
        return { ok: true, data: raw.data };
    }
  }

  // --- state polling ---

  function pushState(state) {
    try {
      onState(state);
    } catch {
      /* a failing listener must not break the bridge */
    }
  }

  // Queries the player once and hands the result to onState; poll results are dropped once monitoring is off.
  async function refreshState(fromPoll) {
    const result = await request('getState', {});
    if (result.ok && (!fromPoll || monitoring)) pushState(result.data);
  }

  const currentPollInterval = () => (now() < startupPollUntil ? startupPollIntervalMs : pollIntervalMs);

  function schedulePoll() {
    if (pollTimer !== null) clearTimer(pollTimer);
    pollTimer = monitoring && !disposed ? setTimer(pollTick, currentPollInterval()) : null;
  }

  // One poll per tick; while the previous poll is unanswered the tick is skipped so a slow script never gets a queue.
  function pollTick() {
    pollTimer = null;
    if (!monitoring || disposed) return;
    if (!pollInFlight) {
      pollInFlight = true;
      refreshState(true).finally(() => { pollInFlight = false; });
    }
    schedulePoll();
  }

  // Bookkeeping after a command succeeded: playback ownership, the faster startup polling, and an immediate state read.
  function afterSuccess(op) {
    if (op === 'play') {
      ownsPlayback = true;
      startupPollUntil = now() + startupPollWindowMs;
      if (monitoring) schedulePoll();
    } else if (op === 'stop') {
      ownsPlayback = false;
    }
    if (op === 'play' || op === 'pause' || op === 'resume' || op === 'seek') void refreshState(false);
  }

  // --- public surface ---

  // Validates the operation, runs it through the script and shapes the answer. Always resolves.
  async function request(op, args = {}) {
    try {
      if (!available) return failure('unavailable', 'Apple Music control is only available on macOS');
      if (disposed) return failure('unavailable', 'Music app bridge is disposed');
      const spec = typeof op === 'string' && Object.prototype.hasOwnProperty.call(OPERATIONS, op) ? OPERATIONS[op] : null;
      if (!spec) return failure('unsupported', 'Unsupported Music app operation');
      const input = args === undefined || args === null ? {} : args;
      if (!isRecord(input)) return failure('invalid-response', 'Invalid Music app arguments');
      const prepared = spec.prepare(input);
      if (!prepared) return failure('invalid-response', 'Invalid Music app arguments');
      const raw = await dispatch(op, prepared, spec.list ? listTimeoutMs : controlTimeoutMs);
      if (!raw.ok) return raw;
      const result = await shapeResult(op, prepared, raw);
      if (result.ok) afterSuccess(op);
      return result;
    } catch {
      return failure('invalid-response', 'Music app operation failed');
    }
  }

  function setMonitoring(active) {
    if (!available || disposed) return;
    const next = Boolean(active);
    if (next === monitoring) return;
    monitoring = next;
    schedulePoll();
  }

  // On quit: stop Music only when Folia's own `play` is the last thing that happened to it.
  async function stopIfOwned() {
    if (!ownsPlayback) return;
    await request('stop', {});
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    monitoring = false;
    if (pollTimer !== null) clearTimer(pollTimer);
    pollTimer = null;
    if (restartTimer !== null) clearTimer(restartTimer);
    restartTimer = null;
    failAll('unavailable', 'Music app bridge is disposed');
    const proc = child;
    child = null;
    if (!proc) return;
    try {
      if (proc.stdin && typeof proc.stdin.end === 'function') proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      if (typeof proc.kill === 'function') proc.kill();
    } catch {
      /* already gone */
    }
  }

  return { isAvailable: () => available, request, setMonitoring, stopIfOwned, dispose };
}

module.exports = { createMusicAppBridge };
