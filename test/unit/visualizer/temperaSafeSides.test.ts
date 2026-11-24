import { describe, expect, it } from 'vitest';
import type { TemperaSegment } from '@/components/visualizer/tempera/types';
import { resolveTemperaLayout, resolveTemperaSafeBand } from '@/components/visualizer/tempera/temperaLayout';
import { TEMPERA_SHOT_KINDS } from '@/components/visualizer/tempera/types';

// test/unit/visualizer/temperaSafeSides.test.ts
// Locks the iPhone-landscape safe area for Tempera: zero insets lay out exactly as before, and
// with the Dynamic Island insets every lyric glyph's resting spot sits between them.
const segment = (text: string, startTime: number, endTime: number): TemperaSegment => {
    const chars = Array.from(text);
    const step = (endTime - startTime) / Math.max(chars.length, 1);
    return {
        text,
        startOffset: 0,
        endOffset: text.length,
        startTime,
        endTime,
        isWordLike: true,
        graphemes: chars.map((char, index) => ({
            char,
            startTime: startTime + step * index,
            endTime: startTime + step * (index + 1),
        })),
    };
};

const LINES = [
    [segment('remember', 0, 1), segment('the', 1, 1.3), segment('quiet', 1.3, 2)],
    [segment('morning', 2, 2.8), segment('light', 2.8, 3.4)],
];

// iPhone 15 Pro landscape in CSS px.
const WIDTH = 852;
const HEIGHT = 393;
const INSETS = { left: 59, right: 59 };

const layout = (shotKind: (typeof TEMPERA_SHOT_KINDS)[number], safeSides?: { left: number; right: number }) => (
    resolveTemperaLayout({
        lines: LINES,
        shotKind,
        width: WIDTH,
        height: HEIGHT,
        baseFontSize: 54,
        fontFamily: 'sans-serif',
        fontWeight: 600,
        seed: 4242,
        safeSides,
    })
);

describe('Tempera safe-area sides', () => {
    it('keeps the whole canvas as the band when there are no insets', () => {
        expect(resolveTemperaSafeBand(WIDTH)).toEqual({ left: 0, width: WIDTH });
        expect(resolveTemperaSafeBand(WIDTH, { left: 0, right: 0 })).toEqual({ left: 0, width: WIDTH });
        expect(resolveTemperaSafeBand(WIDTH, INSETS)).toEqual({ left: 59, width: WIDTH - 118 });
    });

    it('lays out identically with zero insets', () => {
        for (const kind of TEMPERA_SHOT_KINDS) {
            expect(layout(kind, { left: 0, right: 0 })).toEqual(layout(kind));
        }
    });

    it('keeps every glyph centre between the insets', () => {
        for (const kind of TEMPERA_SHOT_KINDS) {
            for (const placement of layout(kind, INSETS)) {
                expect(placement.x).toBeGreaterThanOrEqual(INSETS.left);
                expect(placement.x).toBeLessThanOrEqual(WIDTH - INSETS.right);
            }
        }
    });
});
