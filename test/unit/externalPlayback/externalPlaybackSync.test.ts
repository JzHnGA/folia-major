import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
    ExternalPlaybackSync,
    SYNC_HOLD_RATE,
    SYNC_SETTLE_MS,
    SYNC_START_TIMEOUT_MS,
    type ExternalPlaybackCarrier,
    type ExternalPlaybackIssue,
} from '@/services/externalPlayback/externalPlaybackSync';
import { OnlineProviderError, type OmniExternalPlaybackState } from '@/types/onlineMusic';
import type { SongResult } from '@/types';

// test/unit/externalPlayback/externalPlaybackSync.test.ts
// The per-song controller that keeps the silent carrier and Music.app in lock-step: start hold, rate hold, drift
// correction, mirrored listener controls, the settle window, takeover detection and end-of-track handling.

type CarrierEvent = 'play' | 'pause' | 'seeked';

const OUR_ID = '0123456789ABCDEF';
const OTHER_ID = 'FEDCBA9876543210';

// Stands in for the carrier <audio>: play()/pause() flip `paused` and fire their events; writing currentTime fires nothing.
class FakeCarrier implements ExternalPlaybackCarrier {
    currentTime = 0;
    playbackRate = 1;
    paused = true;
    duration = 200;
    private readonly listeners = new Map<CarrierEvent, Set<() => void>>();

    readonly play = vi.fn(async () => {
        if (!this.paused) return;
        this.paused = false;
        this.dispatch('play');
    });

    readonly pause = vi.fn(() => {
        if (this.paused) return;
        this.paused = true;
        this.dispatch('pause');
    });

    addEventListener(type: CarrierEvent, listener: () => void) {
        const set = this.listeners.get(type) ?? new Set();
        set.add(listener);
        this.listeners.set(type, set);
    }

    removeEventListener(type: CarrierEvent, listener: () => void) {
        this.listeners.get(type)?.delete(listener);
    }

    dispatch(type: CarrierEvent) {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
    }

    userSeek(positionSec: number) {
        this.currentTime = positionSec;
        this.dispatch('seeked');
    }

    listenerCount() {
        return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
    }
}

// Stands in for the Music.app engine: every command resolves; emit() pushes a state to the subscribers.
const createEngine = () => {
    const listeners = new Set<(state: OmniExternalPlaybackState) => void>();
    return {
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn().mockResolvedValue(undefined),
        seek: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        setVolume: vi.fn().mockResolvedValue(undefined),
        setMonitoring: vi.fn(),
        subscribeState: vi.fn((listener: (state: OmniExternalPlaybackState) => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        }),
        emit(state: OmniExternalPlaybackState) {
            for (const listener of [...listeners]) listener(state);
        },
        listenerCount: () => listeners.size,
    };
};

const song: SongResult = {
    id: `apple-music:${OUR_ID}`,
    name: 'Track',
    artists: [{ id: 'artist', name: 'Artist' }],
    album: { id: 'album', name: 'Album' },
    durationMs: 200_000,
    sourceRef: { kind: 'online', providerId: 'apple-music', mediaId: OUR_ID },
};

let clock: number;
let carrier: FakeCarrier;
let engine: ReturnType<typeof createEngine>;
let onHoldReleased: Mock<() => void>;
let onIssue: Mock<(issue: ExternalPlaybackIssue) => void>;
let sync: ExternalPlaybackSync;

const createSync = () => new ExternalPlaybackSync({ engine, song, carrier, now: () => clock, onHoldReleased, onIssue });

// A fresh reading of our track, sampled now unless the test says otherwise.
const state = (overrides: Partial<OmniExternalPlaybackState> = {}): OmniExternalPlaybackState => ({
    state: 'playing',
    mediaId: OUR_ID,
    positionSec: 0,
    durationSec: 200,
    sampledAtMs: clock,
    ...overrides,
});

const stopped = () => state({ state: 'stopped', mediaId: null, positionSec: 0, durationSec: null });

// An engine command that settles only when the test says so.
const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};

const flushPromises = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

// Starts with play intent (Music answers the play at once), lets Music's position advance, then plays the carrier
// as the audio bridge does on release.
const startPlaying = async () => {
    sync.start('play');
    await flushPromises();
    engine.emit(state({ positionSec: 0 }));
    clock += 250;
    engine.emit(state({ positionSec: 0.13 }));
    carrier.dispatch('seeked');   // the browser's answer to the controller's alignment seek
    carrier.play();
    clock += SYNC_SETTLE_MS;
    vi.clearAllMocks();
};

beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    carrier = new FakeCarrier();
    engine = createEngine();
    onHoldReleased = vi.fn<() => void>();
    onIssue = vi.fn<(issue: ExternalPlaybackIssue) => void>();
    sync = createSync();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('start hold', () => {
    it('keeps holding while Music reports playing but has not started advancing', () => {
        sync.start('play');
        expect(engine.play).toHaveBeenCalledWith(song, 0);
        engine.emit(state({ state: 'playing', positionSec: 0, sampledAtMs: clock }));
        clock += 250; engine.emit(state({ state: 'playing', positionSec: 0, sampledAtMs: clock }));
        expect(onHoldReleased).not.toHaveBeenCalled();
    });

    it('releases the hold once the position advances and aligns the carrier to it', () => {
        sync.start('play');
        engine.emit(state({ state: 'playing', positionSec: 0, sampledAtMs: clock }));
        clock += 250; engine.emit(state({ state: 'playing', positionSec: 0.13, sampledAtMs: clock }));
        expect(carrier.currentTime).toBeCloseTo(0.13);
        expect(onHoldReleased).toHaveBeenCalledTimes(1);
    });

    it('re-seeks Music once when it starts far from the resume position', () => {
        carrier.currentTime = 120; sync.start('play');
        engine.emit(state({ state: 'playing', positionSec: 0, sampledAtMs: clock }));
        clock += 250; engine.emit(state({ state: 'playing', positionSec: 0.2, sampledAtMs: clock }));
        expect(engine.seek).toHaveBeenCalledWith(120);
        expect(onHoldReleased).not.toHaveBeenCalled();

        // After the one re-seek the next audible reading releases, wherever Music landed.
        clock += 250; engine.emit(state({ positionSec: 119.8 }));
        clock += 250; engine.emit(state({ positionSec: 120.05 }));
        expect(engine.seek).toHaveBeenCalledTimes(1);
        expect(onHoldReleased).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBeCloseTo(120.05);
    });

    it('fails with not-playable when Music never starts within 8 s', () => {
        sync.start('play');
        engine.emit(state({ positionSec: 0 }));
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS - 1);
        expect(onIssue).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onIssue).toHaveBeenCalledTimes(1);
        const issue = onIssue.mock.calls[0][0];
        expect(issue.kind).toBe('failure');
        const error = issue.kind === 'failure' ? issue.error : null;
        expect(error).toBeInstanceOf(OnlineProviderError);
        expect(error).toMatchObject({ code: 'not-playable', providerId: 'apple-music' });
        expect(onHoldReleased).not.toHaveBeenCalled();
    });

    it('reports a rejected play as a failure and stops the start timer', async () => {
        const error = new OnlineProviderError('auth-required', 'denied', 'apple-music');
        engine.play.mockRejectedValueOnce(error);
        sync.start('play');
        await flushPromises();
        expect(onIssue).toHaveBeenCalledWith({ kind: 'failure', error });
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS);
        expect(onIssue).toHaveBeenCalledTimes(1);
    });

    it('sends nothing for an idle start', () => {
        sync.start('idle');
        for (const command of [engine.play, engine.pause, engine.resume, engine.seek, engine.stop, engine.setVolume]) {
            expect(command).not.toHaveBeenCalled();
        }
    });

    it('pauses Music when a pending start is aborted', () => {
        sync.start('play');
        sync.abortStart();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS);
        expect(onIssue).not.toHaveBeenCalled();
        expect(onHoldReleased).not.toHaveBeenCalled();
    });

    it('does not pause Music on abort when the start play was rejected', async () => {
        engine.play.mockRejectedValueOnce(new OnlineProviderError('auth-required', 'denied', 'apple-music'));
        sync.start('play');
        await flushPromises();
        sync.abortStart();
        expect(engine.pause).not.toHaveBeenCalled();
    });

    it('starts from where the listener seeks during the hold', () => {
        sync.start('play');
        carrier.userSeek(30);
        expect(engine.seek).toHaveBeenCalledWith(30);
        clock += 250; engine.emit(state({ positionSec: 30 }));
        clock += 250; engine.emit(state({ positionSec: 30.2 }));
        expect(engine.seek).toHaveBeenCalledTimes(1);
        expect(onHoldReleased).toHaveBeenCalledTimes(1);
    });

    it('re-anchors the audible check when a reading jumps backwards', () => {
        sync.start('play');
        engine.emit(state({ positionSec: 100 }));
        clock += 250; engine.emit(state({ positionSec: 0 }));
        expect(onHoldReleased).not.toHaveBeenCalled();
        clock += 250; engine.emit(state({ positionSec: 0.13 }));
        expect(onHoldReleased).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBeCloseTo(0.13);
    });

    it('re-anchors the audible check when a reading jumps further than time allows', () => {
        carrier.currentTime = 120;
        sync.start('play');
        engine.emit(state({ positionSec: 10 }));
        clock += 250; engine.emit(state({ positionSec: 120 }));
        expect(onHoldReleased).not.toHaveBeenCalled();
        clock += 250; engine.emit(state({ positionSec: 120 }));
        expect(onHoldReleased).not.toHaveBeenCalled();
        clock += 250; engine.emit(state({ positionSec: 120.1 }));
        expect(onHoldReleased).toHaveBeenCalledTimes(1);
        expect(engine.seek).not.toHaveBeenCalled();
    });

    it('honours a listener seek made after the one re-seek was used', () => {
        carrier.currentTime = 120;
        sync.start('play');
        engine.emit(state({ positionSec: 0 }));
        clock += 250; engine.emit(state({ positionSec: 0.2 }));
        expect(engine.seek).toHaveBeenCalledWith(120);
        clock += 250; engine.emit(stopped());
        carrier.userSeek(50);
        expect(engine.seek).toHaveBeenCalledTimes(1);
        clock += 250; engine.emit(state({ positionSec: 120 }));
        clock += 250; engine.emit(state({ positionSec: 120.2 }));
        expect(engine.seek).toHaveBeenCalledTimes(2);
        expect(engine.seek).toHaveBeenLastCalledWith(50);
        expect(onHoldReleased).not.toHaveBeenCalled();
        clock += 250; engine.emit(state({ positionSec: 50 }));
        clock += 250; engine.emit(state({ positionSec: 50.2 }));
        expect(onHoldReleased).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBeCloseTo(50.2);
    });

    it('clamps positions sent to Music to finite, non-negative values', async () => {
        carrier.currentTime = -1e-9;
        sync.start('play');
        expect(engine.play).toHaveBeenCalledWith(song, 0);

        const second = createSync();
        carrier.currentTime = Number.NaN;
        second.start('play');
        expect(engine.play).toHaveBeenLastCalledWith(song, 0);
    });
});

describe('drift correction', () => {
    beforeEach(async () => {
        await await startPlaying();
        carrier.currentTime = 50;
    });

    it('ignores drift under 30 ms', () => {
        engine.emit(state({ positionSec: 50.02 }));
        expect(carrier.playbackRate).toBe(1);
        expect(carrier.currentTime).toBe(50);
    });

    it('nudges the carrier rate for a steady 50 ms drift', () => {
        engine.emit(state({ positionSec: 50.05 }));
        expect(carrier.playbackRate).toBeCloseTo(1.05);
        engine.emit(state({ positionSec: 49.95 }));
        expect(carrier.playbackRate).toBeCloseTo(0.95);
        engine.emit(state({ positionSec: 50.02 }));
        expect(carrier.playbackRate).toBe(1);
        expect(carrier.currentTime).toBe(50);
    });

    it('nudges the carrier rate for drift between 30 ms and 1 s', () => {
        engine.emit(state({ positionSec: 50.3 }));
        expect(carrier.playbackRate).toBeCloseTo(1.05);
        engine.emit(state({ positionSec: 49.7 }));
        expect(carrier.playbackRate).toBeCloseTo(0.95);
        engine.emit(state({ positionSec: 50.02 }));
        expect(carrier.playbackRate).toBe(1);
        expect(carrier.currentTime).toBe(50);
    });

    it('seeks the carrier for drift over 1 s without echoing the seek to Music', () => {
        carrier.playbackRate = 1.05;
        // Sampled 200 ms ago while playing, so Music is now at 51.6.
        engine.emit(state({ positionSec: 51.4, sampledAtMs: clock - 200 }));
        expect(carrier.currentTime).toBeCloseTo(51.6);
        expect(carrier.playbackRate).toBe(1);
        carrier.dispatch('seeked');
        expect(engine.seek).not.toHaveBeenCalled();
    });

    it('skips drift correction for one second after a command', () => {
        carrier.userSeek(30);
        expect(engine.seek).toHaveBeenCalledWith(30);
        clock += 300; engine.emit(state({ positionSec: 30.2 }));
        expect(carrier.playbackRate).toBe(1);
        clock += 800; engine.emit(state({ positionSec: 30.3 }));
        expect(carrier.playbackRate).toBeCloseTo(1.05);
    });

    it('ignores a stale state sampled before the listener seek', () => {
        const seekAt = clock;
        carrier.userSeek(90);
        expect(engine.seek).toHaveBeenCalledWith(90);
        clock += SYNC_SETTLE_MS + 100;
        engine.emit(state({ positionSec: 10, sampledAtMs: seekAt - 1 }));
        expect(carrier.currentTime).toBe(90);
        expect(carrier.playbackRate).toBe(1);
    });
});

