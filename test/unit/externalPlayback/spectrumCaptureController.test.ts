import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createSpectrumCaptureController,
    shouldCaptureSystemAudio,
    SPECTRUM_CAPTURE_STOP_GRACE_MS,
    SPECTRUM_CONTEXT_POLL_MS,
} from '@/services/externalPlayback/spectrumCaptureController';
import type { SystemAudioCapture } from '@/services/externalPlayback/systemAudioCapture';

// test/unit/externalPlayback/spectrumCaptureController.test.ts
// When the Apple Music spectrum capture runs: only while the setting is on, an external song plays
// and an AudioContext exists; it survives the brief gap between two songs and is not retried after
// a failure, or after the user ended the capture, until the setting is switched off and on again.
// While the AudioContext does not exist yet, an internal poll waits for it.

const ready = { enabled: true, isExternal: true, isPlaying: true } as const;

const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

type FakeCapture = SystemAudioCapture & { stop: ReturnType<typeof vi.fn>; end: () => void };

// A capture whose track the test can end, the way the user stopping the share from the menu bar does.
const createCapture = (id: number): FakeCapture => {
    let listener: (() => void) | null = null;
    const stop = vi.fn();
    return {
        analyser: { id } as unknown as AnalyserNode,
        stop,
        onEnded: next => { listener = next; },
        end: () => listener?.(),
    };
};

function setup() {
    const context = { id: 'context' } as unknown as AudioContext;
    const captures: FakeCapture[] = [];
    const start = vi.fn(async (_context: AudioContext) => {
        const capture = createCapture(captures.length);
        captures.push(capture);
        return capture;
    });
    const published: Array<AnalyserNode | null> = [];
    const onFailure = vi.fn();
    const getContext = vi.fn((): AudioContext | null => null);
    const controller = createSpectrumCaptureController({
        start,
        publish: analyser => published.push(analyser),
        onFailure,
        getContext,
    });
    return { context, captures, start, published, onFailure, getContext, controller };
}

describe('shouldCaptureSystemAudio', () => {
    it('needs the setting, an external song, playback and a context', () => {
        expect(shouldCaptureSystemAudio({ enabled: true, isExternal: true, isPlaying: true, hasContext: true })).toBe(true);
        expect(shouldCaptureSystemAudio({ enabled: false, isExternal: true, isPlaying: true, hasContext: true })).toBe(false);
        expect(shouldCaptureSystemAudio({ enabled: true, isExternal: false, isPlaying: true, hasContext: true })).toBe(false);
        expect(shouldCaptureSystemAudio({ enabled: true, isExternal: true, isPlaying: false, hasContext: true })).toBe(false);
        expect(shouldCaptureSystemAudio({ enabled: true, isExternal: true, isPlaying: true, hasContext: false })).toBe(false);
    });
});

