// src/services/externalPlayback/systemAudioCapture.ts
// Captures macOS system audio through Electron's display-media loopback so the spectrum can follow a song that
// Music.app plays. Only the analyser is exposed: the stream is never connected to the destination (no echo).
// The main process only answers getDisplayMedia right after it was armed over IPC, so a capture always arms first.

export interface SystemAudioCapture {
    analyser: AnalyserNode;
    stop(): void;
    /**
     * Calls `listener` at most once when the audio track ends on its own (the user stops sharing from the menu bar,
     * or the permission is revoked). Our own stop() never triggers it; a listener added after the end fires at once.
     */
    onEnded(listener: () => void): void;
}

// Matches the main analyser built in usePlaybackAudioBridge, so both feed the visualizer the same way.
const ANALYSER_FFT_SIZE = 2048;
const ANALYSER_SMOOTHING = 0.6;

// Asks the main process to let the next getDisplayMedia through. Resolves false when there is no bridge (not the
// macOS desktop app), and rejects when the main process refuses the sender.
const armThroughBridge = async (): Promise<boolean> => {
    if (typeof window === 'undefined') return false;
    return (await window.electron?.appleMusic?.armSystemAudioCapture?.()) === true;
};

// Arms the main process, asks for the system audio loopback and wires it into a fresh AnalyserNode on `context`.
// Permission and constraint errors from getDisplayMedia, and a refused arming, are rethrown as they are; the caller
// decides how to report them. Without a granted arming getDisplayMedia is never called.
export async function startSystemAudioCapture(
    context: AudioContext,
    mediaDevices: Pick<MediaDevices, 'getDisplayMedia'> = navigator.mediaDevices,
    arm: () => Promise<boolean> = armThroughBridge,
): Promise<SystemAudioCapture> {
    if (!(await arm())) throw new Error('system-audio-unavailable');
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
    let ended = false;
    let endedListeners: Array<() => void> = [];
    // Tracks stopped by our own stop() do not fire 'ended', and the flag guards the same for any engine that does.
    const handleEnded = () => {
        if (stopped || ended) return;
        ended = true;
        const listeners = endedListeners;
        endedListeners = [];
        listeners.forEach(listener => listener());
    };
    const audioTrack = stream.getAudioTracks()[0];
    audioTrack.addEventListener('ended', handleEnded);
    if (audioTrack.readyState === 'ended') ended = true;

    return {
        analyser,
        onEnded(listener) {
            if (stopped) return;
            if (ended) {
                listener();
                return;
            }
            endedListeners.push(listener);
        },
        stop() {
            if (stopped) return;
            stopped = true;
            endedListeners = [];
            // Disconnecting a node that is already detached must not keep the tracks (and the recording indicator) alive.
            try { source.disconnect(); } catch { /* already disconnected */ }
            try { analyser.disconnect(); } catch { /* already disconnected */ }
            stopTracks();
        },
    };
}
