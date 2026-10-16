import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import i18n from '../i18n/config';
import type { AutomixDeckId } from '../services/automix/automixSession';
import {
    ExternalPlaybackSession,
    routeExternalPlaybackIssue,
    type ExternalPlaybackTransition,
} from '../services/externalPlayback/externalPlaybackSession';
import type { DeckGainEnvelope } from '../services/gainEnvelope';
import { omni } from '../services/onlineMusic/omni';
import { registerPlaybackFadeEnvelopeListener } from '../services/playbackFade';
import { setPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { PlayerState } from '../types';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';

// src/hooks/useExternalPlaybackSync.ts
// Connects the external playback session (Apple Music songs played by Music.app) to the active deck's carrier
// <audio> and the playback store. The session does the work; this only feeds it and turns its issues into toasts.

const DECK_IDS = ['A', 'B'] as const;

type UseExternalPlaybackSyncParams = {
    audioRef: RefObject<HTMLAudioElement | null>;
    shouldAutoPlayRef: MutableRefObject<boolean>;
    /** Re-reads `audioRef` when automix makes the other deck the active one. */
    activeDeck: string;
    /** The audio bridge's autoplay gate: an autoplayed Apple song does not start Music before its lyrics are in. */
    isLyricsLoading: boolean;
    /** The queue's failure skip (skipAfterPlaybackFailure). */
    onPlaybackFailure: () => void;
    /** The clock Automix's envelopes are written on; the volume mirror reads them on it. */
    audioContextRef: RefObject<AudioContext | null>;
    /** Automix's two decks and the source each one renders in this render; the session binds a song by its carrier. */
    decks: { getElement(deck: AutomixDeckId): HTMLAudioElement | null; deckSrc(deck: AutomixDeckId): string | undefined };
    /** Automix's transition from arm to settle: who fades out on which deck, and who arrives on which. */
    transition: ExternalPlaybackTransition | null;
    /** Makes Automix's blend a hard cut, for an arriving Apple song whose Music start came too late. */
    cutTransition: () => void;
};

export function useExternalPlaybackSync({
    audioRef,
    shouldAutoPlayRef,
    activeDeck,
    isLyricsLoading,
    onPlaybackFailure,
    audioContextRef,
    decks,
    transition,
    cutTransition,
}: UseExternalPlaybackSyncParams): {
    autoplayHeld: boolean;
    mirrorVolume: (volume: number) => void;
    handleDeckEnvelope: (deck: AutomixDeckId, envelope: DeckGainEnvelope) => void;
} {
    const currentSong = usePlaybackStore(state => state.currentSong);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const playerState = usePlaybackStore(state => state.playerState);
    // Taken apart so the effect below depends on the two functions, not on the object App builds every render.
    const { getElement: getDeckElement, deckSrc } = decks;

    // The session outlives every render, so it reaches the latest skip through a ref.
    const onPlaybackFailureRef = useRef(onPlaybackFailure);
    onPlaybackFailureRef.current = onPlaybackFailure;
    // The same for the cut: App hands over a fresh closure every render.
    const cutTransitionRef = useRef(cutTransition);
    cutTransitionRef.current = cutTransition;

    const [session] = useState(() => new ExternalPlaybackSession({
        isExternal: song => omni.isExternalPlaybackSong(song),
        getEngine: song => omni.getExternalPlaybackEngine(song),
        clearAutoplayIntent: () => { shouldAutoPlayRef.current = false; },
        setPaused: () => setPlayerState(PlayerState.PAUSED),
        onIssue: issue => routeExternalPlaybackIssue(issue, {
            playerState: usePlaybackStore.getState().playerState,
            setPaused: () => setPlayerState(PlayerState.PAUSED),
            showStatus: (type, key) => setStatusMessage({ type, text: i18n.t(key) }),
            onPlaybackFailure: () => onPlaybackFailureRef.current(),
        }),
        cutTransition: () => cutTransitionRef.current(),
        audioNow: () => audioContextRef.current?.currentTime ?? null,
    }));

    // Re-renders when the hold is released, so the audio bridge sees it lift.
    useSyncExternalStore(session.subscribe, session.getVersion);

    // `deckSrc` changes identity whenever a deck's source does, and `transition` is set at the arm and cleared at
    // the settle, so the session re-binds on exactly the renders that move a song between decks.
    useEffect(() => {
        session.update({
            song: currentSong,
            audioSrc,
            carrier: audioRef.current,
            playerState,
            wantsAutoplay: shouldAutoPlayRef.current,
            isLyricsLoading,
            decks: DECK_IDS.map(id => ({ id, element: getDeckElement(id), src: deckSrc(id) ?? null })),
            transition,
        });
    }, [
        currentSong, audioSrc, playerState, activeDeck, isLyricsLoading, audioRef, session, shouldAutoPlayRef,
        getDeckElement, deckSrc, transition,
    ]);

    // The pause fade has one listener app-wide, and it is this session's for as long as the session is mounted.
    // Bound here: the session's handlers are methods, and the fade calls its listener bare.
    useEffect(() => {
        registerPlaybackFadeEnvelopeListener(envelope => session.handleFadeEnvelope(envelope));
        return () => registerPlaybackFadeEnvelopeListener(null);
    }, [session]);

    useEffect(() => () => session.dispose(), [session]);

    const handleDeckEnvelope = useCallback(
        (deck: AutomixDeckId, envelope: DeckGainEnvelope) => session.handleDeckEnvelope(deck, envelope),
        [session],
    );

    return {
        // Automix starts the arriving song's carrier itself, after the session's preroll has started Music.
        autoplayHeld: session.isAutoplayHeld(
            currentSong,
            audioSrc,
            transition ? getPlaybackSongKey(transition.incoming.song) : null,
        ),
        mirrorVolume: session.mirrorVolume,
        handleDeckEnvelope,
    };
}
