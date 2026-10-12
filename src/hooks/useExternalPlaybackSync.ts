import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import i18n from '../i18n/config';
import { ExternalPlaybackSession, routeExternalPlaybackIssue } from '../services/externalPlayback/externalPlaybackSession';
import { omni } from '../services/onlineMusic/omni';
import { setPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { PlayerState } from '../types';

// src/hooks/useExternalPlaybackSync.ts
// Connects the external playback session (Apple Music songs played by Music.app) to the active deck's carrier
// <audio> and the playback store. The session does the work; this only feeds it and turns its issues into toasts.

type UseExternalPlaybackSyncParams = {
    audioRef: RefObject<HTMLAudioElement | null>;
    shouldAutoPlayRef: MutableRefObject<boolean>;
    /** Re-reads `audioRef` when automix makes the other deck the active one. */
    activeDeck: string;
    /** The queue's failure skip (skipAfterPlaybackFailure). */
    onPlaybackFailure: () => void;
};

export function useExternalPlaybackSync({
    audioRef,
    shouldAutoPlayRef,
    activeDeck,
    onPlaybackFailure,
}: UseExternalPlaybackSyncParams): { autoplayHeld: boolean; mirrorVolume: (volume: number) => void } {
    const currentSong = usePlaybackStore(state => state.currentSong);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const playerState = usePlaybackStore(state => state.playerState);

    // The session outlives every render, so it reaches the latest skip through a ref.
    const onPlaybackFailureRef = useRef(onPlaybackFailure);
    onPlaybackFailureRef.current = onPlaybackFailure;

    const [session] = useState(() => new ExternalPlaybackSession({
        isExternal: song => omni.isExternalPlaybackSong(song),
        getEngine: song => omni.getExternalPlaybackEngine(song),
        clearAutoplayIntent: () => { shouldAutoPlayRef.current = false; },
        onIssue: issue => routeExternalPlaybackIssue(issue, {
            playerState: usePlaybackStore.getState().playerState,
            setPaused: () => setPlayerState(PlayerState.PAUSED),
            showStatus: (type, key) => setStatusMessage({ type, text: i18n.t(key) }),
            onPlaybackFailure: () => onPlaybackFailureRef.current(),
        }),
    }));

    // Re-renders when the hold is released, so the audio bridge sees it lift.
    useSyncExternalStore(session.subscribe, session.getVersion);

    useEffect(() => {
        session.update({
            song: currentSong,
            audioSrc,
            carrier: audioRef.current,
            playerState,
            wantsAutoplay: shouldAutoPlayRef.current,
        });
    }, [currentSong, audioSrc, playerState, activeDeck, audioRef, session, shouldAutoPlayRef]);

    useEffect(() => () => session.dispose(), [session]);

    return {
        autoplayHeld: session.isAutoplayHeld(currentSong, audioSrc),
        mirrorVolume: session.mirrorVolume,
    };
}
