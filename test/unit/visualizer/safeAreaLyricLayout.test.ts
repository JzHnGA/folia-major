import { describe, expect, it } from 'vitest';
import { layoutNebbiaSong, type NebbiaLayoutOptions } from '@/components/visualizer/nebbia/nebbiaLayout';
import type { NebbiaSourceLine } from '@/components/visualizer/nebbia/nebbiaChars';
import { DEFAULT_NEBBIA_TUNING } from '@/components/visualizer/nebbia/types';

// test/unit/visualizer/safeAreaLyricLayout.test.ts
// 横屏的灵动岛 / 刘海（左右安全区）：雾笺的整首排版要让开安全区；安全区为 0 时和不传一模一样。

const sourceLine = (text: string, t: number, next: number): NebbiaSourceLine => {
    const glyphs = [...text];
    const chars = glyphs.map((ch, k) => ({ ch, t: t + k * 0.3, d: 0.3 }));
    // 按空格分词；中文一个字一个词
    const words: number[][] = [];
    let current: number[] = [];
    glyphs.forEach((ch, k) => {
        if (ch === ' ') { if (current.length) words.push(current); current = []; return; }
        if (/[一-鿿]/.test(ch)) { if (current.length) words.push(current); words.push([k]); current = []; return; }
        current.push(k);
    });
    if (current.length) words.push(current);
    return { chars, words, t, end: t + glyphs.length * 0.3, next };
};

const TEXTS = ['我们走过的那条街', 'Hold on to the night', 'everything we used to know', '风吹过', 'a really long line that keeps going and going'];
const lines = TEXTS.map((text, i) => sourceLine(text, i * 4, (i + 1) * 4));

const options = (extra: Partial<NebbiaLayoutOptions> = {}): NebbiaLayoutOptions => ({
    W: 852,
    H: 393,
    jitter: DEFAULT_NEBBIA_TUNING.jitter,
    layouts: DEFAULT_NEBBIA_TUNING.layouts,
    fontScale: 1,
    visibleUntil: i => i * 4 + 6,
    fogAt: i => i * 4 + 4,
    ...extra,
});

describe('safe-area lyric layout (nebbia)', () => {
    it('lays out exactly as before when the insets are zero', () => {
        expect(layoutNebbiaSong(lines, options({ insetL: 0, insetR: 0 }))).toEqual(layoutNebbiaSong(lines, options()));
    });

    it('keeps every glyph clear of the left and right insets', () => {
        const inset = 59;
        const laid = layoutNebbiaSong(lines, options({ insetL: inset, insetR: inset }));
        for (const [li, line] of laid.entries()) {
            line.forEach((p, k) => {
                if (!lines[li].chars[k].ch.trim()) return;
                // 拉丁字按 1.15 倍画（nebbiaScene.ts）
                const half = p.s * 1.15 / 2;
                expect(p.x - half).toBeGreaterThanOrEqual(inset);
                expect(p.x + half).toBeLessThanOrEqual(852 - inset);
            });
        }
    });
});
