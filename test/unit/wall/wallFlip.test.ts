import { describe, expect, it } from 'vitest';
import { flatFlipScaleX, wallFlipKeyframe } from '@/components/wall/wallFlip';

// test/unit/wall/wallFlip.test.ts
// Wall flips on the iPhone are drawn flat: a 3D turn (or a compositor-run transform animation) gave
// every card a full-size GPU layer and a handoff between the walls took the web process past its
// 2 GB limit. The flat keyframes must carry no transform at all, and close to a line edge-on.

describe('wallFlipKeyframe', () => {
    it('desktop keeps the 3D half-turn', () => {
        expect(wallFlipKeyframe(90, false)).toEqual({ transform: 'perspective(1400px) rotateY(90deg)' });
    });

    it('flat keyframes are a centred clip-path wipe with no transform', () => {
        const facing = wallFlipKeyframe(0, true);
        const edgeOn = wallFlipKeyframe(-90, true);
        expect(facing).toEqual({ clipPath: 'inset(0 0.000% 0 0.000%)' });
        expect(edgeOn).toEqual({ clipPath: 'inset(0 50.000% 0 50.000%)' });
        expect('transform' in edgeOn).toBe(false);
    });

    it('both directions of a turn hide the same amount', () => {
        expect(wallFlipKeyframe(60, true)).toEqual(wallFlipKeyframe(-60, true));
        expect(wallFlipKeyframe(60, true)).toEqual({ clipPath: 'inset(0 25.000% 0 25.000%)' });
    });
});

describe('flatFlipScaleX', () => {
    it('is 1 facing and 0 edge-on', () => {
        expect(flatFlipScaleX(0)).toBe(1);
        expect(flatFlipScaleX(90)).toBeCloseTo(0, 10);
        expect(flatFlipScaleX(-90)).toBeCloseTo(0, 10);
        expect(flatFlipScaleX(60)).toBeCloseTo(0.5, 10);
    });
});