describe('spectrum capture controller', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('starts a capture and publishes its analyser once every condition holds', async () => {
        const { context, captures, start, published, controller } = setup();

        controller.update({ ...ready, context });
        await flush();

        expect(start).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledWith(context);
        expect(published).toEqual([captures[0].analyser]);
    });

    it.each([
        ['the setting is off', { enabled: false }],
        ['the song is not external', { isExternal: false }],
        ['nothing is playing', { isPlaying: false }],
        ['there is no AudioContext', { context: null }],
    ])('does not start when %s', async (_name, patch) => {
        const { context, start, controller } = setup();

        controller.update({ ...ready, context, ...patch });
        await flush();

        expect(start).not.toHaveBeenCalled();
    });

    it('keeps the same capture while the conditions keep holding', async () => {
        const { context, start, captures, controller } = setup();

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, context });
        controller.update({ ...ready, context });
        await flush();

        expect(start).toHaveBeenCalledTimes(1);
        expect(captures[0].stop).not.toHaveBeenCalled();
    });

    it('keeps the capture through the short gap between two songs', async () => {
        const { context, start, captures, controller } = setup();

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, isPlaying: false, context });
        vi.advanceTimersByTime(SPECTRUM_CAPTURE_STOP_GRACE_MS - 1);
        controller.update({ ...ready, context });
        vi.advanceTimersByTime(SPECTRUM_CAPTURE_STOP_GRACE_MS * 2);

        expect(start).toHaveBeenCalledTimes(1);
        expect(captures[0].stop).not.toHaveBeenCalled();
    });

    it('stops the capture and clears the analyser once the gap outlasts the grace period', async () => {
        const { context, captures, published, controller } = setup();

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, isPlaying: false, context });
        expect(captures[0].stop).not.toHaveBeenCalled();
        vi.advanceTimersByTime(SPECTRUM_CAPTURE_STOP_GRACE_MS);

        expect(captures[0].stop).toHaveBeenCalledTimes(1);
        expect(published.at(-1)).toBeNull();
    });

    it('stops at once when the setting is switched off', async () => {
        const { context, captures, published, controller } = setup();

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, enabled: false, context });

        expect(captures[0].stop).toHaveBeenCalledTimes(1);
        expect(published.at(-1)).toBeNull();
    });

    it('starts again after a stop when playback resumes', async () => {
        const { context, start, controller } = setup();

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, enabled: false, context });
        controller.update({ ...ready, context });
        await flush();

        expect(start).toHaveBeenCalledTimes(2);
    });

    it('stops a capture that finishes starting after the conditions have lapsed', async () => {
        const { context, onFailure } = setup();
        let resolveStart: (capture: SystemAudioCapture) => void = () => {};
        const late = { analyser: {} as AnalyserNode, stop: vi.fn(), onEnded: vi.fn() };
        const published: Array<AnalyserNode | null> = [];
        const controller = createSpectrumCaptureController({
            start: () => new Promise<SystemAudioCapture>(resolve => { resolveStart = resolve; }),
            publish: analyser => published.push(analyser),
            onFailure,
        });

        controller.update({ ...ready, context });
        controller.update({ ...ready, enabled: false, context });
        resolveStart(late);
        await flush();

        expect(late.stop).toHaveBeenCalledTimes(1);
        expect(published).not.toContain(late.analyser);
    });

    it('restarts on the new context when the AudioContext changes', async () => {
        const { context, start, captures, controller } = setup();
        const other = { id: 'other' } as unknown as AudioContext;

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, context: other });
        await flush();

        expect(captures[0].stop).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenLastCalledWith(other);
    });

    it('reports a failed start once and does not retry while the setting stays on', async () => {
        const { context, start, onFailure, controller } = setup();
        const denied = new DOMException('Invalid capture constraints', 'AbortError');
        start.mockRejectedValueOnce(denied);

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, context });
        controller.update({ ...ready, isPlaying: false, context });
        controller.update({ ...ready, context });
        await flush();

        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onFailure).toHaveBeenCalledWith(denied);
        expect(start).toHaveBeenCalledTimes(1);
    });

    it('retries after the setting is switched off and on again', async () => {
        const { context, start, onFailure, controller } = setup();
        start.mockRejectedValueOnce(new Error('denied'));

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, enabled: false, context });
        controller.update({ ...ready, context });
        await flush();

        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(2);
    });

    it('does not report a failure that arrives after the capture was cancelled', async () => {
        const { context, onFailure } = setup();
        let rejectStart: (error: unknown) => void = () => {};
        const controller = createSpectrumCaptureController({
            start: () => new Promise<SystemAudioCapture>((_resolve, reject) => { rejectStart = reject; }),
            publish: () => {},
            onFailure,
        });

        controller.update({ ...ready, context });
        controller.update({ ...ready, enabled: false, context });
        rejectStart(new Error('late'));
        await flush();

        expect(onFailure).not.toHaveBeenCalled();
    });

    it('dispose stops the capture and cancels a pending stop', async () => {
        const { context, captures, controller } = setup();

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, isPlaying: false, context });
        controller.dispose();
        vi.advanceTimersByTime(SPECTRUM_CAPTURE_STOP_GRACE_MS * 2);

        expect(captures[0].stop).toHaveBeenCalledTimes(1);
    });
});

