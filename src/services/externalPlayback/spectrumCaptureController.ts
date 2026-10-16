import type { SystemAudioCapture } from './systemAudioCapture';

// src/services/externalPlayback/spectrumCaptureController.ts
// Decides when the Apple Music spectrum capture runs and owns its lifetime. The React hook only feeds it
// state; keeping the timing here makes it testable without a renderer.

/**
 * Between two songs the player state drops to IDLE for a moment. A capture that survives that gap avoids a
 * new recording-indicator flash and a fresh permission round trip per track.
 */
export const SPECTRUM_CAPTURE_STOP_GRACE_MS = 2000;

/** How often the controller re-reads the AudioContext while a capture is wanted but the context does not exist yet. */
export const SPECTRUM_CONTEXT_POLL_MS = 500;

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
    /**
     * Reads the AudioContext when `update` has none. The context is created lazily on first play and lives in a ref,
     * so nothing announces it; with this the controller polls for it itself instead of the UI re-rendering.
     */
    getContext?: () => AudioContext | null;
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
// A failed start, or a capture the user ended from the system, is not retried until the setting is switched off and
// on again. While everything but the AudioContext is in place it polls getContext (at most one timer at a time).
export function createSpectrumCaptureController({ start, publish, onFailure, getContext }: SpectrumCaptureControllerDeps) {
    let slot: CaptureSlot | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let contextTimer: ReturnType<typeof setTimeout> | null = null;
    let failed = false;
    let lastUpdate: SpectrumCaptureUpdate | null = null;

    const clearContextTimer = () => {
        if (contextTimer !== null) {
            clearTimeout(contextTimer);
            contextTimer = null;
        }
    };

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
                // The track ends on its own when the user stops sharing from the menu bar or revokes the permission.
                // That was a deliberate act, so it neither retries nor shows the denial notice.
                capture.onEnded(() => {
                    if (slot !== pending) return;
                    failed = true;
                    console.warn('[AppleMusicSpectrum] system audio capture ended');
                    stopNow();
                });
            } catch (error) {
                if (slot !== pending) return;
                slot = null;
                failed = true;
                onFailure(error);
            }
        })();
    };

    // Re-reads the context on a timer while one is wanted but missing; the tick re-runs the last update with it.
    const scheduleContextPoll = () => {
        if (contextTimer !== null || !getContext) return;
        contextTimer = setTimeout(() => {
            contextTimer = null;
            const context = getContext();
            if (context && lastUpdate) {
                update({ ...lastUpdate, context });
                return;
            }
            scheduleContextPoll();
        }, SPECTRUM_CONTEXT_POLL_MS);
    };

    function update(next: SpectrumCaptureUpdate) {
        const { enabled, isExternal, isPlaying, context } = next;
        lastUpdate = next;
        const wanted = shouldCaptureSystemAudio({ enabled, isExternal, isPlaying, hasContext: true });
        // Re-decided on every update: the poll only lives while the context is the single missing condition.
        if (context || !wanted) clearContextTimer();

        if (!enabled) {
            failed = false;
            stopNow();
            return;
        }

        if (context && wanted) {
            clearStopTimer();
            if (slot && slot.context !== context) stopNow();
            if (!slot && !failed) begin(context);
            return;
        }

        if (slot && stopTimer === null) {
            stopTimer = setTimeout(stopNow, SPECTRUM_CAPTURE_STOP_GRACE_MS);
        }

        if (!context && wanted) scheduleContextPoll();
    }

    function dispose() {
        clearContextTimer();
        lastUpdate = null;
        stopNow();
    }

    return { update, dispose };
}
