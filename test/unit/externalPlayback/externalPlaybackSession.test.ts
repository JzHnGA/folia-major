import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
    ExternalPlaybackSession,
    routeExternalPlaybackIssue,
    type ExternalPlaybackIssueRoute,
    type ExternalPlaybackSessionInput,
} from '@/services/externalPlayback/externalPlaybackSession';
import type {
    ExternalPlaybackIssue,
    ExternalPlaybackSync,
    ExternalPlaybackSyncOptions,
} from '@/services/externalPlayback/externalPlaybackSync';
import { OnlineProviderError, type OmniExternalPlaybackEngine } from '@/types/onlineMusic';
import { PlayerState, type SongResult } from '@/types';

// test/unit/externalPlayback/externalPlaybackSession.test.ts
// The cross-track session: the autoplay hold for a new external song, when each per-song controller is created,
// started, replaced and disposed, engine monitoring, the throttled volume mirror, and how issues are routed.

type CarrierEvent = 'play' | 'pause' | 'seeked' | 'loadedmetadata';

// Stands in for the carrier <audio>: readyState is set by the test, pause() fires its event at once.
class FakeCarrier {
    currentTime = 0;
    playbackRate = 1;
    paused = true;
    duration = 200;
    readyState = 0;
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

    listenerCount(type: CarrierEvent) {
        return this.listeners.get(type)?.size ?? 0;
    }
}

interface FakeSync {
    start: Mock<(intent: 'play' | 'idle') => void>;
    abortStart: Mock<() => void>;
    dispose: Mock<(options: { stopEngine: boolean }) => Promise<void>>;
}

const appleSong = (mediaId: string): SongResult => ({
    id: `apple-music:${mediaId}`,
    name: `Track ${mediaId}`,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: { id: 'album', name: 'Album' },
    durationMs: 200_000,
    sourceRef: { kind: 'online', providerId: 'apple-music', mediaId },
});

const APPLE = appleSong('0123456789ABCDEF');
const APPLE_NEXT = appleSong('FEDCBA9876543210');
const NETEASE: SongResult = {
    id: 42,
    name: 'Netease track',
    artists: [{ id: 1, name: 'Artist' }],
    album: { id: 2, name: 'Album' },
    durationMs: 180_000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '42' },
};
const SRC = 'blob:carrier-1';
const SRC_NEXT = 'blob:carrier-2';

let carrier: FakeCarrier;
let engine: { setMonitoring: Mock<(active: boolean) => void>; setVolume: Mock<(volume: number) => Promise<void>> };
let created: Array<{ options: ExternalPlaybackSyncOptions; sync: FakeSync }>;
let createSync: Mock<(options: ExternalPlaybackSyncOptions) => ExternalPlaybackSync>;
let clearAutoplayIntent: Mock<() => void>;
let setPaused: Mock<() => void>;
let onIssue: Mock<(issue: ExternalPlaybackIssue) => void>;
let session: ExternalPlaybackSession;

const isExternal = (song: SongResult | null | undefined) => (
    song?.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'apple-music'
);

const input = (overrides: Partial<ExternalPlaybackSessionInput> = {}): ExternalPlaybackSessionInput => ({
    song: APPLE,
    audioSrc: SRC,
    carrier,
    playerState: PlayerState.IDLE,
    wantsAutoplay: true,
    isLyricsLoading: false,
    ...overrides,
});

const latest = () => created[created.length - 1];

const flushPromises = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

beforeEach(() => {
    carrier = new FakeCarrier();
    engine = { setMonitoring: vi.fn(), setVolume: vi.fn().mockResolvedValue(undefined) };
    created = [];
    createSync = vi.fn((options: ExternalPlaybackSyncOptions) => {
        const sync: FakeSync = { start: vi.fn(), abortStart: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) };
        created.push({ options, sync });
        return sync as unknown as ExternalPlaybackSync;
    });
    clearAutoplayIntent = vi.fn();
    setPaused = vi.fn();
    onIssue = vi.fn();
    session = new ExternalPlaybackSession({
        isExternal,
        getEngine: song => (isExternal(song) ? engine as unknown as OmniExternalPlaybackEngine : null),
        createSync,
        clearAutoplayIntent,
        setPaused,
        onIssue,
    });
});

