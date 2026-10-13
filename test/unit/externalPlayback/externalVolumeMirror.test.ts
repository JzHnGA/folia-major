import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ExternalVolumeMirror,
    MIRROR_RESTORE_TIMEOUT_MS,
    type ExternalVolumeTarget,
} from '@/services/externalPlayback/externalVolumeMirror';
import type { OmniExternalPlaybackState } from '@/types/onlineMusic';

// test/unit/externalPlayback/externalVolumeMirror.test.ts
// Drives Music.app's volume from Folia's gain envelopes: lookahead, 20 Hz following, the user × deck × pause-fade
// product, 0–100 de-duplication, one command in flight, no raise while the carrier is paused, and giving the user
// volume back once Folia lets go.

const OUR_ID = '0123456789ABCDEF';
const OTHER_ID = 'FEDCBA9876543210';

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

// An engine command that settles only when the test says so.
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};

let audio: { t: number };
let clock: number;
let carrier: { paused: boolean };
let engine: ReturnType<typeof createEngine>;
let mirror: ExternalVolumeMirror;

const target = (): ExternalVolumeTarget => ({ engine, mediaId: OUR_ID, deck: 'A', carrier });
const sent = () => engine.setVolume.mock.calls.map(([volume]) => volume as number);

// A reading of Music, sampled now unless the test says otherwise.
const reading = (overrides: Partial<OmniExternalPlaybackState> = {}): OmniExternalPlaybackState => ({
    state: 'playing',
    mediaId: OUR_ID,
    positionSec: 0,
    durationSec: 200,
    sampledAtMs: clock,
    ...overrides,
});

// Moves the audio clock and the wall clock together in 10 ms steps, letting settled commands run in between.
const advance = async (sec: number) => {
    await vi.advanceTimersByTimeAsync(0);
    for (let step = 0; step < Math.round(sec * 100); step += 1) {
        audio.t += 0.01;
        clock += 10;
        await vi.advanceTimersByTimeAsync(10);
    }
};

// Drives deck A down to 0, so Music ends up below the user volume; long enough for the user-volume throttle to pass.
const driveToSilence = async () => {
    mirror.setUserVolume(1);
    mirror.bind(target());
    mirror.drive();
    mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0] });
    await advance(0.2);
};

beforeEach(() => {
    vi.useFakeTimers();
    audio = { t: 0 };
    clock = 1_000_000;
    carrier = { paused: false };
    engine = createEngine();
    mirror = new ExternalVolumeMirror({ audioNow: () => audio.t, now: () => clock });
});

afterEach(() => {
    mirror.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('driving Music', () => {
    it('drives Music 60 ms ahead of the audio clock', async () => {
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 1, points: [1, 0] });
        await advance(0);
        expect(sent().at(-1)).toBeCloseTo(0.94, 5);
    });

    it('follows a moving envelope at 20 Hz and goes quiet once it settles', async () => {
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 1, points: [1, 0] });
        await advance(1.2);
        expect(sent().length).toBeGreaterThanOrEqual(19);
        expect(sent().length).toBeLessThanOrEqual(23);
        expect(sent().at(-1)).toBe(0);

        const count = sent().length;
        await advance(1);
        expect(sent().length).toBe(count);
    });

    it('multiplies the user volume, the deck and the pause fade', async () => {
        mirror.setUserVolume(0.5);
        mirror.bind(target());
        mirror.drive();
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0.5] });
        mirror.handleFadeEnvelope({ startAt: 0, seconds: 0, points: [0.5] });
        await advance(0.2);
        expect(sent().at(-1)).toBe(0.13);
    });

    it('sends each 0–100 step once', async () => {
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0.501] });
        await advance(0.1);
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0.499] });
        await advance(0.1);
        expect(sent().filter(volume => volume === 0.5)).toHaveLength(1);
        expect(sent().at(-1)).toBe(0.5);
    });

    it('reads only the deck it is bound to', async () => {
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();
        await advance(0);
        const before = sent().length;
        mirror.handleDeckEnvelope('B', { startAt: 0, seconds: 0.5, points: [1, 0] });
        await advance(0.6);
        expect(sent()).toHaveLength(before);
    });

    it('never raises Music while the carrier it drives is paused', async () => {
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0] });
        const before = sent().length;
        carrier.paused = true;                                                          // settle paused the tail synchronously...
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0.03, points: [0, 1] });   // ...then ramped its fade back to 1
        await advance(0.2);
        expect(sent().slice(before).every(volume => volume === 0)).toBe(true);
        expect(sent().at(-1)).toBe(0);
    });

    it('may raise a paused carrier that has not played since it was bound (the start hold)', async () => {
        carrier.paused = true;
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0] });
        await advance(0);
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [1] });
        await advance(0);
        expect(sent()).toEqual([1, 0, 1]);
    });

    it('sends nothing before the user volume is known', async () => {
        mirror.bind(target());
        mirror.drive();
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0.5, points: [1, 0] });
        await advance(0.6);
        expect(sent()).toEqual([]);
    });
});

