import { describe, expect, it, vi } from 'vitest';
import { startSystemAudioCapture } from '@/services/externalPlayback/systemAudioCapture';

// test/unit/externalPlayback/systemAudioCapture.test.ts
// System-audio loopback for Apple Music spectrum: the video track is dropped at once, the analyser
// matches the main one, nothing reaches the speakers, and stop() releases everything exactly once.

const createTrack = (kind: 'audio' | 'video') => ({ kind, stop: vi.fn() });

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
        await startSystemAudioCapture(fakes.context, fakes.mediaDevices);

        expect(fakes.rawMediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    });

    it('stops every video track right away and keeps the audio track running', async () => {
        const fakes = createFakes({ videoTracks: 2 });
        await startSystemAudioCapture(fakes.context, fakes.mediaDevices);

        fakes.video.forEach(track => expect(track.stop).toHaveBeenCalledTimes(1));
        fakes.audio.forEach(track => expect(track.stop).not.toHaveBeenCalled());
    });

    it('feeds the stream into an analyser configured like the main one', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices);

        expect(fakes.rawContext.createMediaStreamSource).toHaveBeenCalledWith(fakes.stream);
        expect(capture.analyser).toBe(fakes.analyser);
        expect(fakes.analyser.fftSize).toBe(2048);
        expect(fakes.analyser.smoothingTimeConstant).toBe(0.6);
        expect(fakes.source.connect).toHaveBeenCalledWith(fakes.analyser);
    });

    it('never connects to the destination, so the system audio is not played back as an echo', async () => {
        const fakes = createFakes();
        await startSystemAudioCapture(fakes.context, fakes.mediaDevices);

        expect(fakes.source.connect).toHaveBeenCalledTimes(1);
        expect(fakes.analyser.connect).not.toHaveBeenCalled();
        expect(fakes.source.connect).not.toHaveBeenCalledWith(fakes.rawContext.destination);
    });

    it('throws no-system-audio and stops every track when the stream carries no audio', async () => {
        const fakes = createFakes({ audioTracks: 0 });

        await expect(startSystemAudioCapture(fakes.context, fakes.mediaDevices)).rejects.toThrow('no-system-audio');
        fakes.video.forEach(track => expect(track.stop).toHaveBeenCalled());
        expect(fakes.rawContext.createMediaStreamSource).not.toHaveBeenCalled();
    });

    it('stops the tracks when the graph cannot be built', async () => {
        const fakes = createFakes();
        fakes.rawContext.createMediaStreamSource.mockImplementation(() => {
            throw new Error('graph failure');
        });

        await expect(startSystemAudioCapture(fakes.context, fakes.mediaDevices)).rejects.toThrow('graph failure');
        fakes.audio.forEach(track => expect(track.stop).toHaveBeenCalled());
    });

    it('rethrows a permission error untouched', async () => {
        const fakes = createFakes();
        const denied = new DOMException('Invalid capture constraints', 'AbortError');
        fakes.rawMediaDevices.getDisplayMedia.mockRejectedValueOnce(denied);

        await expect(startSystemAudioCapture(fakes.context, fakes.mediaDevices)).rejects.toBe(denied);
        expect(fakes.rawContext.createMediaStreamSource).not.toHaveBeenCalled();
    });

    it('stop() disconnects the nodes and stops the audio track', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices);

        capture.stop();

        expect(fakes.source.disconnect).toHaveBeenCalled();
        expect(fakes.analyser.disconnect).toHaveBeenCalled();
        fakes.audio.forEach(track => expect(track.stop).toHaveBeenCalled());
    });

    it('stop() is idempotent', async () => {
        const fakes = createFakes();
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices);

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
        const capture = await startSystemAudioCapture(fakes.context, fakes.mediaDevices);

        expect(() => capture.stop()).not.toThrow();
        fakes.audio.forEach(track => expect(track.stop).toHaveBeenCalled());
    });
});
