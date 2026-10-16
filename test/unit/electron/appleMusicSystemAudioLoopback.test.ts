import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/appleMusicSystemAudioLoopback.test.ts
// Main-process display-media handler behind the Apple Music spectrum: only the trusted main window's
// top frame may start a loopback capture, only after Folia armed the one-shot gate for it, and any
// failure answers with an empty grant.

const require = createRequire(import.meta.url);
const { createDisplayMediaHandler, createSystemAudioCaptureGate } = require('../../../electron/appleMusic/systemAudioLoopback.cjs');

type Frame = { parent: Frame | null };

const topFrame = (): Frame => ({ parent: null });
const screenSource = { id: 'screen:1:0', name: 'Entire Screen' };

function setup({
    trusted = true,
    armed = true,
    sources = [screenSource, { id: 'screen:2:0', name: 'Second' }] as Array<{ id: string; name: string }>,
    getSources,
}: {
    trusted?: boolean;
    armed?: boolean;
    sources?: Array<{ id: string; name: string }>;
    getSources?: () => Promise<Array<{ id: string; name: string }>>;
} = {}) {
    const contents = { id: 7 };
    const isTrustedMainWindowContents = vi.fn((candidate: unknown) => trusted && candidate === contents);
    const getWebContentsFromFrame = vi.fn(() => contents);
    const getScreenSources = vi.fn(getSources ?? (async () => sources));
    const gate = createSystemAudioCaptureGate();
    if (armed) gate.arm(contents.id);
    const handler = createDisplayMediaHandler({ isTrustedMainWindowContents, getWebContentsFromFrame, getScreenSources, gate });
    const run = (request: Record<string, unknown>) => new Promise<unknown>(resolve => {
        handler(request, resolve);
    });
    return { handler, run, gate, isTrustedMainWindowContents, getWebContentsFromFrame, getScreenSources, contents };
}

const request = (frame: Frame | null, extra: Record<string, unknown> = {}) => ({
    frame,
    securityOrigin: 'app://folia',
    videoRequested: true,
    audioRequested: true,
    userGesture: true,
    ...extra,
});

describe('createDisplayMediaHandler', () => {
    it('grants the first screen with system audio loopback to the trusted main window', async () => {
        const { run, getScreenSources } = setup();

        await expect(run(request(topFrame()))).resolves.toEqual({ video: screenSource, audio: 'loopback' });
        expect(getScreenSources).toHaveBeenCalledTimes(1);
    });

    it('checks trust against the webContents that owns the requesting frame', async () => {
        const { run, getWebContentsFromFrame, isTrustedMainWindowContents, contents } = setup();
        const frame = topFrame();

        await run(request(frame));

        expect(getWebContentsFromFrame).toHaveBeenCalledWith(frame);
        expect(isTrustedMainWindowContents).toHaveBeenCalledWith(contents);
    });

    it('refuses a window that is not the trusted main window without listing sources', async () => {
        const { run, getScreenSources } = setup({ trusted: false });

        await expect(run(request(topFrame()))).resolves.toEqual({});
        expect(getScreenSources).not.toHaveBeenCalled();
    });

    it('refuses a sub-frame of the main window', async () => {
        const { run, getScreenSources } = setup();

        await expect(run(request({ parent: topFrame() }))).resolves.toEqual({});
        expect(getScreenSources).not.toHaveBeenCalled();
    });

    it('refuses a request whose frame is gone', async () => {
        const { run, getScreenSources } = setup();

        await expect(run(request(null))).resolves.toEqual({});
        expect(getScreenSources).not.toHaveBeenCalled();
    });

    it('refuses a request that does not ask for audio', async () => {
        const { run, getScreenSources } = setup();

        await expect(run(request(topFrame(), { audioRequested: false }))).resolves.toEqual({});
        expect(getScreenSources).not.toHaveBeenCalled();
    });

    it('refuses when the frame lookup throws', async () => {
        const gate = createSystemAudioCaptureGate();
        gate.arm(7);
        const throwing = createDisplayMediaHandler({
            isTrustedMainWindowContents: () => true,
            getWebContentsFromFrame: () => { throw new Error('frame destroyed'); },
            getScreenSources: async () => [screenSource],
            gate,
        });

        const result = await new Promise<unknown>(resolve => throwing(request(topFrame()), resolve));

        expect(result).toEqual({});
    });

    it('answers with an empty grant when listing sources fails (no recording permission)', async () => {
        const { run } = setup({ getSources: async () => { throw new Error('Failed to get sources'); } });

        await expect(run(request(topFrame()))).resolves.toEqual({});
    });

    it('answers with an empty grant when there is no screen', async () => {
        const { run } = setup({ sources: [] });

        await expect(run(request(topFrame()))).resolves.toEqual({});
    });

    it('answers exactly once', async () => {
        const { handler } = setup();
        const callback = vi.fn();

        handler(request(topFrame()), callback);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(callback).toHaveBeenCalledTimes(1);
    });
});

