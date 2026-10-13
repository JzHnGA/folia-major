// electron/appleMusic/systemAudioLoopback.cjs
// The session's display-media handler behind the Apple Music spectrum: the renderer calls getDisplayMedia to hear
// system audio (Music.app's output), and this grants it the first screen plus audio 'loopback' - but only to the
// trusted main window's top frame. Anything else, or any failure (macOS "Screen & System Audio Recording"
// not granted makes getSources reject), answers with an empty grant, which the renderer sees as a rejected call.
// Imports nothing from Electron and takes every dependency by injection, so it is unit-testable.

// Builds the (request, callback) handler for session.setDisplayMediaRequestHandler.
function createDisplayMediaHandler({ isTrustedMainWindowContents, getWebContentsFromFrame, getScreenSources }) {
  const isTrustedTopFrameRequest = (request) => {
    try {
      const frame = request && request.frame;
      if (!frame || frame.parent !== null) return false;
      if (request.audioRequested !== true) return false;
      return Boolean(isTrustedMainWindowContents(getWebContentsFromFrame(frame)));
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

module.exports = { createDisplayMediaHandler };