// A session whose issues go through the real routing into a stand-in playback store, as the hook wires it.
const createRoutedSession = (playerState: PlayerState) => {
    const store = { playerState };
    const onPlaybackFailure = vi.fn();
    const showStatus = vi.fn();
    const pause = () => { store.playerState = PlayerState.PAUSED; };
    const routed = new ExternalPlaybackSession({
        isExternal,
        getEngine: song => (isExternal(song) ? engine as unknown as OmniExternalPlaybackEngine : null),
        createSync,
        clearAutoplayIntent,
        setPaused: pause,
        onIssue: issue => routeExternalPlaybackIssue(issue, {
            playerState: store.playerState,
            setPaused: pause,
            showStatus,
            onPlaybackFailure,
        }),
    });
    return { session: routed, store, onPlaybackFailure, showStatus };
};

afterEach(() => {
    vi.useRealTimers();
});

describe('ExternalPlaybackSession', () => {
    it('holds autoplay for a new external song in the same render that receives its source', () => {
        expect(session.isAutoplayHeld(APPLE, SRC)).toBe(true);
        expect(session.isAutoplayHeld(NETEASE, 'https://x')).toBe(false);
        expect(session.isAutoplayHeld(APPLE, null)).toBe(false);
        expect(session.isAutoplayHeld(null, SRC)).toBe(false);
    });

    it('starts with play intent once the carrier has metadata and releases the hold on request', () => {
        session.update(input({ wantsAutoplay: true }));

        expect(createSync).toHaveBeenCalledTimes(1);
        const { options, sync } = latest();
        expect(options.song).toBe(APPLE);
        expect(options.carrier).toBe(carrier);
        expect(options.engine).toBe(engine);
        expect(sync.start).not.toHaveBeenCalled();

        carrier.readyState = 1;
        carrier.dispatch('loadedmetadata');
        expect(sync.start).toHaveBeenCalledWith('play');
        expect(carrier.listenerCount('loadedmetadata')).toBe(0);

        const listener = vi.fn();
        session.subscribe(listener);
        const versionBefore = session.getVersion();
        expect(session.isAutoplayHeld(APPLE, SRC)).toBe(true);

        options.onHoldReleased();

        expect(session.isAutoplayHeld(APPLE, SRC)).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(session.getVersion()).not.toBe(versionBefore);
    });

    it('starts idle and does not hold when nothing wants to autoplay', () => {
        carrier.readyState = 1;
        session.update(input({ wantsAutoplay: false }));

        expect(latest().sync.start).toHaveBeenCalledWith('idle');
        expect(session.isAutoplayHeld(APPLE, SRC)).toBe(false);
    });

    it('keeps holding and defers the play start until the lyrics have loaded', () => {
        carrier.readyState = 1;
        session.update(input({ isLyricsLoading: true, playerState: PlayerState.IDLE }));

        expect(createSync).toHaveBeenCalledTimes(1);
        expect(latest().sync.start).not.toHaveBeenCalled();
        expect(session.isAutoplayHeld(APPLE, SRC)).toBe(true);

        session.update(input({ isLyricsLoading: false, playerState: PlayerState.IDLE }));

        expect(latest().sync.start).toHaveBeenCalledWith('play');
        expect(latest().sync.start).toHaveBeenCalledTimes(1);
        expect(createSync).toHaveBeenCalledTimes(1);
        expect(session.isAutoplayHeld(APPLE, SRC)).toBe(true);

        session.update(input({ isLyricsLoading: false, playerState: PlayerState.PLAYING }));
        expect(latest().sync.start).toHaveBeenCalledTimes(1);
    });

    it('still waits for the carrier metadata once the lyrics have loaded', () => {
        session.update(input({ isLyricsLoading: true }));
        session.update(input({ isLyricsLoading: false }));
        expect(latest().sync.start).not.toHaveBeenCalled();

        carrier.readyState = 1;
        carrier.dispatch('loadedmetadata');

        expect(latest().sync.start).toHaveBeenCalledWith('play');
    });

    it('starts an idle controller without waiting for the lyrics', () => {
        carrier.readyState = 1;
        session.update(input({ wantsAutoplay: false, isLyricsLoading: true }));

        expect(latest().sync.start).toHaveBeenCalledWith('idle');
    });

    it('starts idle when the listener pauses while the lyrics are still loading', () => {
        carrier.readyState = 1;
        session.update(input({ isLyricsLoading: true, playerState: PlayerState.IDLE }));
        session.update(input({ isLyricsLoading: true, playerState: PlayerState.PAUSED }));

        expect(latest().sync.start).toHaveBeenCalledWith('idle');
        expect(latest().sync.abortStart).not.toHaveBeenCalled();
        expect(clearAutoplayIntent).toHaveBeenCalledTimes(1);
        expect(session.isAutoplayHeld(APPLE, SRC)).toBe(false);
    });

    it('pauses the engine and clears autoplay when the listener pauses during the start hold', () => {
        carrier.readyState = 1;
        session.update(input({ playerState: PlayerState.PLAYING }));
        const listener = vi.fn();
        session.subscribe(listener);

        session.update(input({ playerState: PlayerState.PAUSED }));

        expect(latest().sync.abortStart).toHaveBeenCalledTimes(1);
        expect(clearAutoplayIntent).toHaveBeenCalledTimes(1);
        expect(session.isAutoplayHeld(APPLE, SRC)).toBe(false);
        expect(listener).toHaveBeenCalled();
        expect(createSync).toHaveBeenCalledTimes(1);
    });

    it('starts idle when the listener paused before the carrier had metadata', () => {
        session.update(input({ playerState: PlayerState.PLAYING }));
        session.update(input({ playerState: PlayerState.PAUSED }));

        carrier.readyState = 1;
        carrier.dispatch('loadedmetadata');

        expect(latest().sync.start).toHaveBeenCalledWith('idle');
        expect(clearAutoplayIntent).toHaveBeenCalledTimes(1);
    });

    it('ignores a pause once the hold is released', () => {
        carrier.readyState = 1;
        session.update(input({ playerState: PlayerState.PLAYING }));
        latest().options.onHoldReleased();

        session.update(input({ playerState: PlayerState.PAUSED }));

        expect(latest().sync.abortStart).not.toHaveBeenCalled();
        expect(clearAutoplayIntent).not.toHaveBeenCalled();
    });

    it('stops Music when moving to a non-external song and keeps it when moving to another Apple song', () => {
        carrier.readyState = 1;
        session.update(input());
        const first = latest().sync;
        expect(engine.setMonitoring).toHaveBeenCalledWith(true);

        session.update(input({ song: APPLE_NEXT, audioSrc: SRC_NEXT }));
        const second = latest().sync;

        expect(first.dispose).toHaveBeenCalledWith({ stopEngine: false });
        // The old controller lets go of the carrier before the new one is created on it.
        expect(first.dispose.mock.invocationCallOrder[0]).toBeLessThan(createSync.mock.invocationCallOrder[1]);
        expect(engine.setMonitoring).not.toHaveBeenCalledWith(false);

        session.update(input({ song: NETEASE, audioSrc: 'https://x' }));

        expect(second.dispose).toHaveBeenCalledWith({ stopEngine: true });
        expect(engine.setMonitoring).toHaveBeenLastCalledWith(false);
        expect(createSync).toHaveBeenCalledTimes(2);
    });

    it('drops a pending start when the song changes before the carrier had metadata', () => {
        session.update(input());
        const first = latest().sync;

        session.update(input({ song: NETEASE, audioSrc: 'https://x' }));
        carrier.dispatch('loadedmetadata');

        expect(first.start).not.toHaveBeenCalled();
        expect(first.dispose).toHaveBeenCalledWith({ stopEngine: true });
        expect(carrier.listenerCount('loadedmetadata')).toBe(0);
    });

    it('ignores a replaced controller releasing its hold', () => {
        carrier.readyState = 1;
        session.update(input());
        const stale = latest().options;
        session.update(input({ song: APPLE_NEXT, audioSrc: SRC_NEXT }));

        stale.onHoldReleased();

        expect(session.isAutoplayHeld(APPLE_NEXT, SRC_NEXT)).toBe(true);
    });

    it('mirrors volume only while an external song is current', async () => {
        vi.useFakeTimers();
        session.update(input({ song: NETEASE, audioSrc: 'https://x' }));
        session.mirrorVolume(0.5);
        await vi.advanceTimersByTimeAsync(200);
        expect(engine.setVolume).not.toHaveBeenCalled();

        carrier.readyState = 1;
        session.update(input({ wantsAutoplay: false }));
        session.mirrorVolume(0.1);
        session.mirrorVolume(0.2);
        await vi.advanceTimersByTimeAsync(50);
        session.mirrorVolume(0.3);
        expect(engine.setVolume).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(50);

        expect(engine.setVolume).toHaveBeenCalledTimes(1);
        expect(engine.setVolume).toHaveBeenCalledWith(0.3);
    });

    it('tells Music the current volume right behind a play start, never behind an idle one', () => {
        session.mirrorVolume(0);
        carrier.readyState = 1;
        session.update(input({ song: APPLE, audioSrc: SRC, wantsAutoplay: false }));
        expect(engine.setVolume).not.toHaveBeenCalled();

        session.update(input({ song: APPLE_NEXT, audioSrc: SRC_NEXT, wantsAutoplay: true }));

        const { sync } = latest();
        expect(sync.start).toHaveBeenCalledWith('play');
        expect(engine.setVolume).toHaveBeenCalledWith(0);
        expect(sync.start.mock.invocationCallOrder[0]).toBeLessThan(engine.setVolume.mock.invocationCallOrder[0]);
    });

    it('swallows a refused volume command', async () => {
        vi.useFakeTimers();
        engine.setVolume.mockRejectedValue(new OnlineProviderError('unavailable', 'Music is not running', 'apple-music'));
        carrier.readyState = 1;
        session.update(input({ wantsAutoplay: false }));

        session.mirrorVolume(0.4);
        await vi.advanceTimersByTimeAsync(100);

        expect(engine.setVolume).toHaveBeenCalledWith(0.4);
    });

    it('forwards sync issues to the dependency and keeps the controller after Music stopped', async () => {
        carrier.readyState = 1;
        session.update(input());
        const issue: ExternalPlaybackIssue = { kind: 'takeover', reason: 'engine-stopped' };

        latest().options.onIssue(issue);
        await flushPromises();

        expect(onIssue).toHaveBeenCalledWith(issue);
        expect(latest().sync.dispose).not.toHaveBeenCalled();
        expect(createSync).toHaveBeenCalledTimes(1);
    });

    it('hands Music back to a fresh idle controller after the listener changed the song in Music', async () => {
        const routed = createRoutedSession(PlayerState.PLAYING);
        carrier.readyState = 1;
        routed.session.update(input({ wantsAutoplay: false, playerState: PlayerState.PLAYING }));
        const old = latest();
        await carrier.play();
        // The controller paused the carrier on the takeover; its pause event is still on its way.
        carrier.paused = true;

        old.options.onIssue({ kind: 'takeover', reason: 'track-changed' });

        expect(routed.showStatus).toHaveBeenCalledWith('info', 'appleMusic.takeover');
        expect(old.sync.dispose).toHaveBeenCalledWith({ stopEngine: false });
        await flushPromises();
        expect(createSync).toHaveBeenCalledTimes(1);

        carrier.dispatch('pause');
        await flushPromises();

        expect(createSync).toHaveBeenCalledTimes(2);
        expect(latest().options.song).toBe(APPLE);
        expect(latest().sync.start).toHaveBeenCalledWith('idle');
        expect(routed.onPlaybackFailure).not.toHaveBeenCalled();
        expect(carrier.listenerCount('pause')).toBe(1);   // only the session's own carrier watch is left
    });

    it('replaces a failed controller with an idle one and hands back a held autoplay', async () => {
        carrier.readyState = 1;
        session.update(input({ playerState: PlayerState.PLAYING }));
        const failed = latest();
        const issue: ExternalPlaybackIssue = {
            kind: 'failure',
            error: new OnlineProviderError('auth-required', 'denied', 'apple-music'),
        };

        failed.options.onIssue(issue);

        expect(onIssue).toHaveBeenCalledWith(issue);
        // Routed while the playback store still describes the moment of the failure.
        expect(onIssue.mock.invocationCallOrder[0]).toBeLessThan(failed.sync.dispose.mock.invocationCallOrder[0]);
        expect(failed.sync.dispose).toHaveBeenCalledWith({ stopEngine: true });
        expect(clearAutoplayIntent).toHaveBeenCalledTimes(1);
        expect(setPaused).toHaveBeenCalledTimes(1);
        expect(session.isAutoplayHeld(APPLE, SRC)).toBe(false);

        await flushPromises();

        expect(createSync).toHaveBeenCalledTimes(2);
        const fresh = latest();
        expect(fresh.options.song).toBe(APPLE);
        expect(fresh.options.carrier).toBe(carrier);
        expect(fresh.sync.start).toHaveBeenCalledWith('idle');
    });

    it('pauses a playing carrier and waits for the failed controller before attaching a fresh one', async () => {
        carrier.readyState = 1;
        session.update(input({ wantsAutoplay: false, playerState: PlayerState.PLAYING }));
        const failed = latest();
        let finishDispose!: () => void;
        failed.sync.dispose.mockReturnValue(new Promise<void>(resolve => { finishDispose = resolve; }));
        carrier.paused = false;

        failed.options.onIssue({ kind: 'failure', error: new Error('timeout') });

        expect(carrier.pause).toHaveBeenCalledTimes(1);
        expect(clearAutoplayIntent).not.toHaveBeenCalled();
        expect(setPaused).not.toHaveBeenCalled();
        await flushPromises();
        expect(createSync).toHaveBeenCalledTimes(1);

        finishDispose();
        await flushPromises();

        expect(createSync).toHaveBeenCalledTimes(2);
        expect(latest().sync.start).toHaveBeenCalledWith('idle');
        expect(carrier.listenerCount('pause')).toBe(1);   // only the session's own carrier watch is left
    });

    it('ends paused when a held start fails and the queue skips', () => {
        const routed = createRoutedSession(PlayerState.PLAYING);
        carrier.readyState = 1;
        routed.session.update(input({ playerState: PlayerState.PLAYING }));
        expect(latest().sync.start).toHaveBeenCalledWith('play');

        latest().options.onIssue({
            kind: 'failure',
            error: new OnlineProviderError('not-playable', 'Music did not become audible within 8 s', 'apple-music'),
        });

        expect(routed.onPlaybackFailure).toHaveBeenCalledTimes(1);
        expect(routed.showStatus).toHaveBeenCalledWith('error', 'appleMusic.playFailed');
        expect(routed.store.playerState).toBe(PlayerState.PAUSED);
        expect(carrier.pause).not.toHaveBeenCalled();
    });

    it('does not attach a fresh controller after the song moved on', async () => {
        carrier.readyState = 1;
        session.update(input());
        latest().options.onIssue({ kind: 'failure', error: new Error('timeout') });

        session.update(input({ song: NETEASE, audioSrc: 'https://x' }));
        await flushPromises();

        expect(createSync).toHaveBeenCalledTimes(1);
    });

    it('stops Music and monitoring when disposed', () => {
        carrier.readyState = 1;
        session.update(input());

        session.dispose();

        expect(latest().sync.dispose).toHaveBeenCalledWith({ stopEngine: true });
        expect(engine.setMonitoring).toHaveBeenLastCalledWith(false);
    });
});