describe('listener controls', () => {
    it('mirrors listener pause, resume and seek to Music', async () => {
        await startPlaying();
        carrier.pause();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        carrier.play();
        expect(engine.resume).toHaveBeenCalledTimes(1);
        expect(engine.play).not.toHaveBeenCalled();
        carrier.userSeek(30);
        expect(engine.seek).toHaveBeenCalledWith(30);
    });

    it('plays from the carrier position when an idle start is played', () => {
        carrier.currentTime = 42;
        sync.start('idle');
        carrier.play();
        expect(engine.play).toHaveBeenCalledWith(song, 42);
    });

    it('resumes Music when an idle start finds it paused on this track', () => {
        sync.start('idle');
        engine.emit(state({ state: 'paused', positionSec: 42 }));
        carrier.play();
        expect(engine.resume).toHaveBeenCalledTimes(1);
        expect(engine.play).not.toHaveBeenCalled();
        expect(carrier.playbackRate).toBe(1);
    });

    it('waits for the next play instead of seeking Music while it is not on this track', () => {
        sync.start('idle');
        engine.emit(stopped());
        carrier.userSeek(42);
        expect(engine.seek).not.toHaveBeenCalled();
        expect(engine.play).not.toHaveBeenCalled();
        carrier.play();
        expect(engine.play).toHaveBeenCalledWith(song, 42);
    });

    it('reports a rejected command as a failure', async () => {
        await startPlaying();
        const error = new OnlineProviderError('network', 'bridge timed out', 'apple-music');
        engine.pause.mockRejectedValueOnce(error);
        carrier.pause();
        await flushPromises();
        expect(onIssue).toHaveBeenCalledWith({ kind: 'failure', error });
    });
});

describe('changes made in Music', () => {
    it('follows a pause and resume made in Music', async () => {
        await startPlaying();
        engine.emit(state({ state: 'paused', positionSec: 0.13 }));
        expect(carrier.paused).toBe(true);
        expect(engine.pause).not.toHaveBeenCalled();
        engine.emit(state({ positionSec: 0.13 }));
        expect(carrier.play).toHaveBeenCalledTimes(1);
        expect(carrier.paused).toBe(false);
        expect(engine.resume).not.toHaveBeenCalled();
        expect(engine.play).not.toHaveBeenCalled();
    });

    it('stops syncing when the listener changes the track in Music', async () => {
        await startPlaying();
        engine.emit(state({ mediaId: OTHER_ID, positionSec: 12 }));
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'track-changed' });
        expect(carrier.paused).toBe(true);
        expect(engine.pause).not.toHaveBeenCalled();
        carrier.userSeek(40);
        carrier.play();
        await sync.dispose({ stopEngine: true });
        for (const command of [engine.play, engine.pause, engine.resume, engine.seek, engine.stop]) {
            expect(command).not.toHaveBeenCalled();
        }
    });

    it('leaves Music alone during an idle start while it plays another track', () => {
        carrier.currentTime = 42;
        sync.start('idle');
        engine.emit(state({ mediaId: OTHER_ID, positionSec: 12 }));
        expect(onIssue).not.toHaveBeenCalled();
        expect(engine.pause).not.toHaveBeenCalled();
        carrier.play();
        expect(engine.play).toHaveBeenCalledWith(song, 42);
    });

    it('treats an unexpected stop as engine-stopped and replays on the next play', async () => {
        await startPlaying();
        carrier.currentTime = 60;
        engine.emit(stopped());
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'engine-stopped' });
        expect(carrier.paused).toBe(true);
        expect(engine.pause).not.toHaveBeenCalled();
        carrier.play();
        expect(engine.play).toHaveBeenCalledWith(song, 60);
        expect(carrier.playbackRate).toBe(SYNC_HOLD_RATE);
    });
});

