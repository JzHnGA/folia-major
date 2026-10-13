import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/appleMusicSystemAudioLoopback.test.ts
// Main-process display-media handler behind the Apple Music spectrum: only the trusted main window's
// top frame may start a loopback capture, and any failure answers with an empty grant.

const require = createRequire(import.meta.url);
const { createDisplayMediaHandler } = require('../../../electron/appleMusic/systemAudioLoopback.cjs');

type Frame = { parent: Frame | null };

const topFrame = (): Frame => ({ parent: null });
const screenSource = { id: 'screen:1:0', name: 'Entire Screen' };

function setup({
    trusted = true,
    sources = [screenSource, { id: 'screen:2:0', name: 'Second' }] as Array<{ id: string; name: string }>,
    getSources,
}: {
    trusted?: boolean;
    sources?: Array<{ id: string; name: string }>;
    getSources?: () => Promise<Array<{ id: string; name: string }>>;
} = {}) {
    const contents = { id: 7 };
    const isTrustedMainWindowContents = vi.fn((candidate: unknown) => trusted && candidate === contents);
    const getWebContentsFromFrame = vi.fn(() => contents);
    const getScreenSources = vi.fn(getSources ?? (async () => sources));
    const handler = createDisplayMediaHandler({ isTrustedMainWindowContents, getWebContentsFromFrame, getScreenSources });
    const run = (request: Record<string, unknown>) => new Promise<unknown>(resolve => {
        handler(request, resolve);
    });
    return { handler, run, isTrustedMainWindowContents, getWebContentsFromFrame, getScreenSources, contents };
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
        const throwing = createDisplayMediaHandler({
            isTrustedMainWindowContents: () => true,
            getWebContentsFromFrame: () => { throw new Error('frame destroyed'); },
            getScreenSources: async () => [screenSource],
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
