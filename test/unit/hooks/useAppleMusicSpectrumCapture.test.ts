import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerState } from '@/types';

// test/unit/hooks/useAppleMusicSpectrumCapture.test.ts
// The wiring layer around the capture controller: which store values start a capture, the once-per-session
// denial notice, the wait for a late AudioContext, and the cleanup on unmount. The repo's vitest runs on node
// without a renderer, so this uses the same minimal React runtime as useNeteaseScrobbleReporter.test.ts.

const runtime = vi.hoisted(() => ({
    slots: [] as { current: any }[],
    cursor: 0,
    effects: [] as Array<{ effect: () => void | (() => void); deps?: unknown[] }>,
    stateSetters: 0,
}));

vi.mock('react', () => ({
    useRef: (initial: unknown) => {
        const index = runtime.cursor++;
        runtime.slots[index] ??= { current: initial };
        return runtime.slots[index];
    },
    useState: (initial: unknown) => {
        const index = runtime.cursor++;
        runtime.slots[index] ??= { current: typeof initial === 'function' ? (initial as () => unknown)() : initial };
        const slot = runtime.slots[index];
        return [slot.current, (next: unknown) => {
            runtime.stateSetters += 1;
            slot.current = typeof next === 'function' ? (next as (value: unknown) => unknown)(slot.current) : next;
        }];
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => { runtime.effects.push({ effect, deps }); },
}));

const capture = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@/services/externalPlayback/systemAudioCapture', () => ({ startSystemAudioCapture: capture.start }));

const status = vi.hoisted(() => ({ setStatusMessage: vi.fn() }));
vi.mock('@/stores/useStatusMessageStore', () => status);

vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }));

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: { isExternalPlaybackSong: (song: { external?: boolean } | null) => Boolean(song?.external) },
}));

const audioSettings = vi.hoisted(() => ({ appleMusicSpectrumCapture: true }));
vi.mock('@/stores/useAudioSettingsStore', () => ({
    useAudioSettingsStore: (selector: (state: typeof audioSettings) => unknown) => selector(audioSettings),
}));

const playback = vi.hoisted(() => ({ currentSong: { external: true } as { external: boolean } | null, playerState: 'PLAYING' as unknown }));
vi.mock('@/stores/usePlaybackStore', () => ({
    usePlaybackStore: (selector: (state: typeof playback) => unknown) => selector(playback),
}));

const { useAppleMusicSpectrumCapture } = await import('@/hooks/useAppleMusicSpectrumCapture');

const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

// Effect bookkeeping per call order, so an effect re-runs only when its dependencies change, as in React.
let committed: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
const audioContextRef = { current: null as AudioContext | null };
let result: { current: AnalyserNode | null } | null = null;

const sameDeps = (a?: unknown[], b?: unknown[]) => (
    Boolean(a && b) && a!.length === b!.length && a!.every((value, index) => Object.is(value, b![index]))
);