describe('end of track', () => {
    it('pauses Music when it auto-advances at the end of the track instead of reporting a takeover', async () => {
        await startPlaying();
        carrier.currentTime = 199.5;
        engine.emit(state({ mediaId: OTHER_ID, positionSec: 0.2 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('pauses a repeated auto-advance only once', async () => {
        await startPlaying();
        carrier.currentTime = 199.5;
        for (let poll = 0; poll < 3; poll += 1) {
            clock += 250; engine.emit(state({ mediaId: OTHER_ID, positionSec: 0.2 + poll * 0.25 }));
        }
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('leaves a foreign paused reading near the end alone', async () => {
        await startPlaying();
        carrier.currentTime = 199.5;
        engine.emit(state({ state: 'paused', mediaId: OTHER_ID, positionSec: 0 }));
        expect(engine.pause).not.toHaveBeenCalled();
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('treats another track as a takeover when the listener paused just before the end', async () => {
        await startPlaying();
        carrier.currentTime = 199.5;
        carrier.pause();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        clock += SYNC_SETTLE_MS + 100; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'track-changed' });
    });

    it('pauses an auto-advance that arrives just after the carrier ended', async () => {
        await startPlaying();
        carrier.currentTime = carrier.duration;
        carrier.pause();   // the media element running out fires pause (then ended)
        expect(engine.pause).toHaveBeenCalledTimes(1);
        clock += 500; engine.emit(state({ mediaId: OTHER_ID, positionSec: 0.1 }));
        expect(engine.pause).toHaveBeenCalledTimes(2);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('ignores foreign readings once the carrier ended longer ago than the grace', async () => {
        await startPlaying();
        carrier.currentTime = carrier.duration;
        carrier.pause();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        clock += 2000; engine.emit(state({ mediaId: OTHER_ID, positionSec: 0.1 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('lets the track run out quietly near its end', async () => {
        await startPlaying();
        carrier.currentTime = 199;
        engine.emit(stopped());
        expect(onIssue).not.toHaveBeenCalled();
        expect(carrier.paused).toBe(false);
    });

    it('replays Music when the carrier loops back to the start', async () => {
        await startPlaying();
        carrier.currentTime = 199;
        engine.emit(stopped());
        carrier.userSeek(0);
        expect(engine.play).toHaveBeenCalledWith(song, 0);
        expect(engine.seek).not.toHaveBeenCalled();
        expect(carrier.playbackRate).toBe(SYNC_HOLD_RATE);
    });
});

// Music's crossfade / AutoMix starts its next track seconds before ours ends, while the carrier still has time left.
describe('Music moving on early', () => {
    it('treats Music crossfading into its next track a few seconds early as the end of ours', async () => {
        await startPlaying();
        carrier.currentTime = 194.6;
        engine.emit(state({ positionSec: 194.5, durationSec: 197.72 }));
        clock += 1000; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.5 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBe(carrier.duration);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('still reports a takeover when Music leaves our track well before its end', async () => {
        await startPlaying();
        carrier.currentTime = 60;
        engine.emit(state({ positionSec: 60 }));
        clock += SYNC_SETTLE_MS; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.5 }));
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'track-changed' });
        expect(carrier.paused).toBe(true);
        expect(carrier.currentTime).toBe(60);
        expect(engine.pause).not.toHaveBeenCalled();
    });

    it('uses the carrier duration when Music does not report one', async () => {
        await startPlaying();
        carrier.currentTime = 190;
        engine.emit(state({ positionSec: 190, durationSec: null }));
        clock += 1000; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.5 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBe(carrier.duration);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it("judges the end by Music's own duration rather than the carrier's", async () => {
        await startPlaying();
        carrier.currentTime = 186;
        // 11.72 s left by Music's clock, 14 s by the carrier's.
        engine.emit(state({ positionSec: 186, durationSec: 197.72 }));
        clock += 1000; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.5 }));
        expect(carrier.currentTime).toBe(carrier.duration);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('finishes the carrier once, without echoing its seek to Music', async () => {
        await startPlaying();
        carrier.currentTime = 194.6;
        engine.emit(state({ positionSec: 194.5, durationSec: 197.72 }));
        clock += 1000; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.5 }));
        clock += 250; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.75 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        carrier.dispatch('seeked');   // the browser's answer to the finishing seek
        expect(engine.seek).not.toHaveBeenCalled();
        expect(engine.play).not.toHaveBeenCalled();
        carrier.pause();   // the media element running out fires pause (then ended)
        clock += 250; engine.emit(state({ mediaId: OTHER_ID, positionSec: 4 }));
        // The auto-advance pause, then the carrier's own end-of-media pause; nothing more.
        expect(engine.pause).toHaveBeenCalledTimes(2);
        expect(carrier.currentTime).toBe(carrier.duration);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('does not finish a carrier the listener paused near the end', async () => {
        await startPlaying();
        carrier.currentTime = 194.6;
        engine.emit(state({ positionSec: 194.5 }));
        carrier.pause();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        clock += SYNC_SETTLE_MS + 100; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBe(194.6);
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'track-changed' });
    });

    it('does not finish the carrier after Music was stopped under it', async () => {
        await startPlaying();
        carrier.currentTime = 194.6;
        engine.emit(state({ positionSec: 194.5 }));
        clock += 250; engine.emit(stopped());
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'engine-stopped' });
        clock += 250; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3 }));
        expect(engine.pause).not.toHaveBeenCalled();
        expect(carrier.currentTime).toBe(194.6);
        expect(onIssue).toHaveBeenLastCalledWith({ kind: 'takeover', reason: 'track-changed' });
    });

    it('forgets where Music was once this controller plays the track again', async () => {
        await startPlaying();
        carrier.currentTime = 194.6;
        engine.emit(state({ positionSec: 194.5 }));
        clock += 250; engine.emit(stopped());   // engine-stopped: the carrier pauses
        carrier.userSeek(20);
        carrier.play();
        expect(engine.play).toHaveBeenCalledWith(song, 20);
        clock += 250; engine.emit(state({ positionSec: 20 }));
        clock += 250; engine.emit(state({ positionSec: 20.13 }));
        expect(carrier.playbackRate).toBe(1);   // the rate hold released
        clock += SYNC_SETTLE_MS; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3 }));
        expect(carrier.currentTime).toBeCloseTo(20.13);
        expect(engine.pause).not.toHaveBeenCalled();
        expect(onIssue).toHaveBeenLastCalledWith({ kind: 'takeover', reason: 'track-changed' });
    });

    it('does not finish the carrier from a reading that arrives after dispose', async () => {
        const subscribe = engine.subscribeState.getMockImplementation()!;
        let deliver!: (reading: OmniExternalPlaybackState) => void;
        engine.subscribeState.mockImplementationOnce((listener) => {
            deliver = listener;
            return subscribe(listener);
        });
        await startPlaying();
        carrier.currentTime = 194.6;
        engine.emit(state({ positionSec: 194.5 }));
        await sync.dispose({ stopEngine: false });
        clock += 1000; deliver(state({ mediaId: OTHER_ID, positionSec: 3.5 }));
        expect(engine.pause).not.toHaveBeenCalled();
        expect(carrier.currentTime).toBe(194.6);
        expect(onIssue).not.toHaveBeenCalled();
    });
});

describe('rate hold', () => {
    // An idle start played by the listener: the carrier keeps running at the hold rate while Music buffers.
    const playFromIdle = (positionSec: number) => {
        carrier.currentTime = positionSec;
        sync.start('idle');
        carrier.play();
    };

    it('crawls the carrier after an idle start is played until Music is audible, then aligns it', () => {
        playFromIdle(42);
        expect(engine.play).toHaveBeenCalledWith(song, 42);
        expect(carrier.playbackRate).toBe(SYNC_HOLD_RATE);
        expect(carrier.paused).toBe(false);
        engine.emit(state({ positionSec: 42 }));
        clock += 250; engine.emit(state({ positionSec: 42.13 }));
        expect(carrier.playbackRate).toBe(1);
        expect(carrier.currentTime).toBeCloseTo(42.13);
        expect(onHoldReleased).not.toHaveBeenCalled();
    });

    it('does not let drift correction touch the rate while Music is still buffering', () => {
        playFromIdle(42);
        clock += SYNC_SETTLE_MS + 100;
        carrier.currentTime = 43.5;
        engine.emit(state({ positionSec: 42 }));
        clock += 300; engine.emit(state({ positionSec: 42.02 }));
        expect(carrier.playbackRate).toBe(SYNC_HOLD_RATE);
        expect(carrier.currentTime).toBe(43.5);
    });

    it('reports not-playable and restores the rate when Music never becomes audible', () => {
        playFromIdle(42);
        engine.emit(state({ positionSec: 42 }));
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS);
        expect(onIssue).toHaveBeenCalledTimes(1);
        const issue = onIssue.mock.calls[0][0];
        const error = issue.kind === 'failure' ? issue.error : null;
        expect(error).toBeInstanceOf(OnlineProviderError);
        expect(error).toMatchObject({ code: 'not-playable', providerId: 'apple-music' });
        expect(carrier.playbackRate).toBe(1);
    });

    it('re-seeks Music once when a replay lands far from its position', () => {
        playFromIdle(42);
        engine.emit(state({ positionSec: 0 }));
        clock += 250; engine.emit(state({ positionSec: 0.2 }));
        expect(engine.seek).toHaveBeenCalledWith(42);
        expect(carrier.playbackRate).toBe(SYNC_HOLD_RATE);
        clock += 250; engine.emit(state({ positionSec: 41.9 }));
        clock += 250; engine.emit(state({ positionSec: 42.1 }));
        expect(engine.seek).toHaveBeenCalledTimes(1);
        expect(carrier.playbackRate).toBe(1);
        expect(carrier.currentTime).toBeCloseTo(42.1);
    });

    it('waits for the new position when the listener seeks during the rate hold', () => {
        playFromIdle(100);
        engine.emit(state({ positionSec: 100 }));
        carrier.userSeek(30);
        expect(engine.seek).toHaveBeenCalledWith(30);
        clock += 250; engine.emit(state({ positionSec: 30 }));
        expect(carrier.playbackRate).toBe(SYNC_HOLD_RATE);
        clock += 250; engine.emit(state({ positionSec: 30.2 }));
        expect(engine.seek).toHaveBeenCalledTimes(1);
        expect(carrier.playbackRate).toBe(1);
        expect(carrier.currentTime).toBeCloseTo(30.2);
    });

    it('drops the rate hold when the listener pauses', () => {
        playFromIdle(42);
        carrier.pause();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(carrier.playbackRate).toBe(1);
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('reports a rejected replay once and drops the rate hold', async () => {
        const error = new OnlineProviderError('not-playable', 'Track not found', 'apple-music');
        engine.play.mockRejectedValueOnce(error);
        playFromIdle(42);
        await flushPromises();
        expect(onIssue).toHaveBeenCalledWith({ kind: 'failure', error });
        expect(carrier.playbackRate).toBe(1);
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS);
        expect(onIssue).toHaveBeenCalledTimes(1);
    });

    it('reports a hung replay once when its rejection follows the timeout', async () => {
        const play = deferred();
        engine.play.mockReturnValueOnce(play.promise);
        playFromIdle(42);
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS);
        expect(onIssue).toHaveBeenCalledTimes(1);
        play.reject(new OnlineProviderError('network', 'Music app bridge timed out', 'apple-music'));
        await flushPromises();
        expect(onIssue).toHaveBeenCalledTimes(1);
    });

    it('swallows the rejection of a superseded replay', async () => {
        const first = deferred();
        engine.play.mockReturnValueOnce(first.promise);
        playFromIdle(42);
        clock += 250; engine.emit(stopped());
        carrier.userSeek(10);
        expect(engine.play).toHaveBeenLastCalledWith(song, 10);
        first.reject(new OnlineProviderError('not-playable', 'Track not found', 'apple-music'));
        await flushPromises();
        expect(onIssue).not.toHaveBeenCalled();
        expect(carrier.playbackRate).toBe(SYNC_HOLD_RATE);
    });
});

