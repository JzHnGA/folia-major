import { describe, expect, it } from 'vitest';
import { resolveCapsuleFollow, yieldsToControl } from '../../../src/components/app/player-swipe/useCapsuleTrackSwipe';
import { resolvePlayerSwipeDirection } from '../../../src/components/app/player-swipe/playerSwipeGesture';

// test/unit/player/capsuleTrackSwipe.test.ts
// The player bar's swipe to change songs: how far its content follows the finger, and that it
// changes songs at the same threshold as the full-screen swipe on the player page.

describe('player bar swipe', () => {
    it('follows most of the finger toward a song that exists, up to a limit', () => {
        expect(resolveCapsuleFollow(-50, true)).toBeCloseTo(-30);
        expect(resolveCapsuleFollow(-400, true)).toBe(-96);
        expect(resolveCapsuleFollow(400, true)).toBe(96);
    });

    it('only gives a little toward a side with no song', () => {
        expect(resolveCapsuleFollow(-50, false)).toBeCloseTo(-9);
        expect(resolveCapsuleFollow(-400, false)).toBe(-24);
    });

    it('changes song left for next and right for previous, past the same threshold', () => {
        expect(resolvePlayerSwipeDirection(-90, 4)).toBe('next');
        expect(resolvePlayerSwipeDirection(90, -4)).toBe('prev');
        expect(resolvePlayerSwipeDirection(-40, 0)).toBeNull();
        expect(resolvePlayerSwipeDirection(-90, 80)).toBeNull();
    });

    it('leaves a press near the progress thumb to seeking, and swipes from the rest of the track', () => {
        const thumb = { getBoundingClientRect: () => ({ left: 94, width: 12 }) };
        const track = { querySelector: () => thumb };
        const onTrack = { closest: (selector: string) => (selector.includes('progress.track') ? track : null) } as unknown as Element;
        expect(yieldsToControl(onTrack, 110)).toBe(true);
        expect(yieldsToControl(onTrack, 220)).toBe(false);
    });

    it('leaves other inputs alone and swipes from a button', () => {
        const input = { closest: (selector: string) => (selector.includes('input') && !selector.includes('progress') ? {} : null) } as unknown as Element;
        const button = { closest: () => null } as unknown as Element;
        expect(yieldsToControl(input, 50)).toBe(true);
        expect(yieldsToControl(button, 50)).toBe(false);
    });
});
