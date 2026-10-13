import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/stores/appleMusicSpectrumCaptureSetting.test.ts
// The Apple Music spectrum switch: off by default (it makes macOS show a recording indicator),
// stored under its own key, and restored on the next launch.

describe('apple music spectrum capture setting', () => {
    let values: Map<string, string>;

    beforeEach(() => {
        values = new Map();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        };
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage });
        vi.resetModules();
    });

    afterEach(() => vi.unstubAllGlobals());

    it('is off when nothing has been stored', async () => {
        const { useAudioSettingsStore } = await import('@/stores/useAudioSettingsStore');

        expect(useAudioSettingsStore.getState().appleMusicSpectrumCapture).toBe(false);
    });

    it('persists the choice under apple_music_spectrum_capture', async () => {
        const { useAudioSettingsStore } = await import('@/stores/useAudioSettingsStore');

        useAudioSettingsStore.getState().setAppleMusicSpectrumCapture(true);

        expect(useAudioSettingsStore.getState().appleMusicSpectrumCapture).toBe(true);
        expect(values.get('apple_music_spectrum_capture')).toBe('true');

        useAudioSettingsStore.getState().setAppleMusicSpectrumCapture(false);

        expect(useAudioSettingsStore.getState().appleMusicSpectrumCapture).toBe(false);
        expect(values.get('apple_music_spectrum_capture')).toBe('false');
    });

    it('restores a stored on state at launch', async () => {
        values.set('apple_music_spectrum_capture', 'true');
        const { useAudioSettingsStore } = await import('@/stores/useAudioSettingsStore');

        expect(useAudioSettingsStore.getState().appleMusicSpectrumCapture).toBe(true);
    });
});