describe('settle window', () => {
    it('does not resume the carrier from a reading taken just after the listener paused', async () => {
        await startPlaying();
        carrier.pause();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        clock += 300; engine.emit(state({ positionSec: 0.4 }));
        expect(carrier.paused).toBe(true);
        expect(carrier.play).not.toHaveBeenCalled();
    });

    it('does not report a takeover for another track within one second of a play', () => {
        carrier.currentTime = 42;
        sync.start('idle');
        carrier.play();
        expect(engine.play).toHaveBeenCalledWith(song, 42);
        // Release the rate hold first: while it holds, foreign readings are ignored outright.
        engine.emit(state({ positionSec: 42 }));
        clock += 100; engine.emit(state({ positionSec: 42.13 }));
        expect(carrier.playbackRate).toBe(1);
        clock += 200; engine.emit(state({ mediaId: OTHER_ID, positionSec: 12 }));
        expect(onIssue).not.toHaveBeenCalled();
        expect(carrier.paused).toBe(false);
        clock += SYNC_SETTLE_MS; engine.emit(state({ mediaId: OTHER_ID, positionSec: 13 }));
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'track-changed' });
    });

    it('does not report engine-stopped within one second of a command', async () => {
        await startPlaying();
        carrier.currentTime = 60;
        carrier.userSeek(60);
        clock += 300; engine.emit(stopped());
        expect(onIssue).not.toHaveBeenCalled();
        expect(carrier.paused).toBe(false);
    });

    it('still follows a pause made in Music more than one second after the last command', async () => {
        await startPlaying();
        carrier.userSeek(30);
        clock += 500; engine.emit(state({ state: 'paused', positionSec: 30.5 }));
        expect(carrier.paused).toBe(false);
        clock += SYNC_SETTLE_MS; engine.emit(state({ state: 'paused', positionSec: 30.5 }));
        expect(carrier.paused).toBe(true);
        expect(engine.pause).not.toHaveBeenCalled();
    });

    it('still pauses Music auto-advancing at the end within one second of a command', async () => {
        await startPlaying();
        carrier.userSeek(199.5);
        clock += 300; engine.emit(state({ mediaId: OTHER_ID, positionSec: 0.1 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('keeps a slow replay on hold through readings that predate it', async () => {
        const play = deferred();
        engine.play.mockReturnValueOnce(play.promise);
        carrier.currentTime = 42;
        sync.start('idle');
        carrier.play();
        clock += 1500; play.resolve(); await flushPromises();
        engine.emit(state({ mediaId: OTHER_ID, positionSec: 12 }));
        engine.emit(stopped());
        expect(onIssue).not.toHaveBeenCalled();
        expect(carrier.paused).toBe(false);
        expect(carrier.playbackRate).toBe(SYNC_HOLD_RATE);
        clock += 250; engine.emit(state({ positionSec: 42 }));
        clock += 250; engine.emit(state({ positionSec: 42.13 }));
        expect(carrier.playbackRate).toBe(1);
        expect(carrier.currentTime).toBeCloseTo(42.13);
    });

    it('extends the settle window until a slow command has taken effect', async () => {
        await startPlaying();
        const pause = deferred();
        engine.pause.mockReturnValueOnce(pause.promise);
        carrier.pause();
        clock += 1500; pause.resolve(); await flushPromises();
        clock += 500; engine.emit(state({ positionSec: 2 }));
        expect(carrier.paused).toBe(true);
        clock += SYNC_SETTLE_MS; engine.emit(state({ positionSec: 3 }));
        expect(carrier.paused).toBe(false);
    });
});

describe('dispose', () => {
    it('stops Music on dispose only when asked and only if it commanded playback', async () => {
        sync.start('play');
        carrier.playbackRate = 1.05;
        await sync.dispose({ stopEngine: true });
        expect(engine.stop).toHaveBeenCalledTimes(1);
        expect(carrier.playbackRate).toBe(1);
        expect(engine.listenerCount()).toBe(0);
        expect(carrier.listenerCount()).toBe(0);

        engine.stop.mockClear();
        const kept = createSync();
        kept.start('play');
        await kept.dispose({ stopEngine: false });
        expect(engine.stop).not.toHaveBeenCalled();

        const idle = createSync();
        idle.start('idle');
        await idle.dispose({ stopEngine: true });
        expect(engine.stop).not.toHaveBeenCalled();
    });
});

// Automix arms an incoming Apple song early: Music starts on a carrier Automix holds itself, and the carrier leads
// the transition until Automix settles.
describe('preroll', () => {
    const startPreroll = async () => {
        sync.start('preroll'); await flushPromises();
        engine.emit(state({ positionSec: 0 }));
        clock += 250; engine.emit(state({ positionSec: 0.13 }));   // audible
    };

    // Automix lifts its hold 2 s after Music became audible, and Music, 2.2 s in, is seeked back to the carrier.
    const liftHold = async () => {
        clock += 2000; engine.emit(state({ positionSec: 2.1 }));
        await carrier.play();
        clock += 100; engine.emit(state({ positionSec: 2.2 }));
        await flushPromises();
    };

    it('prerolls Music without touching the held carrier', async () => {
        await startPreroll();
        expect(engine.play).toHaveBeenCalledWith(song, 0);
        clock += 1000; engine.emit(state({ positionSec: 1.2 }));
        expect(carrier.play).not.toHaveBeenCalled(); expect(carrier.currentTime).toBe(0);
        expect(engine.seek).not.toHaveBeenCalled(); expect(onHoldReleased).not.toHaveBeenCalled(); expect(onIssue).not.toHaveBeenCalled();
    });

    it('seeks Music back to the carrier once Automix starts it', async () => {
        await startPreroll();
        clock += 2000; engine.emit(state({ positionSec: 2.1 }));
        await carrier.play();                                   // Automix lifts its hold
        expect(engine.resume).not.toHaveBeenCalled(); expect(engine.play).toHaveBeenCalledTimes(1);
        clock += 100; engine.emit(state({ positionSec: 2.2 }));
        expect(engine.seek).toHaveBeenCalledWith(0); expect(carrier.playbackRate).toBe(1); expect(carrier.currentTime).toBe(0);
    });

    it('leaves Music alone for drift under a second while the carrier leads', async () => {
        await startPreroll();
        await liftHold();
        expect(engine.seek).toHaveBeenCalledTimes(1);
        clock += SYNC_SETTLE_MS;
        carrier.currentTime = 1;
        engine.emit(state({ positionSec: 1.5 }));
        expect(engine.seek).toHaveBeenCalledTimes(1);
        expect(carrier.playbackRate).toBe(1);
        expect(carrier.currentTime).toBe(1);
    });

    it('follows Music again once the transition ends', async () => {
        await startPreroll();
        await liftHold();
        clock += SYNC_SETTLE_MS;
        sync.endTransition();
        carrier.currentTime = 1;
        engine.emit(state({ positionSec: 1.3 }));
        expect(carrier.playbackRate).toBeCloseTo(1.05);
        expect(engine.seek).toHaveBeenCalledTimes(1);
    });

    // The session asks this when Automix starts the carrier: a preroll still pending there is cut to a hard cut.
    it('reports the preroll pending until Music is audible', async () => {
        sync.start('preroll');
        expect(sync.isPrerollPending()).toBe(true);
        carrier.play();   // Automix starting the carrier does not end the wait
        expect(sync.isPrerollPending()).toBe(true);
        await flushPromises();
        engine.emit(state({ positionSec: 0 }));
        clock += 250; engine.emit(state({ positionSec: 0.13 }));
        expect(sync.isPrerollPending()).toBe(false);
    });

    it('never reports a preroll pending for play and idle starts', () => {
        sync.start('play');
        expect(sync.isPrerollPending()).toBe(false);
        const idle = createSync();
        idle.start('idle');
        expect(idle.isPrerollPending()).toBe(false);
    });

    it('stops reporting the preroll pending once disposed', async () => {
        sync.start('preroll');
        await sync.dispose({ stopEngine: true });
        expect(sync.isPrerollPending()).toBe(false);
    });

    it('fails a preroll that never becomes audible within 8 s', () => {
        sync.start('preroll');
        expect(engine.play).toHaveBeenCalledWith(song, 0);
        engine.emit(state({ positionSec: 0 }));
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS - 1);
        expect(onIssue).not.toHaveBeenCalled();
        expect(sync.isPrerollPending()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(onIssue).toHaveBeenCalledTimes(1);
        const issue = onIssue.mock.calls[0][0];
        expect(issue.kind).toBe('failure');
        const error = issue.kind === 'failure' ? issue.error : null;
        expect(error).toBeInstanceOf(OnlineProviderError);
        expect(error).toMatchObject({ code: 'not-playable', providerId: 'apple-music' });
        expect(onHoldReleased).not.toHaveBeenCalled();
        expect(sync.isPrerollPending()).toBe(false);
    });

    it('reports a rejected preroll play', async () => {
        const error = new OnlineProviderError('not-playable', 'Track not found', 'apple-music');
        engine.play.mockRejectedValueOnce(error);
        sync.start('preroll');
        await flushPromises();
        expect(onIssue).toHaveBeenCalledWith({ kind: 'failure', error });
        expect(sync.isPrerollPending()).toBe(false);
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS);
        expect(onIssue).toHaveBeenCalledTimes(1);
        expect(onHoldReleased).not.toHaveBeenCalled();
    });

    it('pauses Music when a preroll is aborted', () => {
        sync.start('preroll');
        sync.abortStart();
        expect(sync.isPrerollPending()).toBe(false);
        expect(engine.pause).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS);
        expect(onIssue).not.toHaveBeenCalled();
        expect(onHoldReleased).not.toHaveBeenCalled();
    });

    it('does not pause Music on abort when the preroll play was rejected', async () => {
        engine.play.mockRejectedValueOnce(new OnlineProviderError('not-playable', 'Track not found', 'apple-music'));
        sync.start('preroll');
        await flushPromises();
        sync.abortStart();
        expect(engine.pause).not.toHaveBeenCalled();
    });

    // The session aborts a preroll whose carrier never played, which outlasts the audible check.
    it('still pauses Music on abort once it is audible but Automix has not started the carrier', async () => {
        await startPreroll();
        sync.abortStart();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        sync.abortStart();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        carrier.play();   // Music sits paused on our track: resumed, and it leads again
        expect(engine.resume).toHaveBeenCalledTimes(1);
        clock += SYNC_SETTLE_MS; carrier.currentTime = 1; engine.emit(state({ positionSec: 1.3 }));
        expect(carrier.playbackRate).toBeCloseTo(1.05);
    });

    it('ends the preroll wait on a carrier pause without a failure', () => {
        sync.start('preroll');
        carrier.play();   // Automix lifts its hold before Music is audible
        expect(engine.play).toHaveBeenCalledTimes(1);
        expect(carrier.playbackRate).toBe(1);
        carrier.pause();
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(sync.isPrerollPending()).toBe(false);
        vi.advanceTimersByTime(SYNC_START_TIMEOUT_MS);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('keeps the preroll when Automix starts the carrier before Music reports our track', () => {
        sync.start('preroll');
        engine.emit(stopped());   // Music has not switched yet
        carrier.play();
        expect(engine.play).toHaveBeenCalledTimes(1);
        expect(carrier.playbackRate).toBe(1);
        clock += 250; engine.emit(state({ positionSec: 0 }));
        clock += 250; engine.emit(state({ positionSec: 0.13 }));
        expect(engine.seek).not.toHaveBeenCalled();
        expect(carrier.currentTime).toBe(0);
        expect(carrier.playbackRate).toBe(1);
    });

    it('carries a seek made during the preroll into the wait instead of replaying Music', () => {
        sync.start('preroll');
        engine.emit(stopped());
        carrier.play();
        carrier.userSeek(30);
        expect(engine.play).toHaveBeenCalledTimes(1);
        expect(engine.seek).not.toHaveBeenCalled();
        expect(carrier.playbackRate).toBe(1);
        clock += 250; engine.emit(state({ positionSec: 0 }));
        clock += 250; engine.emit(state({ positionSec: 0.13 }));
        expect(engine.seek).toHaveBeenCalledWith(30);   // the one re-seek, to where the listener put the carrier
    });

    it('seeks Music to the carrier when it becomes audible after Automix started the carrier', () => {
        sync.start('preroll');
        carrier.play();
        carrier.currentTime = 1.5;   // the carrier ran on while Music was still loading
        engine.emit(state({ positionSec: 0 }));
        clock += 250; engine.emit(state({ positionSec: 0.13 }));
        expect(engine.seek).toHaveBeenCalledWith(1.5);
        expect(carrier.currentTime).toBe(1.5);
        expect(carrier.playbackRate).toBe(1);
    });

    it('aligns the carrier to Music when the transition ended before Music became audible', () => {
        sync.start('preroll');
        carrier.play();
        sync.endTransition();
        carrier.currentTime = 1.5;
        engine.emit(state({ positionSec: 0 }));
        clock += 250; engine.emit(state({ positionSec: 0.13 }));
        expect(engine.seek).not.toHaveBeenCalled();
        expect(carrier.currentTime).toBeCloseTo(0.13);
        expect(onHoldReleased).not.toHaveBeenCalled();
    });

    // Automix starting the carrier while Music still prerolls is the hard-cut path: the carrier already runs.
    it('aims the preroll re-seek at a carrier that already plays', async () => {
        carrier.currentTime = 30;
        sync.start('preroll');
        await carrier.play();
        carrier.currentTime = 31.5;   // the carrier ran on while Music loaded
        engine.emit(state({ positionSec: 0 }));   // Music started from the top
        clock += 250; engine.emit(state({ positionSec: 0.13 }));
        expect(engine.seek).toHaveBeenCalledTimes(1);
        expect(engine.seek).toHaveBeenLastCalledWith(31.5);
        expect(sync.isPrerollPending()).toBe(true);
        carrier.currentTime = 32;
        clock += 250; engine.emit(state({ positionSec: 31.8 }));
        clock += 250; engine.emit(state({ positionSec: 32 }));
        expect(engine.seek).toHaveBeenCalledTimes(1);   // Music already sounds where the carrier is: no second seek
        expect(sync.isPrerollPending()).toBe(false);
        expect(carrier.currentTime).toBe(32);
    });

    it('replays Music at the carrier\'s own rate when Music stopped while the carrier leads', async () => {
        await startPreroll();
        clock += 500; engine.emit(stopped());   // Music stopped while Automix still holds the carrier
        clock += 1000; await carrier.play();    // Automix lifts its hold
        expect(engine.play).toHaveBeenCalledTimes(2);
        expect(engine.play).toHaveBeenLastCalledWith(song, 0);
        expect(carrier.playbackRate).toBe(1);
        carrier.currentTime = 1.5;   // the carrier runs on at its own rate while Music loads
        clock += 250; engine.emit(state({ positionSec: 0 }));
        clock += 250; engine.emit(state({ positionSec: 0.13 }));
        expect(engine.seek).toHaveBeenCalledTimes(1);
        expect(engine.seek).toHaveBeenLastCalledWith(1.5);   // Music goes to the carrier, not the other way round
        clock += 250; engine.emit(state({ positionSec: 1.5 }));
        clock += 250; engine.emit(state({ positionSec: 1.7 }));
        expect(engine.seek).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBe(1.5);
        expect(carrier.playbackRate).toBe(1);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('replays Music at the carrier\'s own rate when the listener seeks off-track while the carrier leads', async () => {
        await startPreroll();
        await carrier.play();   // Automix lifts its hold
        carrier.userSeek(5);
        expect(engine.seek).toHaveBeenCalledWith(5);
        // Inside the settle window another track is no takeover, but Music is no longer known to be on ours.
        clock += 100; engine.emit(state({ mediaId: OTHER_ID, positionSec: 1 }));
        carrier.userSeek(30);
        expect(engine.play).toHaveBeenCalledTimes(2);
        expect(engine.play).toHaveBeenLastCalledWith(song, 30);
        expect(carrier.playbackRate).toBe(1);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('leaves a drift over a second alone inside the settle window while the carrier leads', async () => {
        await startPreroll();
        await carrier.play();   // Automix lifts its hold
        carrier.userSeek(10);
        expect(engine.seek).toHaveBeenCalledTimes(1);
        clock += 500; engine.emit(state({ positionSec: 3 }));   // 7 s off, but within a second of the seek
        expect(engine.seek).toHaveBeenCalledTimes(1);
        clock += SYNC_SETTLE_MS; engine.emit(state({ positionSec: 3.5 }));
        expect(engine.seek).toHaveBeenCalledTimes(2);
        expect(engine.seek).toHaveBeenLastCalledWith(10);
        expect(carrier.playbackRate).toBe(1);
    });

    it('does nothing on abort once Automix has started the carrier', async () => {
        await startPreroll();
        await carrier.play();
        sync.abortStart();
        expect(engine.pause).not.toHaveBeenCalled();
        clock += SYNC_SETTLE_MS; carrier.currentTime = 5; engine.emit(state({ positionSec: 1.3 }));
        expect(engine.seek).toHaveBeenLastCalledWith(5);   // the carrier still leads
        expect(carrier.playbackRate).toBe(1);
    });

    it('leaves Music in the lead when endTransition is called outside a transition', async () => {
        await startPlaying();
        sync.endTransition();
        sync.endTransition();
        carrier.currentTime = 50; engine.emit(state({ positionSec: 50.3 }));
        expect(carrier.playbackRate).toBeCloseTo(1.05);
        engine.emit(state({ positionSec: 52 }));
        expect(carrier.currentTime).toBeCloseTo(52);
        expect(engine.seek).not.toHaveBeenCalled();
    });
});

// Music's last reading of ours is what tells that ours ended under a crossfade; it must be current and meaningful.
describe("Music's last reading of ours", () => {
    it('ages the last reading of ours to the foreign sample, so a 12 s crossfade still ends ours', async () => {
        await startPlaying();
        carrier.currentTime = 180; engine.emit(state({ positionSec: 180, durationSec: 197.72 }));   // 17.72 s left
        clock += 6000; carrier.currentTime = 186;
        engine.emit(state({ mediaId: OTHER_ID, positionSec: 0.5 }));                                // aged: 11.72 s left
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBe(carrier.duration); expect(onIssue).not.toHaveBeenCalled();
    });

    it('falls back to the carrier duration when Music reports a non-positive one', async () => {
        await startPlaying();
        carrier.currentTime = 60; engine.emit(state({ positionSec: 60, durationSec: 0 }));
        clock += SYNC_SETTLE_MS; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.5 }));
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'track-changed' });
        expect(carrier.currentTime).toBe(60);
        expect(engine.pause).not.toHaveBeenCalled();
    });

    it('forgets the last reading when the listener seeks', async () => {
        await startPlaying();
        carrier.currentTime = 194.6; engine.emit(state({ positionSec: 194.5, durationSec: 197.72 }));
        carrier.userSeek(30);
        expect(engine.seek).toHaveBeenCalledWith(30);
        await flushPromises();
        clock += SYNC_SETTLE_MS; engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.5 }));
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'track-changed' });
        expect(carrier.currentTime).toBe(30);
        expect(engine.pause).not.toHaveBeenCalled();
    });

    it('does not age the last reading when a reading carries no sample time', async () => {
        await startPlaying();
        carrier.currentTime = 194.6; engine.emit(state({ positionSec: 194.5, durationSec: 197.72 }));   // 3.22 s left
        clock += 1000;
        engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.5, sampledAtMs: undefined as unknown as number }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBe(carrier.duration);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('never ages the last reading backwards for a foreign reading sampled before it', async () => {
        await startPlaying();
        const ourSampleAt = clock;
        carrier.currentTime = 186; engine.emit(state({ positionSec: 186, durationSec: 197.72 }));   // 11.72 s left
        clock += 1000;
        // Still after the last command (not stale), but 1 s before ours: aged backwards it would leave 12.72 s.
        engine.emit(state({ mediaId: OTHER_ID, positionSec: 3.5, sampledAtMs: ourSampleAt - 1000 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(carrier.currentTime).toBe(carrier.duration);
        expect(onIssue).not.toHaveBeenCalled();
    });
});
