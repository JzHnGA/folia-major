import type { SystemAudioCapture } from './systemAudioCapture';

// src/services/externalPlayback/spectrumCaptureController.ts
// Decides when the Apple Music spectrum capture runs and owns its lifetime. The React hook only feeds it
// state; keeping the timing here makes it testable without a renderer.

/**
 * Between two songs the player state drops to IDLE for a moment. A capture that survives that gap avoids a
 * new recording-indicator flash and a fresh permission round trip per track.
 */
export const SPECTRUM_CAPTURE_STOP_GRACE_MS = 2000;

export type SpectrumCaptureConditions = {
    enabled: boolean;
    isExternal: boolean;
    isPlaying: boolean;
    hasContext: boolean;
};

// Capture only while the setting is on, an external (Apple Music) song plays, and an AudioContext exists.
export const shouldCaptureSystemAudio = ({ enabled, isExternal, isPlaying, hasContext }: SpectrumCaptureConditions): boolean => (
    enabled && isExternal && isPlaying && hasContext
);

export type SpectrumCaptureControllerDeps = {
    start: (context: AudioContext) => Promise<SystemAudioCapture>;
    /** Hands the running capture's analyser to the visualizer, or null when there is none. */
    publish: (analyser: AnalyserNode | null) => void;
    onFailure: (error: unknown) => void;
};

export type SpectrumCaptureUpdate = {
    enabled: boolean;
    isExternal: boolean;
    isPlaying: boolean;
    context: AudioContext | null;
};

type CaptureSlot = {
    context: AudioContext;
    capture: SystemAudioCapture | null;
};

// Starts the capture when conditions hold and stops it after the grace period when they lapse.
// A failed start is not retried until the setting is switched off and on again.
export function createSpectrumCaptureController({ start, publish, onFailure }: SpectrumCaptureControllerDeps) {
    let slot: CaptureSlot | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let failed = false;

    const clearStopTimer = () => {
        if (stopTimer !== null) {
            clearTimeout(stopTimer);
            stopTimer = null;
        }
    };

    const stopNow = () => {
        clearStopTimer();
        if (!slot) return;
        const stopping = slot;
        slot = null;
        if (stopping.capture) {
            publish(null);
            stopping.capture.stop();
        }
    };

    const begin = (context: AudioContext) => {
        const pending: CaptureSlot = { context, capture: null };
        slot = pending;
        void (async () => {
            try {
                const capture = await start(context);
                // Cancelled while the permission prompt or the stream was still starting.
                if (slot !== pending) {
                    capture.stop();
                    return;
                }
                pending.capture = capture;
                publish(capture.analyser);
            } catch (error) {
                if (slot !== pending) return;
                slot = null;
                failed = true;
                onFailure(error);
            }
        })();
    };

    return {
        update({ enabled, isExternal, isPlaying, context }: SpectrumCaptureUpdate) {
            if (!enabled) {
                failed = false;
                stopNow();
                return;
            }

            if (context && shouldCaptureSystemAudio({ enabled, isExternal, isPlaying, hasContext: true })) {
                clearStopTimer();
                if (slot && slot.context !== context) stopNow();
                if (!slot && !failed) begin(context);
                return;
            }

            if (slot && stopTimer === null) {
                stopTimer = setTimeout(stopNow, SPECTRUM_CAPTURE_STOP_GRACE_MS);
            }
        },
        dispose: stopNow,
    };
}