describe('spectrum capture controller: the capture ends on its own', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('clears the analyser and releases the capture when its track ends', async () => {
        const { context, captures, published, controller } = setup();
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        controller.update({ ...ready, context });
        await flush();
        captures[0].end();

        expect(published.at(-1)).toBeNull();
        expect(captures[0].stop).toHaveBeenCalledTimes(1);
    });

    it('warns once and shows no denial notice', async () => {
        const { context, captures, onFailure, controller } = setup();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        controller.update({ ...ready, context });
        await flush();
        captures[0].end();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('[AppleMusicSpectrum] system audio capture ended');
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('does not restart on later updates while the setting stays on', async () => {
        const { context, start, captures, controller } = setup();
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        controller.update({ ...ready, context });
        await flush();
        captures[0].end();
        controller.update({ ...ready, context });
        controller.update({ ...ready, isPlaying: false, context });
        controller.update({ ...ready, context });
        await flush();

        expect(start).toHaveBeenCalledTimes(1);
    });

    it('restarts after the setting is switched off and on again', async () => {
        const { context, start, captures, controller } = setup();
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        controller.update({ ...ready, context });
        await flush();
        captures[0].end();
        controller.update({ ...ready, enabled: false, context });
        controller.update({ ...ready, context });
        await flush();

        expect(start).toHaveBeenCalledTimes(2);
    });

    it('ignores the end of a capture that was already replaced', async () => {
        const { context, captures, published, start, controller } = setup();
        const other = { id: 'other' } as unknown as AudioContext;
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        controller.update({ ...ready, context });
        await flush();
        controller.update({ ...ready, context: other });
        await flush();
        const publishedBefore = published.length;
        captures[0].end();

        expect(captures[1].stop).not.toHaveBeenCalled();
        expect(published).toHaveLength(publishedBefore);
        expect(start).toHaveBeenCalledTimes(2);
    });

    it('stops at once when the capture ends the moment it is registered', async () => {
        const { context, onFailure } = setup();
        const published: Array<AnalyserNode | null> = [];
        const stop = vi.fn();
        const dead: SystemAudioCapture & { stop: ReturnType<typeof vi.fn> } = {
            analyser: {} as AnalyserNode,
            stop,
            onEnded: listener => listener(),
        };
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const controller = createSpectrumCaptureController({
            start: async () => dead,
            publish: analyser => published.push(analyser),
            onFailure,
        });

        controller.update({ ...ready, context });
        await flush();

        expect(dead.stop).toHaveBeenCalledTimes(1);
        expect(published.at(-1)).toBeNull();
        expect(onFailure).not.toHaveBeenCalled();
    });
});

describe('spectrum capture controller: waiting for an AudioContext', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('starts the capture once getContext yields a context', async () => {
        const { context, start, getContext, controller } = setup();

        controller.update({ ...ready, context: null });
        expect(vi.getTimerCount()).toBe(1);
        expect(start).not.toHaveBeenCalled();

        getContext.mockReturnValue(context);
        vi.advanceTimersByTime(SPECTRUM_CONTEXT_POLL_MS);
        await flush();

        expect(start).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledWith(context);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('polls every SPECTRUM_CONTEXT_POLL_MS until a context exists', async () => {
        const { context, start, getContext, controller } = setup();

        controller.update({ ...ready, context: null });
        vi.advanceTimersByTime(SPECTRUM_CONTEXT_POLL_MS * 3);
        expect(getContext).toHaveBeenCalledTimes(3);
        expect(start).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);

        getContext.mockReturnValue(context);
        vi.advanceTimersByTime(SPECTRUM_CONTEXT_POLL_MS);
        await flush();

        expect(start).toHaveBeenCalledTimes(1);
    });

    it('keeps a single timer however often it is updated', () => {
        const { controller } = setup();

        controller.update({ ...ready, context: null });
        controller.update({ ...ready, context: null });
        controller.update({ ...ready, context: null });

        expect(vi.getTimerCount()).toBe(1);
    });

    it('stops polling when the conditions lapse', () => {
        const { controller } = setup();

        controller.update({ ...ready, context: null });
        expect(vi.getTimerCount()).toBe(1);
        controller.update({ ...ready, isPlaying: false, context: null });

        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops polling when the setting is switched off', () => {
        const { controller } = setup();

        controller.update({ ...ready, context: null });
        controller.update({ ...ready, enabled: false, context: null });

        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops polling when a context is passed in directly', async () => {
        const { context, controller } = setup();

        controller.update({ ...ready, context: null });
        controller.update({ ...ready, context });
        await flush();

        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops polling on dispose', () => {
        const { controller, getContext } = setup();

        controller.update({ ...ready, context: null });
        controller.dispose();
        vi.advanceTimersByTime(SPECTRUM_CONTEXT_POLL_MS * 4);

        expect(vi.getTimerCount()).toBe(0);
        expect(getContext).not.toHaveBeenCalled();
    });

    it('does not poll without getContext, and without the other conditions', () => {
        const noGetContext = createSpectrumCaptureController({ start: vi.fn(), publish: vi.fn(), onFailure: vi.fn() });
        const { controller } = setup();

        noGetContext.update({ ...ready, context: null });
        expect(vi.getTimerCount()).toBe(0);

        controller.update({ enabled: true, isExternal: false, isPlaying: true, context: null });
        controller.update({ enabled: true, isExternal: true, isPlaying: false, context: null });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not start after the poll once the conditions lapsed in between', async () => {
        const { context, start, getContext, controller } = setup();

        controller.update({ ...ready, context: null });
        getContext.mockReturnValue(context);
        controller.update({ ...ready, isPlaying: false, context: null });
        vi.advanceTimersByTime(SPECTRUM_CONTEXT_POLL_MS * 2);
        await flush();

        expect(start).not.toHaveBeenCalled();
    });
});
