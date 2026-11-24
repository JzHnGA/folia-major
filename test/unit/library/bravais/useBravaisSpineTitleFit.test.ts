import { describe, expect, it } from 'vitest';
import { resolveSpineTitleFontSize, SPINE_TITLE_ADVANCE_EM, SPINE_TITLE_MIN_FONT_PX } from '@/library/suites/bravais/useBravaisSpineTitleFit';

// test/unit/library/bravais/useBravaisSpineTitleFit.test.ts
// 书脊标题的字号：不超过基准字号，按槽高与字数收缩；横屏（槽高 100 左右）时整条标题仍留在一列里。

describe('resolveSpineTitleFontSize', () => {
    it('keeps the base size when the slot is tall enough', () => {
        expect(resolveSpineTitleFontSize(600, '我喜欢的音乐', 30)).toBe(30);
    });

    it('shrinks a six-character title into a short landscape slot', () => {
        const size = resolveSpineTitleFontSize(100, '我喜欢的音乐', 30);
        expect(size).toBe(Math.floor(100 / (6 * SPINE_TITLE_ADVANCE_EM)));
        expect(size).toBeGreaterThanOrEqual(SPINE_TITLE_MIN_FONT_PX);
    });

    it('never goes below the minimum even for a very long title', () => {
        expect(resolveSpineTitleFontSize(80, 'a'.repeat(40), 30)).toBe(SPINE_TITLE_MIN_FONT_PX);
    });

    it('uses the base size when it is already smaller than the fit', () => {
        expect(resolveSpineTitleFontSize(500, '很长很长很长很长的标题', 18)).toBe(18);
    });
});