describe('command queue', () => {
    it('sends only the newest value while a command is in flight', async () => {
        const command = deferred();
        engine.setVolume.mockReturnValueOnce(command.promise);
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();
        for (const value of [0.8, 0.6, 0.4]) mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [value] });
        await advance(0);
        expect(sent()).toEqual([1]);

        command.resolve();
        await advance(0);
        expect(sent()).toEqual([1, 0.4]);
    });

    it('keeps sending after Music refuses a command', async () => {
        engine.setVolume.mockRejectedValueOnce(new Error('Music is not running'));
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();                                                                  // refused...
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0.5] });      // ...with this one queued behind it
        await advance(0);
        expect(sent()).toEqual([1, 0.5]);

        engine.setVolume.mockRejectedValueOnce(new Error('Music is not running'));
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0.4] });
        await advance(0);
        // The refused value is unknown to Music, so the next evaluation sends it again.
        mirror.setUserVolume(1);
        await advance(0.1);
        expect(sent()).toEqual([1, 0.5, 0.4, 0.4]);
    });

    it('never throws out of a handler and logs the first failure only', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const broken = new ExternalVolumeMirror({
            audioNow: () => { throw new Error('no graph'); },
            now: () => clock,
        });
        broken.setUserVolume(1);
        broken.bind(target());
        expect(() => broken.drive()).not.toThrow();
        expect(() => broken.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0] })).not.toThrow();
        expect(() => broken.handleFadeEnvelope({ startAt: 0, seconds: 0, points: [0] })).not.toThrow();
        await advance(0.2);
        expect(warn).toHaveBeenCalledTimes(1);
        broken.dispose();
    });
});

describe('idle binding', () => {
    it('keeps an idle binding to plain user-volume changes, throttled to 100 ms', async () => {
        mirror.bind(target());
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0] });
        await advance(0);
        expect(sent()).toEqual([]);

        mirror.setUserVolume(0.1);
        mirror.setUserVolume(0.2);
        await advance(0.05);
        mirror.setUserVolume(0.3);
        await advance(0.05);
        expect(sent()).toEqual([0.3]);
    });

    it('sends nothing while unbound', async () => {
        mirror.setUserVolume(0.4);
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0.5, points: [1, 0] });
        await advance(0.6);
        expect(sent()).toEqual([]);
    });
});

describe('giving the user volume back', () => {
    it('gives Music the user volume once it confirms the pause', async () => {
        await driveToSilence();
        expect(sent().at(-1)).toBe(0);
        mirror.yieldControl();
        clock += 100;
        engine.emit(reading({ state: 'paused', sampledAtMs: clock }));
        expect(sent().at(-1)).toBe(1);
        expect(engine.listenerCount()).toBe(0);
    });

    it('ignores a confirmation sampled before control was yielded and restores after 500 ms', async () => {
        await driveToSilence();
        mirror.yieldControl();
        engine.emit(reading({ state: 'paused', sampledAtMs: clock - 50 }));
        await advance(0.4);
        expect(sent().at(-1)).toBe(0);

        await advance(MIRROR_RESTORE_TIMEOUT_MS / 1000 - 0.4);
        expect(sent().at(-1)).toBe(1);
        expect(engine.listenerCount()).toBe(0);
    });

    it('stops following envelopes once control is yielded and restores at once for another track', async () => {
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();
        mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 1, points: [1, 0] });
        await advance(0.3);
        mirror.yieldControl();
        clock += 10;
        engine.emit(reading({ state: 'playing', mediaId: OTHER_ID, sampledAtMs: clock }));
        expect(sent().at(-1)).toBe(1);

        const before = sent().length;
        mirror.handleDeckEnvelope('A', { startAt: audio.t, seconds: 0, points: [0] });
        await advance(0.5);
        expect(sent()).toHaveLength(before);
    });

    it('does nothing on yield when Music already sits at the user volume', async () => {
        mirror.setUserVolume(1);
        mirror.bind(target());
        mirror.drive();
        await advance(0);
        mirror.yieldControl();
        expect(engine.listenerCount()).toBe(0);
        await advance(0.6);
        expect(sent()).toEqual([1]);
    });

    it('lets a new binding on the same engine cancel a pending restore', async () => {
        await driveToSilence();
        mirror.yieldControl();
        mirror.bind({ ...target(), mediaId: OTHER_ID });
        await advance(0.6);
        expect(sent().at(-1)).toBe(0);
        expect(engine.listenerCount()).toBe(0);
    });

    it('drops a pending restore when Folia drives the same song again', async () => {
        await driveToSilence();
        mirror.yieldControl();
        mirror.drive();
        await advance(0.6);
        expect(sent().at(-1)).toBe(0);
        expect(engine.listenerCount()).toBe(0);
    });

    it('completes a pending restore after unbinding', async () => {
        await driveToSilence();
        mirror.unbind();
        await advance(0.6);
        expect(sent().at(-1)).toBe(1);
    });

    it('holds an idle user-volume change until the pending restore delivers it', async () => {
        await driveToSilence();
        mirror.yieldControl();
        mirror.setUserVolume(0.5);
        await advance(0.2);
        expect(sent().at(-1)).toBe(0);

        engine.emit(reading({ state: 'paused', sampledAtMs: clock }));
        expect(sent().at(-1)).toBe(0.5);
    });
});
