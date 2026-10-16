// src/utils/visualizerSignal.ts
// Leaf helper: decides whether the visualizer may read the analyser or must fall back to the idle breath.

// An external song's carrier <audio> plays silence, so its analyser reads nothing while the song sounds.
// The only audible signal then is the system-audio capture (hasExternalCapture); without one the visuals idle.
export const resolveHasAnalyserSignal = ({
    isActuallyPlaying,
    isTransitionAudible,
    isExternalPlayback,
    hasExternalCapture,
}: {
    isActuallyPlaying: boolean;
    isTransitionAudible: boolean;
    isExternalPlayback: boolean;
    hasExternalCapture: boolean;
}): boolean => (
    isExternalPlayback
        ? hasExternalCapture
        : isActuallyPlaying || isTransitionAudible
);
