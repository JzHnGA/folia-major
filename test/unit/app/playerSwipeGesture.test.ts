import { describe, expect, it } from 'vitest';
import {
    PLAYER_SWIPE_MAX_SHIFT,
    PLAYER_SWIPE_MIN_DISTANCE,
    hasPlayerSwipeIntent,
    resolvePlayerSwipeDirection,
    resolvePlayerSwipeProgress,
    resolvePlayerSwipeShift,
} from '../../../src/components/app/player-swipe/playerSwipeGesture';

// test/unit/app/playerSwipeGesture.test.ts
// 播放页左右滑动切歌的纯规则：方向、横向意图、切歌门槛与箭头跟手的位移。

describe('player track swipe', () => {
    it('maps a left swipe to the next track and a right swipe to the previous one', () => {
        expect(resolvePlayerSwipeDirection(-PLAYER_SWIPE_MIN_DISTANCE, 4)).toBe('next');
        expect(resolvePlayerSwipeDirection(PLAYER_SWIPE_MIN_DISTANCE, -4)).toBe('prev');
    });

    it('does not switch below the distance threshold', () => {
        expect(resolvePlayerSwipeDirection(-(PLAYER_SWIPE_MIN_DISTANCE - 1), 0)).toBeNull();
        expect(resolvePlayerSwipeDirection(0, 0)).toBeNull();
    });

    it('leaves mostly vertical gestures to scrolling', () => {
        expect(resolvePlayerSwipeDirection(-90, 90)).toBeNull();
        expect(resolvePlayerSwipeDirection(-90, 60)).toBeNull();
        expect(resolvePlayerSwipeDirection(-90, 20)).toBe('next');
    });

    it('lights the arrow before the switch threshold', () => {
        expect(hasPlayerSwipeIntent(20, 2)).toBe(true);
        expect(hasPlayerSwipeIntent(10, 2)).toBe(false);
        expect(hasPlayerSwipeIntent(20, 30)).toBe(false);
    });

    it('keeps the arrow follow and opacity bounded', () => {
        expect(resolvePlayerSwipeProgress(0)).toBe(0);
        expect(resolvePlayerSwipeProgress(PLAYER_SWIPE_MIN_DISTANCE)).toBe(1);
        expect(resolvePlayerSwipeProgress(PLAYER_SWIPE_MIN_DISTANCE * 3)).toBe(1);

        expect(resolvePlayerSwipeShift(40)).toBe(10);
        expect(resolvePlayerSwipeShift(-40)).toBe(-10);
        expect(resolvePlayerSwipeShift(1000)).toBe(PLAYER_SWIPE_MAX_SHIFT);
        expect(resolvePlayerSwipeShift(-1000)).toBe(-PLAYER_SWIPE_MAX_SHIFT);
    });
});
