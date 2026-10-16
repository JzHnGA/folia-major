// electron/appleMusic/systemAudioLoopback.cjs
// The session's display-media handler behind the Apple Music spectrum: the renderer calls getDisplayMedia to hear
// system audio (Music.app's output), and this grants it the first screen plus audio 'loopback' - but only to the
// trusted main window's top frame, and only right after Folia's own capture code armed a one-shot gate over IPC.
// Without that arming, any other script in the main renderer (a mod's client code, say) calling getDisplayMedia
// is refused, so it cannot get silent screen and system audio. Anything else, or any failure (macOS "Screen &
// System Audio Recording" not granted makes getSources reject), answers with an empty grant, which the renderer
// sees as a rejected call.
// Imports nothing from Electron and takes every dependency by injection, so it is unit-testable.

// A one-shot arming for the next display-media request of one webContents. arm() is called when Folia is about to
// ask for the capture itself; consume() is called by the handler and always disarms, so a stale or mismatched
// attempt cannot be retried. The arming also expires, in case the request never arrives.
function createSystemAudioCaptureGate({ now = () => Date.now(), armWindowMs = 5000 } = {}) {
  let armed = null;

  const isLive = () => armed !== null && now() <= armed.until;

  return {
    arm(webContentsId) {
      armed = { id: webContentsId, until: now() + armWindowMs };
    },
    consume(webContentsId) {
      const live = isLive();
      const matches = live && armed.id === webContentsId;
      armed = null;
      return matches;
    },
    isArmed: isLive,
  };
}

// Builds the (request, callback) handler for session.setDisplayMediaRequestHandler.
function createDisplayMediaHandler({ isTrustedMainWindowContents, getWebContentsFromFrame, getScreenSources, gate }) {
  const isTrustedTopFrameRequest = (request) => {
    try {
      const frame = request && request.frame;
      if (!frame || frame.parent !== null) return false;
      if (request.audioRequested !== true) return false;
      const webContents = getWebContentsFromFrame(frame);
      if (!isTrustedMainWindowContents(webContents)) return false;
      // Last on purpose: only a request that is otherwise acceptable may spend the arming.
      return Boolean(webContents && gate && gate.consume(webContents.id));
    } catch {
      return false;
    }
  };

  return (request, callback) => {
    if (!isTrustedTopFrameRequest(request)) {
      callback({});
      return;
    }

    // Two-argument then: a throwing callback must not be answered a second time by the failure branch.
    Promise.resolve()
      .then(() => getScreenSources())
      .then(
        (sources) => {
          const screen = Array.isArray(sources) ? sources[0] : null;
          callback(screen ? { video: screen, audio: 'loopback' } : {});
        },
        () => callback({}),
      );
  };
}

module.exports = { createDisplayMediaHandler, createSystemAudioCaptureGate };
