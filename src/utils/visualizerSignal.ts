// src/utils/visualizerSignal.ts
// Leaf helper: decides whether the visualizer may read the analyser or must fall back to the idle breath.

// An external song's carrier <audio> plays silence, so its analyser reads nothing while the song sounds.
export const resolveHasAnalyserSignal = ({
    isActuallyPlaying,
    isTransitionAudible,
    isExternalPlayback,
}: {
    isActuallyPlaying: boolean;
    isTransitionAudible: boolean;
    isExternalPlayback: boolean;
}): boolean => !isExternalPlayback && (isActuallyPlaying || isTransitionAudible);
