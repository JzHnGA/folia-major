import { describe, expect, it } from 'vitest';
import { CAPSULE_VERTICAL_SWIPE_MIN_DISTANCE, resolveCapsuleVerticalSwipe } from '../../../src/components/app/player-swipe/useCapsuleVerticalSwipe';

// test/unit/app/capsuleVerticalSwipe.test.ts
// 底部播放条上下滑动的判定：上滑展开、下滑收起；太短或更像横划（左右切歌）的不算。

describe('resolveCapsuleVerticalSwipe', () => {
    it('reads a clear upward drag as up and a downward one as down', () => {
        expect(resolveCapsuleVerticalSwipe(4, -40)).toBe('up');
        expect(resolveCapsuleVerticalSwipe(-4, 40)).toBe('down');
    });

    it('ignores drags shorter than the minimum', () => {
        expect(resolveCapsuleVerticalSwipe(0, -(CAPSULE_VERTICAL_SWIPE_MIN_DISTANCE - 1))).toBeNull();
    });

    it('leaves diagonal and horizontal drags to the track swipe', () => {
        expect(resolveCapsuleVerticalSwipe(60, -40)).toBeNull();
        expect(resolveCapsuleVerticalSwipe(120, 5)).toBeNull();
    });
});