// One React render: runs the effects whose dependencies changed (cleanup first), like a commit.
const render = () => {
    runtime.cursor = 0;
    runtime.effects.length = 0;
    result = useAppleMusicSpectrumCapture({ audioContextRef: audioContextRef as never });
    runtime.effects.forEach(({ effect, deps }, index) => {
        const previous = committed[index];
        if (previous && sameDeps(previous.deps, deps)) return;
        previous?.cleanup?.();
        const cleanup = effect();
        committed[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
    });
};

const unmount = () => {
    committed.forEach(entry => entry?.cleanup?.());
    committed = [];
};

// A capture whose track the test can end, the way the user stopping the share from the menu bar does.
const newCapture = () => {
    let listener: (() => void) | null = null;
    return {
        analyser: { id: 'capture' } as unknown as AnalyserNode,
        stop: vi.fn(),
        onEnded: (next: () => void) => { listener = next; },
        end: () => listener?.(),
    };
};

describe('useAppleMusicSpectrumCapture', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        runtime.slots.length = 0;
        runtime.cursor = 0;
        runtime.stateSetters = 0;
        committed = [];
        capture.start.mockReset();
        status.setStatusMessage.mockReset();
        audioSettings.appleMusicSpectrumCapture = true;
        playback.currentSong = { external: true };
        playback.playerState = PlayerState.PLAYING;
        audioContextRef.current = { id: 'context' } as unknown as AudioContext;
    });

    afterEach(() => {
        unmount();
        vi.useRealTimers();
    });

    it('captures system audio for a playing external song and hands the analyser back through the ref', async () => {
        const running = newCapture();
        capture.start.mockResolvedValue(running);

        render();
        await flush();

        expect(capture.start).toHaveBeenCalledWith(audioContextRef.current);
        expect(result!.current).toBe(running.analyser);
    });

    it('does not capture a song that is not external', async () => {
        playback.currentSong = { external: false };

        render();
        await flush();

        expect(capture.start).not.toHaveBeenCalled();
        expect(result!.current).toBeNull();
    });

    it('does not capture while paused', async () => {
        playback.playerState = PlayerState.PAUSED;

        render();
        await flush();

        expect(capture.start).not.toHaveBeenCalled();
    });

    it('does not capture when the setting is off', async () => {
        audioSettings.appleMusicSpectrumCapture = false;

        render();
        await flush();

        expect(capture.start).not.toHaveBeenCalled();
    });

    it('releases the capture and clears the ref when the component unmounts', async () => {
        const running = newCapture();
        capture.start.mockResolvedValue(running);
        render();
        await flush();

        unmount();

        expect(running.stop).toHaveBeenCalledTimes(1);
        expect(result!.current).toBeNull();
    });

    it('clears the ref without a denial notice when the user ends the capture from the system', async () => {
        const running = newCapture();
        capture.start.mockResolvedValue(running);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        render();
        await flush();
        expect(result!.current).toBe(running.analyser);

        running.end();

        expect(result!.current).toBeNull();
        expect(running.stop).toHaveBeenCalledTimes(1);
        expect(status.setStatusMessage).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('[AppleMusicSpectrum] system audio capture ended');
        warn.mockRestore();
    });

    it('waits for the AudioContext to exist before capturing, without re-rendering', async () => {
        audioContextRef.current = null;
        render();
        await flush();
        expect(capture.start).not.toHaveBeenCalled();

        // The context is created lazily on first play; the controller re-reads the ref on its own timer, so no
        // component state changes and nothing re-renders while waiting.
        capture.start.mockResolvedValue(newCapture());
        audioContextRef.current = { id: 'context' } as unknown as AudioContext;
        vi.advanceTimersByTime(500);
        await flush();

        expect(capture.start).toHaveBeenCalledTimes(1);
        expect(capture.start).toHaveBeenCalledWith(audioContextRef.current);
        expect(runtime.stateSetters).toBe(0);
    });

    it('stops waiting for the AudioContext on unmount', async () => {
        audioContextRef.current = null;
        render();
        await flush();

        unmount();

        expect(vi.getTimerCount()).toBe(0);
    });

    // Runs last on purpose: the notice flag is module-level, so only the first failure of the file can show it.
    it('shows the denial notice once per session and retries only after the setting is toggled', async () => {
        capture.start.mockRejectedValue(new DOMException('Invalid capture constraints', 'AbortError'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        render();
        await flush();
        render();
        await flush();

        expect(capture.start).toHaveBeenCalledTimes(1);
        expect(status.setStatusMessage).toHaveBeenCalledTimes(1);
        expect(status.setStatusMessage).toHaveBeenCalledWith({ type: 'error', text: 'appleMusic.spectrumCaptureDenied' });

        audioSettings.appleMusicSpectrumCapture = false;
        render();
        audioSettings.appleMusicSpectrumCapture = true;
        render();
        await flush();

        expect(capture.start).toHaveBeenCalledTimes(2);
        expect(status.setStatusMessage).toHaveBeenCalledTimes(1);
    });
});
