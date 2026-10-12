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

const flushPromises = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

// Starts with play intent, lets Music's position advance, then plays the carrier as the audio bridge does on release.
const startPlaying = () => {
    sync.start('play');
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

    it('clamps positions sent to Music to finite, non-negative values', () => {
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
    beforeEach(() => {
        startPlaying();
        carrier.currentTime = 50;
    });

    it('ignores drift under 80 ms', () => {
        engine.emit(state({ positionSec: 50.05 }));
        expect(carrier.playbackRate).toBe(1);
        expect(carrier.currentTime).toBe(50);
    });

    it('nudges the carrier rate for drift between 80 ms and 1 s', () => {
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
    it('mirrors listener pause, resume and seek to Music', () => {
        startPlaying();
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
        startPlaying();
        const error = new OnlineProviderError('network', 'bridge timed out', 'apple-music');
        engine.pause.mockRejectedValueOnce(error);
        carrier.pause();
        await flushPromises();
        expect(onIssue).toHaveBeenCalledWith({ kind: 'failure', error });
    });
});

describe('changes made in Music', () => {
    it('follows a pause and resume made in Music', () => {
        startPlaying();
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
        startPlaying();
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

    it('treats an unexpected stop as engine-stopped and replays on the next play', () => {
        startPlaying();
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
    it('pauses Music when it auto-advances at the end of the track instead of reporting a takeover', () => {
        startPlaying();
        carrier.currentTime = 199.5;
        engine.emit(state({ mediaId: OTHER_ID, positionSec: 0.2 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(onIssue).not.toHaveBeenCalled();
    });

    it('lets the track run out quietly near its end', () => {
        startPlaying();
        carrier.currentTime = 199;
        engine.emit(stopped());
        expect(onIssue).not.toHaveBeenCalled();
        expect(carrier.paused).toBe(false);
    });

    it('replays Music when the carrier loops back to the start', () => {
        startPlaying();
        carrier.currentTime = 199;
        engine.emit(stopped());
        carrier.userSeek(0);
        expect(engine.play).toHaveBeenCalledWith(song, 0);
        expect(engine.seek).not.toHaveBeenCalled();
        expect(carrier.playbackRate).toBe(SYNC_HOLD_RATE);
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
});

describe('settle window', () => {
    it('does not resume the carrier from a reading taken just after the listener paused', () => {
        startPlaying();
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
        clock += 300; engine.emit(state({ mediaId: OTHER_ID, positionSec: 12 }));
        expect(onIssue).not.toHaveBeenCalled();
        expect(carrier.paused).toBe(false);
        clock += SYNC_SETTLE_MS; engine.emit(state({ mediaId: OTHER_ID, positionSec: 13 }));
        expect(onIssue).toHaveBeenCalledWith({ kind: 'takeover', reason: 'track-changed' });
    });

    it('does not report engine-stopped within one second of a command', () => {
        startPlaying();
        carrier.currentTime = 60;
        carrier.userSeek(60);
        clock += 300; engine.emit(stopped());
        expect(onIssue).not.toHaveBeenCalled();
        expect(carrier.paused).toBe(false);
    });

    it('still follows a pause made in Music more than one second after the last command', () => {
        startPlaying();
        carrier.userSeek(30);
        clock += 500; engine.emit(state({ state: 'paused', positionSec: 30.5 }));
        expect(carrier.paused).toBe(false);
        clock += SYNC_SETTLE_MS; engine.emit(state({ state: 'paused', positionSec: 30.5 }));
        expect(carrier.paused).toBe(true);
        expect(engine.pause).not.toHaveBeenCalled();
    });

    it('still pauses Music auto-advancing at the end within one second of a command', () => {
        startPlaying();
        carrier.userSeek(199.5);
        clock += 300; engine.emit(state({ mediaId: OTHER_ID, positionSec: 0.1 }));
        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(onIssue).not.toHaveBeenCalled();
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
