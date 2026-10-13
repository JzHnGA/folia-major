import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useExternalPlaybackSync } from '@/hooks/useExternalPlaybackSync';
import type { AutomixDeckId } from '@/services/automix/automixSession';
import type {
    ExternalPlaybackSessionDeps,
    ExternalPlaybackSessionInput,
    ExternalPlaybackTransition,
} from '@/services/externalPlayback/externalPlaybackSession';
import type { DeckGainEnvelope } from '@/services/gainEnvelope';
import { PlayerState, type SongResult } from '@/types';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';

// test/unit/hooks/useExternalPlaybackSync.test.ts
// The hook's wiring only: what it feeds the external playback session, how it reaches the latest props, and that
// the pause fade's envelopes reach the session while it is mounted. The session itself is a recording fake.

// A React stand-in that keeps hook slots across renders (by call order, like React), so a second render sees the
// session and refs the first one made. Effects are collected per render and run by the test.
const react = vi.hoisted(() => {
    const slots: unknown[] = [];
    let cursor = 0;
    const effects: Array<() => unknown> = [];
    const slot = <T>(init: () => T): T => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = init();
        return slots[index] as T;
    };
    return {
        effects,
        beginRender: () => { cursor = 0; effects.length = 0; },
        reset: () => { slots.length = 0; cursor = 0; effects.length = 0; },
        slot,
    };
});

const mocks = vi.hoisted(() => ({
    sessions: [] as Array<{
        deps: ExternalPlaybackSessionDeps;
        updates: ExternalPlaybackSessionInput[];
        heldArgs: unknown[][];
        deckEnvelopes: Array<[AutomixDeckId, DeckGainEnvelope]>;
        fadeEnvelopes: DeckGainEnvelope[];
    }>,
    registerFade: vi.fn(),
    store: { currentSong: null as SongResult | null, audioSrc: null as string | null, playerState: 'IDLE' as unknown },
}));

vi.mock('react', () => ({
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => react.slot(() => ({ current })),
    useState: (init: unknown) => [react.slot(() => (typeof init === 'function' ? (init as () => unknown)() : init)), () => undefined],
    useEffect: (effect: () => unknown) => { react.effects.push(effect); },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

// Prototype methods that read `this`, so a handler passed on unbound fails here as it would on the real session.
vi.mock('@/services/externalPlayback/externalPlaybackSession', () => ({
    ExternalPlaybackSession: class {
        deps: ExternalPlaybackSessionDeps;
        updates: ExternalPlaybackSessionInput[] = [];
        heldArgs: unknown[][] = [];
        deckEnvelopes: Array<[AutomixDeckId, DeckGainEnvelope]> = [];
        fadeEnvelopes: DeckGainEnvelope[] = [];
        constructor(deps: ExternalPlaybackSessionDeps) {
            this.deps = deps;
            mocks.sessions.push(this);
        }
        update(input: ExternalPlaybackSessionInput) { this.updates.push(input); }
        isAutoplayHeld(...args: unknown[]) {
            this.heldArgs.push(args);
            return false;
        }
        readonly subscribe = () => () => undefined;
        readonly getVersion = () => 0;
        readonly mirrorVolume = () => undefined;
        handleDeckEnvelope(deck: AutomixDeckId, envelope: DeckGainEnvelope) { this.deckEnvelopes.push([deck, envelope]); }
        handleFadeEnvelope(envelope: DeckGainEnvelope) { this.fadeEnvelopes.push(envelope); }
        dispose() { /* nothing to let go of */ }
    },
    routeExternalPlaybackIssue: vi.fn(),
}));
vi.mock('@/services/playbackFade', () => ({ registerPlaybackFadeEnvelopeListener: mocks.registerFade }));
vi.mock('@/services/onlineMusic/omni', () => ({
    omni: { isExternalPlaybackSong: vi.fn(() => true), getExternalPlaybackEngine: vi.fn(() => null) },
}));
vi.mock('@/stores/usePlaybackStore', () => ({
    usePlaybackStore: Object.assign(
        (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
        { getState: () => mocks.store },
    ),
    setPlayerState: vi.fn(),
}));
vi.mock('@/stores/useStatusMessageStore', () => ({ setStatusMessage: vi.fn() }));
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }));

type HookParams = Parameters<typeof useExternalPlaybackSync>[0];

const appleSong = (mediaId: string): SongResult => ({
    id: `apple-music:${mediaId}`,
    name: `Track ${mediaId}`,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: { id: 'album', name: 'Album' },
    durationMs: 200_000,
    sourceRef: { kind: 'online', providerId: 'apple-music', mediaId },
});
const NETEASE: SongResult = {
    id: 42,
    name: 'Netease track',
    artists: [{ id: 1, name: 'Artist' }],
    album: { id: 2, name: 'Album' },
    durationMs: 180_000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '42' },
};
const APPLE = appleSong('0123456789ABCDEF');

