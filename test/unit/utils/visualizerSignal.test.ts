import { describe, expect, it } from 'vitest';
import { resolveHasAnalyserSignal } from '@/utils/visualizerSignal';

// test/unit/utils/visualizerSignal.test.ts
// Whether the visualizer reads the analyser or falls back to the idle breathing animation.

describe('resolveHasAnalyserSignal', () => {
    it('drops to the idle animation for external playback even while the carrier plays', () => {
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: true, isTransitionAudible: false, isExternalPlayback: true })).toBe(false);
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: true, isTransitionAudible: false, isExternalPlayback: false })).toBe(true);
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: false, isTransitionAudible: true, isExternalPlayback: false })).toBe(true);
    });

    it('is silent when nothing plays and no transition is audible', () => {
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: false, isTransitionAudible: false, isExternalPlayback: false })).toBe(false);
    });

    it('stays idle for external playback regardless of a transition', () => {
        expect(resolveHasAnalyserSignal({ isActuallyPlaying: false, isTransitionAudible: true, isExternalPlayback: true })).toBe(false);
    });
});