describe('handler arming', () => {
    it('refuses a trusted top-frame request when the gate is not armed', async () => {
        const { run, getScreenSources } = setup({ armed: false });

        await expect(run(request(topFrame()))).resolves.toEqual({});
        expect(getScreenSources).not.toHaveBeenCalled();
    });

    it('grants when armed and refuses a second request without re-arming', async () => {
        const { run, gate, contents, getScreenSources } = setup();

        await expect(run(request(topFrame()))).resolves.toEqual({ video: screenSource, audio: 'loopback' });
        await expect(run(request(topFrame()))).resolves.toEqual({});
        expect(getScreenSources).toHaveBeenCalledTimes(1);

        gate.arm(contents.id);
        await expect(run(request(topFrame()))).resolves.toEqual({ video: screenSource, audio: 'loopback' });
    });

    it('does not spend the arming on an untrusted request', async () => {
        const { run, gate, isTrustedMainWindowContents } = setup();
        isTrustedMainWindowContents.mockReturnValueOnce(false);

        await expect(run(request(topFrame()))).resolves.toEqual({});

        expect(gate.isArmed()).toBe(true);
        await expect(run(request(topFrame()))).resolves.toEqual({ video: screenSource, audio: 'loopback' });
    });

    it('refuses a request whose webContents is not the one that armed the gate', async () => {
        const { run, gate, getScreenSources } = setup({ armed: false });
        gate.arm(8);

        await expect(run(request(topFrame()))).resolves.toEqual({});
        expect(getScreenSources).not.toHaveBeenCalled();
        expect(gate.isArmed()).toBe(false);
    });
});

describe('createSystemAudioCaptureGate', () => {
    it('starts disarmed', () => {
        const gate = createSystemAudioCaptureGate();

        expect(gate.isArmed()).toBe(false);
        expect(gate.consume(1)).toBe(false);
    });

    it('is one-shot: the second consume fails', () => {
        const gate = createSystemAudioCaptureGate();

        gate.arm(1);
        expect(gate.isArmed()).toBe(true);
        expect(gate.consume(1)).toBe(true);
        expect(gate.isArmed()).toBe(false);
        expect(gate.consume(1)).toBe(false);
    });

    it('expires after armWindowMs, measured with the injected clock', () => {
        let current = 1_000;
        const gate = createSystemAudioCaptureGate({ now: () => current, armWindowMs: 5000 });

        gate.arm(1);
        current += 5000;
        expect(gate.isArmed()).toBe(true);
        current += 1;
        expect(gate.isArmed()).toBe(false);
        expect(gate.consume(1)).toBe(false);
    });

    it('still consumes at the last instant of the window', () => {
        let current = 0;
        const gate = createSystemAudioCaptureGate({ now: () => current, armWindowMs: 5000 });

        gate.arm(1);
        current = 5000;

        expect(gate.consume(1)).toBe(true);
    });

    it('defaults to a five second window', () => {
        let current = 0;
        const gate = createSystemAudioCaptureGate({ now: () => current });

        gate.arm(1);
        current = 4999;
        expect(gate.isArmed()).toBe(true);
        current = 5001;
        expect(gate.isArmed()).toBe(false);
    });

    it('refuses a different webContents id and disarms, so the attempt cannot be retried', () => {
        const gate = createSystemAudioCaptureGate();

        gate.arm(1);
        expect(gate.consume(2)).toBe(false);
        expect(gate.isArmed()).toBe(false);
        expect(gate.consume(1)).toBe(false);
    });

    it('disarms an expired arming when it is consumed', () => {
        let current = 0;
        const gate = createSystemAudioCaptureGate({ now: () => current, armWindowMs: 100 });

        gate.arm(1);
        current = 101;
        expect(gate.consume(1)).toBe(false);
        current = 50;
        expect(gate.consume(1)).toBe(false);
    });

    it('lets a later arm replace an earlier one', () => {
        let current = 0;
        const gate = createSystemAudioCaptureGate({ now: () => current, armWindowMs: 100 });

        gate.arm(1);
        current = 90;
        gate.arm(2);
        current = 150;

        expect(gate.consume(1)).toBe(false);
        gate.arm(2);
        expect(gate.consume(2)).toBe(true);
    });

    it('extends the window when it is re-armed for the same id', () => {
        let current = 0;
        const gate = createSystemAudioCaptureGate({ now: () => current, armWindowMs: 100 });

        gate.arm(1);
        current = 90;
        gate.arm(1);
        current = 150;

        expect(gate.consume(1)).toBe(true);
    });
});
