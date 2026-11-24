import { describe, expect, it } from 'vitest';
import { bravaisTileTransform } from '@/library/suites/bravais/bravaisTileTransform';

// test/unit/library/bravais/bravaisTileTransform.test.ts
// In the iOS shell a tile must not carry a 3D term: translate3d gave each tile its own GPU layer,
// charged to the web process, and the page started at ~725 MB before anything played.

describe('bravaisTileTransform', () => {
    it('positions in 2D in the native shell', () => {
        expect(bravaisTileTransform(12, -4.5, true)).toBe('translate(12px, -4.5px)');
    });

    it('keeps translate3d on desktop', () => {
        expect(bravaisTileTransform(12, -4.5, false)).toBe('translate3d(12px, -4.5px, 0)');
    });
});
