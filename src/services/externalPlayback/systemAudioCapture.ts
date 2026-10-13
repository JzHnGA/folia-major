// src/services/externalPlayback/systemAudioCapture.ts
// Captures macOS system audio through Electron's display-media loopback so the spectrum can follow a song that
// Music.app plays. Only the analyser is exposed: the stream is never connected to the destination (no echo).

export interface SystemAudioCapture {
    analyser: AnalyserNode;
    stop(): void;
}

// Matches the main analyser built in usePlaybackAudioBridge, so both feed the visualizer the same way.
const ANALYSER_FFT_SIZE = 2048;
const ANALYSER_SMOOTHING = 0.6;

// Asks for the system audio loopback and wires it into a fresh AnalyserNode on `context`.
// Permission and constraint errors from getDisplayMedia are rethrown as they are; the caller decides how to report them.
export async function startSystemAudioCapture(
    context: AudioContext,
    mediaDevices: Pick<MediaDevices, 'getDisplayMedia'> = navigator.mediaDevices,
): Promise<SystemAudioCapture> {
    const stream = await mediaDevices.getDisplayMedia({ video: true, audio: true });
    // getDisplayMedia insists on a video track; only the audio is wanted, so the screen capture is dropped at once.
    stream.getVideoTracks().forEach(track => track.stop());
    const stopTracks = () => stream.getTracks().forEach(track => track.stop());

    if (stream.getAudioTracks().length === 0) {
        stopTracks();
        throw new Error('no-system-audio');
    }

    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = ANALYSER_FFT_SIZE;
        analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
        source.connect(analyser);
    } catch (error) {
        stopTracks();
        throw error;
    }

    let stopped = false;
    return {
        analyser,
        stop() {
            if (stopped) return;
            stopped = true;
            // Disconnecting a node that is already detached must not keep the tracks (and the recording indicator) alive.
            try { source.disconnect(); } catch { /* already disconnected */ }
            try { analyser.disconnect(); } catch { /* already disconnected */ }
            stopTracks();
        },
    };
}
