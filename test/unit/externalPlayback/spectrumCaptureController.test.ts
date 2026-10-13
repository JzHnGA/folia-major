import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createSpectrumCaptureController,
    shouldCaptureSystemAudio,
    SPECTRUM_CAPTURE_STOP_GRACE_MS,
} from '@/services/externalPlayback/spectrumCaptureController';
import type { SystemAudioCapture } from '@/services/externalPlayback/systemAudioCapture';

// test/unit/externalPlayback/spectrumCaptureController.test.ts
// When the Apple Music spectrum capture runs: only while the setting is on, an external song plays
// and an AudioContext exists; it survives the brief gap between two songs and is not retried after
// a failure until the setting is switched off and on again.

const ready = { enabled: true, isExternal: true, isPlaying: true } as const;

const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

function setup() {
    const context = { id: 'context' } as unknown as AudioContext;
    const captures: Array<SystemAudioCapture & { stop: ReturnType<typeof vi.fn> }> = [];
    const start = vi.fn(async (_context: AudioContext) => {
        const capture = { analyser: { id: captures.length } as unknown as AnalyserNode, stop: vi.fn() };
        captures.push(capture);
        return capture;
    });
    const published: Array<AnalyserNode | null> = [];
    const onFailure = vi.fn();
    const controller = createSpectrumCaptureController({
        start,
        publish: analyser => published.push(analyser),
        onFailure,
    });
    return { context, captures, start, published, onFailure, controller };
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
        const late = { analyser: {} as AnalyserNode, stop: vi.fn() };
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