const elA = { id: 'deck-a' } as unknown as HTMLAudioElement;
const elB = { id: 'deck-b' } as unknown as HTMLAudioElement;
const elements: Record<AutomixDeckId, HTMLAudioElement> = { A: elA, B: elB };

// NetEase fading out on A while the Apple song arrives on B.
const inTo: ExternalPlaybackTransition = {
    tail: { deck: 'A', song: NETEASE },
    incoming: { deck: 'B', song: APPLE },
};

const params = (overrides: Partial<HookParams> = {}): HookParams => ({
    audioRef: { current: elA },
    shouldAutoPlayRef: { current: false },
    activeDeck: 'A',
    isLyricsLoading: false,
    onPlaybackFailure: vi.fn(),
    audioContextRef: { current: null },
    decks: { getElement: deck => elements[deck], deckSrc: () => undefined },
    transition: null,
    cutTransition: vi.fn(),
    ...overrides,
});

const render = (props: HookParams) => {
    react.beginRender();
    return useExternalPlaybackSync(props);
};

// Runs the last render's effects the way React would on commit, and returns their combined cleanup.
const runEffects = () => {
    const cleanups = [...react.effects].map(effect => effect());
    return () => cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
};

const session = () => mocks.sessions[mocks.sessions.length - 1];

const envelope = (value: number): DeckGainEnvelope => ({ startAt: 1, seconds: 0.2, points: [value] });

describe('useExternalPlaybackSync', () => {
    beforeEach(() => {
        react.reset();
        mocks.sessions.length = 0;
        mocks.registerFade.mockReset();
        mocks.store.currentSong = APPLE;
        mocks.store.audioSrc = 'blob:b';
        mocks.store.playerState = PlayerState.PLAYING;
    });

    it('feeds the session both decks by the source each renders, and the transition songs', () => {
        render(params({
            activeDeck: 'B',
            decks: { getElement: deck => elements[deck], deckSrc: deck => (deck === 'A' ? 'blob:a' : undefined) },
            transition: inTo,
        }));
        runEffects();

        expect(session().updates).toHaveLength(1);
        expect(session().updates[0].decks).toEqual([
            { id: 'A', element: elA, src: 'blob:a' },
            { id: 'B', element: elB, src: null },
        ]);
        expect(session().updates[0].transition).toBe(inTo);
        expect(session().updates[0]).toMatchObject({ song: APPLE, audioSrc: 'blob:b', playerState: PlayerState.PLAYING });
    });

    it('does not hold the song a transition is bringing in', () => {
        render(params({ transition: inTo }));
        expect(session().heldArgs.at(-1)).toEqual([APPLE, 'blob:b', getPlaybackSongKey(APPLE)]);

        render(params({ transition: null }));
        expect(session().heldArgs.at(-1)).toEqual([APPLE, 'blob:b', null]);
    });

    it('routes pause-fade envelopes to the session while mounted', () => {
        render(params());
        const unmount = runEffects();

        expect(mocks.registerFade).toHaveBeenCalledTimes(1);
        const listener = mocks.registerFade.mock.calls[0][0] as (envelope: DeckGainEnvelope) => void;
        expect(listener).toBeTypeOf('function');
        const fade = envelope(0);
        listener(fade);
        expect(session().fadeEnvelopes).toEqual([fade]);

        unmount();
        expect(mocks.registerFade).toHaveBeenLastCalledWith(null);
    });

    it('reads the audio clock and the cut through the latest props', () => {
        const audioContextRef: HookParams['audioContextRef'] = { current: null };
        const firstCut = vi.fn();
        const latestCut = vi.fn();
        render(params({ audioContextRef, cutTransition: firstCut }));
        const { deps } = session();

        expect(deps.audioNow?.()).toBeNull();
        audioContextRef.current = { currentTime: 12.5 } as AudioContext;
        expect(deps.audioNow?.()).toBe(12.5);

        render(params({ audioContextRef, cutTransition: latestCut }));
        expect(mocks.sessions).toHaveLength(1);
        deps.cutTransition?.();
        expect(latestCut).toHaveBeenCalledTimes(1);
        expect(firstCut).not.toHaveBeenCalled();
    });

    it('hands deck envelopes to the session', () => {
        const { handleDeckEnvelope } = render(params());
        const gain = envelope(0.5);
        handleDeckEnvelope('B', gain);
        expect(session().deckEnvelopes).toEqual([['B', gain]]);
    });
});
