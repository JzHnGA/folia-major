import { describe, expect, it } from 'vitest';
import { frameBand, frameInsets } from '@/components/visualizer/lumiere/text/lineWrap';

// test/unit/visualizer/lumiere/lumiereSafeArea.test.ts
// 歌词放字范围让开左右安全区（iPhone 横屏的灵动岛 / 刘海）：安全区为 0 时与不传逐位相同（桌面 / 竖屏的
// 排版不能变），有安全区时左右各自再往里让那么多。
describe('lumiere frameBand safe sides', () => {
    const sizes: Array<[number, number]> = [[852, 393], [1600, 900], [393, 852], [1280, 720], [1366, 1024]];

    it('zero insets are byte-identical to the default band', () => {
        for (const [width, height] of sizes) {
            expect(frameBand(width, height, { left: 0, right: 0 })).toStrictEqual(frameBand(width, height));
        }
    });

    it('keeps the band clear of the notch on iPhone landscape', () => {
        const width = 852;
        const height = 393;
        const sides = { left: 59, right: 59 };
        const band = frameBand(width, height, sides);
        const base = frameBand(width, height);
        const { padX } = frameInsets(width, height);
        // 左右边缘（像素）都在安全区 + 画框边距之内。
        expect(band.left * height).toBeGreaterThanOrEqual(sides.left + padX);
        expect(width - band.right * height).toBeGreaterThanOrEqual(sides.right + padX);
        expect(band.left - base.left).toBeCloseTo(sides.left / height, 10);
        expect(base.right - band.right).toBeCloseTo(sides.right / height, 10);
        // 上下不受影响。
        expect(band.top).toBe(base.top);
        expect(band.bottom).toBe(base.bottom);
    });

    it('insets each side independently', () => {
        const band = frameBand(852, 393, { left: 59, right: 0 });
        const base = frameBand(852, 393);
        expect(band.left).toBeGreaterThan(base.left);
        expect(band.right).toBe(base.right);
    });
});
