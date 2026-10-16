import { describe, expect, it, vi } from 'vitest';
import { startSystemAudioCapture } from '@/services/externalPlayback/systemAudioCapture';

// test/unit/externalPlayback/systemAudioCapture.test.ts
// System-audio loopback for Apple Music spectrum: the main process is armed before getDisplayMedia is called,
// the video track is dropped at once, the analyser matches the main one, nothing reaches the speakers,
// stop() releases everything exactly once, and a track that ends on its own is reported once.

// Tracks keep their 'ended' listeners so a test can end one the way the browser does.
const createTrack = (kind: 'audio' | 'video') => {
    const listeners = new Map<string, Array<() => void>>();
    return {
        kind,
        stop: vi.fn(),
        addEventListener: vi.fn((type: string, listener: () => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        }),
        emit: (type: string) => (listeners.get(type) ?? []).forEach(listener => listener()),
    };
};

// The main process arms the display-media gate through this; the default would reach for window.electron.
const armed = async () => true;

function createFakes({ audioTracks = 1, videoTracks = 1 }: { audioTracks?: number; videoTracks?: number } = {}) {
    const audio = Array.from({ length: audioTracks }, () => createTrack('audio'));
    const video = Array.from({ length: videoTracks }, () => createTrack('video'));
    const stream = {
        getTracks: () => [...video, ...audio],
        getVideoTracks: () => video,
        getAudioTracks: () => audio,
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const analyser = { fftSize: 0, smoothingTimeConstant: 0, connect: vi.fn(), disconnect: vi.fn() };
    const context = {
        destination: { name: 'destination' },
        createMediaStreamSource: vi.fn(() => source),
        createAnalyser: vi.fn(() => analyser),
    };
    const mediaDevices = { getDisplayMedia: vi.fn(async () => stream) };
    return {
        audio,
        video,
        stream,
        source,
        analyser,
        context: context as unknown as AudioContext,
        rawContext: context,
        mediaDevices: mediaDevices as unknown as Pick<MediaDevices, 'getDisplayMedia'>,
        rawMediaDevices: mediaDevices,
    };
}

describe('startSystemAudioCapture', () => {
    it('asks for display media with video and audio', async () => {
        const fakes = createFakes();
        await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);

        expect(fakes.rawMediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    });

    it('stops every video track right away and keeps the audio track running', async () => {
        const fakes = createFakes({ videoTracks: 2 });
        await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);

        fakes.video.forEach(track => expect(track.stop).toHaveBeenCalledTimes(1));
        fakes.audio.forEach(track => expect(track.stop).not.toHaveBeenCalled());
    });

    it('feeds the stream into an analyser configured like the main one', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);

        expect(fakes.rawContext.createMediaStreamSource).toHaveBeenCalledWith(fakes.stream);
        expect(capture.analyser).toBe(fakes.analyser);
        expect(fakes.analyser.fftSize).toBe(2048);
        expect(fakes.analyser.smoothingTimeConstant).toBe(0.6);
        expect(fakes.source.connect).toHaveBeenCalledWith(fakes.analyser);
    });

    it('never connects to the destination, so the system audio is not played back as an echo', async () => {
        const fakes = createFakes();
        await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);

        expect(fakes.source.connect).toHaveBeenCalledTimes(1);
        expect(fakes.analyser.connect).not.toHaveBeenCalled();
        expect(fakes.source.connect).not.toHaveBeenCalledWith(fakes.rawContext.destination);
    });

    it('throws no-system-audio and stops every track when the stream carries no audio', async () => {
        const fakes = createFakes({ audioTracks: 0 });

        await expect(startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed)).rejects.toThrow('no-system-audio');
        fakes.video.forEach(track => expect(track.stop).toHaveBeenCalled());
        expect(fakes.rawContext.createMediaStreamSource).not.toHaveBeenCalled();
    });

    it('stops the tracks when the graph cannot be built', async () => {
        const fakes = createFakes();
        fakes.rawContext.createMediaStreamSource.mockImplementation(() => {
            throw new Error('graph failure');
        });

        await expect(startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed)).rejects.toThrow('graph failure');
        fakes.audio.forEach(track => expect(track.stop).toHaveBeenCalled());
    });

    it('rethrows a permission error untouched', async () => {
        const fakes = createFakes();
        const denied = new DOMException('Invalid capture constraints', 'AbortError');
        fakes.rawMediaDevices.getDisplayMedia.mockRejectedValueOnce(denied);

        await expect(startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed)).rejects.toBe(denied);
        expect(fakes.rawContext.createMediaStreamSource).not.toHaveBeenCalled();
    });

    it('stop() disconnects the nodes and stops the audio track', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);

        capture.stop();

        expect(fakes.source.disconnect).toHaveBeenCalled();
        expect(fakes.analyser.disconnect).toHaveBeenCalled();
        fakes.audio.forEach(track => expect(track.stop).toHaveBeenCalled());
    });

    it('stop() is idempotent', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);

        capture.stop();
        const sourceDisconnects = fakes.source.disconnect.mock.calls.length;
        const audioStops = fakes.audio[0].stop.mock.calls.length;
        capture.stop();

        expect(fakes.source.disconnect).toHaveBeenCalledTimes(sourceDisconnects);
        expect(fakes.audio[0].stop).toHaveBeenCalledTimes(audioStops);
    });

    it('stop() survives a node that throws on disconnect', async () => {
        const fakes = createFakes();
        fakes.source.disconnect.mockImplementation(() => {
            throw new Error('already disconnected');
        });
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);

        expect(() => capture.stop()).not.toThrow();
        fakes.audio.forEach(track => expect(track.stop).toHaveBeenCalled());
    });

    it('arms the main process before it asks for display media', async () => {
        const fakes = createFakes();
        const order: string[] = [];
        const arm = vi.fn(async () => { order.push('arm'); return true; });
        fakes.rawMediaDevices.getDisplayMedia.mockImplementationOnce(async () => {
            order.push('getDisplayMedia');
            return fakes.stream;
        });

        await startSystemAudioCapture(fakes.context, fakes.mediaDevices, arm);

        expect(arm).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['arm', 'getDisplayMedia']);
    });

    it('waits for the arming to resolve before it asks for display media', async () => {
        const fakes = createFakes();
        let resolveArm: (value: boolean) => void = () => {};
        const arm = () => new Promise<boolean>(resolve => { resolveArm = resolve; });

        const started = startSystemAudioCapture(fakes.context, fakes.mediaDevices, arm);
        await Promise.resolve();
        expect(fakes.rawMediaDevices.getDisplayMedia).not.toHaveBeenCalled();

        resolveArm(true);
        await started;
        expect(fakes.rawMediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);
    });

    it('throws system-audio-unavailable without asking for display media when arming resolves false', async () => {
        const fakes = createFakes();

        await expect(startSystemAudioCapture(fakes.context, fakes.mediaDevices, async () => false))
            .rejects.toThrow('system-audio-unavailable');
        expect(fakes.rawMediaDevices.getDisplayMedia).not.toHaveBeenCalled();
    });

    it('rethrows an arming rejection untouched and never asks for display media', async () => {
        const fakes = createFakes();
        const refused = new Error('Untrusted renderer attempted to arm system audio capture.');

        await expect(startSystemAudioCapture(fakes.context, fakes.mediaDevices, async () => { throw refused; }))
            .rejects.toBe(refused);
        expect(fakes.rawMediaDevices.getDisplayMedia).not.toHaveBeenCalled();
    });

    it('treats a missing bridge as unavailable when no arm is passed', async () => {
        const fakes = createFakes();

        await expect(startSystemAudioCapture(fakes.context, fakes.mediaDevices))
            .rejects.toThrow('system-audio-unavailable');
        expect(fakes.rawMediaDevices.getDisplayMedia).not.toHaveBeenCalled();
    });

    it('onEnded fires once when the audio track ends', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);
        const listener = vi.fn();
        capture.onEnded(listener);

        fakes.audio[0].emit('ended');
        fakes.audio[0].emit('ended');

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('onEnded does not fire after stop()', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);
        const listener = vi.fn();
        capture.onEnded(listener);

        capture.stop();
        fakes.audio[0].emit('ended');

        expect(listener).not.toHaveBeenCalled();
    });

    it('onEnded called after the track already ended fires at once', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);

        fakes.audio[0].emit('ended');
        const listener = vi.fn();
        capture.onEnded(listener);

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('onEnded called after stop() never fires', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);

        capture.stop();
        const listener = vi.fn();
        capture.onEnded(listener);
        fakes.audio[0].emit('ended');

        expect(listener).not.toHaveBeenCalled();
    });

    it('ignores the video track ending', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices, armed);
        const listener = vi.fn();
        capture.onEnded(listener);

        fakes.video[0].emit('ended');

        expect(listener).not.toHaveBeenCalled();
    });
});
