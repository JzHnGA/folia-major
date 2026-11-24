// src/components/app/playback/bridges/spectrumFrames.ts
// 播放桥每帧写进 audioBands.spectrum 的那份频谱缓冲：两份轮着用，不再每帧 new 一个数组。

/**
 * 两份缓冲轮流交出：motion value 收到和上一帧不同的对象才发 change，所以不能每帧交同一份；读的人（可视化、模组的
 * getSpectrum，接口上写着「宿主复用这个数组」）都是每帧 get() 一次，不留着上一帧的对象。长度变了（分析器换了 fftSize）就重建那一份。
 */
export const createSpectrumFrames = () => {
    const frames: Array<Uint8Array<ArrayBuffer> | undefined> = [undefined, undefined];
    let turn = 0;
    return (length: number): Uint8Array<ArrayBuffer> => {
        turn = turn === 0 ? 1 : 0;
        let frame = frames[turn];
        if (frame?.length !== length) {
            frame = new Uint8Array(length);
            frames[turn] = frame;
        }
        return frame;
    };
};

/** 没有声音时写进去的空频谱：每帧都是同一个，空的数组也不必每帧再建。 */
export const EMPTY_SPECTRUM: Uint8Array<ArrayBuffer> = new Uint8Array(0);
