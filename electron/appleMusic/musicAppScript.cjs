// electron/appleMusic/musicAppScript.cjs
// The JXA program osascript keeps running as a long-lived child process: one JSON request per stdin line,
// one JSON response per stdout line. It is embedded as a string so packaging cannot leave the file behind.
// String.raw keeps the backslashes in the script (\n, regex escapes) exactly as written.

module.exports = {
  MUSIC_APP_JXA_SOURCE: String.raw`ObjC.import('Foundation');

// One JSON response per line on stdout.
function respond(message) {
  const text = $(JSON.stringify(message) + '\n');
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(text.dataUsingEncoding($.NSUTF8StringEncoding));
}
function fail(number, message) { const error = new Error(message); error.errorNumber = number; throw error; }

const music = () => Application('Music');
// running() is answered locally and never triggers the Automation prompt.
const isRunning = () => Application('Music').running();
const requireRunning = () => { if (!isRunning()) fail(-600, 'Music is not running'); };

function findTrack(id) {
  const hits = music().libraryPlaylists[0].tracks.whose({ persistentID: id })();
  if (!hits.length) fail(-1728, 'Track not found');
  return hits[0];
}
function record(track) {
  return { id: track.persistentID(), name: track.name(), artist: track.artist(), albumArtist: track.albumArtist(),
    album: track.album(), duration: track.duration(), mediaKind: track.mediaKind() };
}
// Reads each property for the whole list in one Apple Event: 3.8k tracks in ~150 ms.
function bulk(tracks) {
  const ids = tracks.persistentID();
  if (!ids.length) return [];
  const names = tracks.name(), artists = tracks.artist(), albumArtists = tracks.albumArtist(),
    albums = tracks.album(), durations = tracks.duration(), kinds = tracks.mediaKind();
  return ids.map((id, i) => ({ id, name: names[i], artist: artists[i], albumArtist: albumArtists[i],
    album: albums[i], duration: durations[i], mediaKind: kinds[i] }));
}

const handlers = {
  // No Apple Event here: an event would raise the Automation prompt for users who never chose Apple Music.
  probe() { return { running: isRunning(), permission: 'unknown' }; },
  listPlaylists() {
    const lists = music().userPlaylists;
    const ids = lists.persistentID(), names = lists.name(), kinds = lists.specialKind(), smart = lists.smart();
    const out = [{ id: 'library', name: '', kind: 'library' }];
    ids.forEach((id, i) => { if (kinds[i] === 'none') out.push({ id, name: names[i], kind: smart[i] ? 'smart' : 'user' }); });
    return out;
  },
  getPlaylistTracks({ playlistId }) {
    const list = playlistId === 'library'
      ? music().libraryPlaylists[0]
      : music().userPlaylists.whose({ persistentID: playlistId })()[0];
    if (!list) fail(-1728, 'Playlist not found');
    return bulk(list.tracks).filter(track => track.mediaKind === 'song');
  },
  // Collects songs until the limit is reached; slicing before the song filter let music videos shorten a full reply.
  searchLibrary({ query, limit }) {
    const hits = music().search(music().libraryPlaylists[0], { for: query, only: 'all' }) || [];
    const songs = [];
    for (let i = 0; i < hits.length && songs.length < limit; i += 1) {
      const track = record(hits[i]);
      if (track.mediaKind === 'song') songs.push(track);
    }
    return songs;
  },
  getTrack({ id }) { return record(findTrack(id)); },
  // rawData() arrives as the descriptor text 'tdta'($<HEX>$); hand back only the hex.
  getArtwork({ id }) {
    const artworks = findTrack(id).artworks();
    if (!artworks.length) return null;
    const match = /^'[a-zA-Z ]{4}'\(\$([0-9A-Fa-f]+)\$\)$/.exec(String(artworks[0].rawData()));
    return match ? { hex: match[1] } : null;
  },
  // Already playing this track (wallpaper relaunch handoff): only correct the position.
  // Music.app ignores play's 'once' option, so auto-advance is handled by the renderer.
  play({ id, position }) {
    const app = music();
    try {
      if (app.playerState() === 'playing' && app.currentTrack.persistentID() === id) {
        if (Math.abs(app.playerPosition() - position) > 1) app.playerPosition = position;
        return null;
      }
    } catch (error) { /* no current track */ }
    app.play(findTrack(id));
    if (position > 0.5) app.playerPosition = position;
    return null;
  },
  pause() { requireRunning(); music().pause(); return null; },
  resume() { requireRunning(); music().play(); return null; },
  seek({ position }) { requireRunning(); music().playerPosition = position; return null; },
  setVolume({ volume }) { requireRunning(); music().soundVolume = volume; return null; },
  stop() { if (isRunning()) music().stop(); return null; },
  getState() {
    if (!isRunning()) return { state: 'stopped', persistentId: null, position: 0, duration: null };
    const app = music();
    let persistentId = null, duration = null;
    try { persistentId = app.currentTrack.persistentID(); duration = app.currentTrack.duration(); } catch (error) { /* none */ }
    return { state: app.playerState(), persistentId, position: app.playerPosition() || 0, duration };
  },
};

function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  let buffer = '';
  for (;;) {
    const chunk = input.availableData;
    // NSData.length crosses the bridge as a string; comparing with === 0 never matched and spun at 100% CPU on EOF.
    if (Number(chunk.length) === 0) return;
    buffer += $.NSString.alloc.initWithDataEncoding(chunk, $.NSUTF8StringEncoding).js;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request;
      try { request = JSON.parse(line); } catch (error) { continue; }
      try {
        const handler = handlers[request.op];
        if (!handler) fail(-1708, 'Unknown op');
        const data = handler(request.args || {});
        respond({ id: request.id, ok: true, data: data === undefined ? null : data });
      } catch (error) {
        respond({ id: request.id, ok: false, error: {
          number: typeof error.errorNumber === 'number' ? error.errorNumber : null,
          message: String((error && error.message) || error) } });
      }
    }
  }
}
`,
};
