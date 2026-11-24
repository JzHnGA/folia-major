import { describe, expect, it } from 'vitest';
import { EMPTY_SPECTRUM, createSpectrumFrames } from '@/components/app/playback/bridges/spectrumFrames';

// test/unit/playback/spectrumFrames.test.ts
// 播放桥的频谱缓冲：两份轮着交出（相邻两帧不是同一个对象，motion value 才会发 change），长度变了就重建。

describe('spectrum frames', () => {
    it('hands out two buffers in turn instead of a new one each frame', () => {
        const next = createSpectrumFrames();
        const first = next(1024);
        const second = next(1024);
        expect(second).not.toBe(first);
        expect(next(1024)).toBe(first);
        expect(next(1024)).toBe(second);
        expect(first).toHaveLength(1024);
    });

    it('rebuilds a buffer when the length changes', () => {
        const next = createSpectrumFrames();
        next(1024);
        next(1024);
        const resized = next(512);
        expect(resized).toHaveLength(512);
        expect(next(512)).toHaveLength(512);
    });

    it('keeps one empty spectrum for the idle frames', () => {
        expect(EMPTY_SPECTRUM).toHaveLength(0);
    });
});
