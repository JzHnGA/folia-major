// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sharePayload } from '@/utils/system/share';

// test/unit/utils/share.test.ts
// 分享通路的优先级和退化：原生壳的系统面板 > Web Share > 剪贴板，全挂才 failed；
// 取消原生面板或 Web Share 不算失败。

const PAYLOAD = { title: 'Song - Artist', url: 'https://music.example/song?id=1' };

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('sharePayload', () => {
    it('prefers the native share sheet in the native shell', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('Capacitor', { isNativePlatform: () => true, Plugins: { Share: { share } } });
        const navigatorShare = vi.fn();
        Object.defineProperty(window.navigator, 'share', { value: navigatorShare, configurable: true });

        expect(await sharePayload(PAYLOAD)).toBe('native');
        expect(share).toHaveBeenCalledWith({ ...PAYLOAD, dialogTitle: PAYLOAD.title });
        expect(navigatorShare).not.toHaveBeenCalled();
    });

    it('treats a dismissed native sheet as done, not as a failure', async () => {
        const share = vi.fn().mockRejectedValue(new Error('cancelled'));
        vi.stubGlobal('Capacitor', { isNativePlatform: () => true, Plugins: { Share: { share } } });

        expect(await sharePayload(PAYLOAD)).toBe('native');
    });

    it('falls back to Web Share outside the native shell, and a cancel stays quiet', async () => {
        const share = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
        Object.defineProperty(window.navigator, 'share', { value: share, configurable: true });

        expect(await sharePayload(PAYLOAD)).toBe('web');
        expect(share).toHaveBeenCalledWith(PAYLOAD);
    });

    it('copies the link to the clipboard when no share surface exists', async () => {
        Object.defineProperty(window.navigator, 'share', { value: undefined, configurable: true });
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });

        expect(await sharePayload(PAYLOAD)).toBe('clipboard');
        expect(writeText).toHaveBeenCalledWith(PAYLOAD.url);
    });

    it('reports failure only when every path is unavailable', async () => {
        Object.defineProperty(window.navigator, 'share', { value: undefined, configurable: true });
        Object.defineProperty(window.navigator, 'clipboard', {
            value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
            configurable: true,
        });

        expect(await sharePayload(PAYLOAD)).toBe('failed');
    });
});
