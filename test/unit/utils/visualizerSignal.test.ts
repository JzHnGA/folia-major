import { describe, expect, it } from 'vitest';
import { resolveHasAnalyserSignal } from '@/utils/visualizerSignal';

// test/unit/utils/visualizerSignal.test.ts
// Whether the visualizer reads the analyser or falls back to the idle breathing animation.

describe('resolveHasAnalyserSignal', () => {
    it('drops to the idle animation for external playback even while the carrier plays', () => {
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: true, isTransitionAudible: false, isExternalPlayback: true, hasExternalCapture: false })).toBe(false);
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: true, isTransitionAudible: false, isExternalPlayback: false, hasExternalCapture: false })).toBe(true);
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: false, isTransitionAudible: true, isExternalPlayback: false, hasExternalCapture: false })).toBe(true);
    });

    it('is silent when nothing plays and no transition is audible', () => {
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: false, isTransitionAudible: false, isExternalPlayback: false, hasExternalCapture: false })).toBe(false);
    });

    it('stays idle for external playback regardless of a transition', () => {
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: false, isTransitionAudible: true, isExternalPlayback: true, hasExternalCapture: false })).toBe(false);
    });

    // Apple Music songs sound from the Music app; the system-audio capture is the only analyser that hears them.
    it('reads the capture analyser for external playback when a capture is running', () => {
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: true, isTransitionAudible: false, isExternalPlayback: true, hasExternalCapture: true })).toBe(true);
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: false, isTransitionAudible: false, isExternalPlayback: true, hasExternalCapture: true })).toBe(true);
    });

    it('falls back to the idle animation for external playback without a capture', () => {
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: true, isTransitionAudible: true, isExternalPlayback: true, hasExternalCapture: false })).toBe(false);
    });

    it('ignores a leftover capture for a song that is not external', () => {
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: false, isTransitionAudible: false, isExternalPlayback: false, hasExternalCapture: true })).toBe(false);
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: true, isTransitionAudible: false, isExternalPlayback: false, hasExternalCapture: true })).toBe(true);
    });
});