describe('routeExternalPlaybackIssue', () => {
    const route = (playerState: PlayerState) => {
        const target: ExternalPlaybackIssueRoute & {
            setPaused: Mock<() => void>;
            showStatus: Mock<(type: 'info' | 'error', key: string) => void>;
            onPlaybackFailure: Mock<() => void>;
        } = { playerState, setPaused: vi.fn(), showStatus: vi.fn(), onPlaybackFailure: vi.fn() };
        return target;
    };

    it('reports a takeover without touching playback', () => {
        const trackChanged = route(PlayerState.PLAYING);
        routeExternalPlaybackIssue({ kind: 'takeover', reason: 'track-changed' }, trackChanged);
        expect(trackChanged.showStatus).toHaveBeenCalledWith('info', 'appleMusic.takeover');

        const engineStopped = route(PlayerState.PLAYING);
        routeExternalPlaybackIssue({ kind: 'takeover', reason: 'engine-stopped' }, engineStopped);
        expect(engineStopped.showStatus).toHaveBeenCalledWith('info', 'appleMusic.engineStopped');

        for (const target of [trackChanged, engineStopped]) {
            expect(target.setPaused).not.toHaveBeenCalled();
            expect(target.onPlaybackFailure).not.toHaveBeenCalled();
        }
    });

    it('pauses with the permission hint and does not skip when Automation access is denied', () => {
        const target = route(PlayerState.PLAYING);

        routeExternalPlaybackIssue({
            kind: 'failure',
            error: new OnlineProviderError('auth-required', 'denied', 'apple-music'),
        }, target);

        expect(target.setPaused).toHaveBeenCalledTimes(1);
        expect(target.showStatus).toHaveBeenCalledWith('error', 'appleMusic.permissionDenied');
        expect(target.onPlaybackFailure).not.toHaveBeenCalled();
    });

    it('stays paused without skipping when a failure arrives after the listener paused', () => {
        const target = route(PlayerState.PAUSED);

        routeExternalPlaybackIssue({
            kind: 'failure',
            error: new OnlineProviderError('not-playable', 'Music did not become audible within 8 s', 'apple-music'),
        }, target);

        expect(target.setPaused).toHaveBeenCalledTimes(1);
        expect(target.showStatus).not.toHaveBeenCalled();
        expect(target.onPlaybackFailure).not.toHaveBeenCalled();
    });

    it('reports and skips any other failure while playing', () => {
        const target = route(PlayerState.PLAYING);

        routeExternalPlaybackIssue({
            kind: 'failure',
            error: new OnlineProviderError('not-playable', 'Music did not become audible within 8 s', 'apple-music'),
        }, target);

        expect(target.showStatus).toHaveBeenCalledWith('error', 'appleMusic.playFailed');
        expect(target.onPlaybackFailure).toHaveBeenCalledTimes(1);
        expect(target.setPaused).not.toHaveBeenCalled();
    });
});
