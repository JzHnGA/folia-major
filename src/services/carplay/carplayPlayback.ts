import type { SongResult } from '../../types';

// src/services/carplay/carplayPlayback.ts
// How the CarPlay bridge starts a song. The play function lives in App's playback controller (a React
// callback), so App registers it here while it is mounted; the bridge, which runs outside React,
// reads it when the car asks for a song.

export type CarPlayPlayback = {
    /** Plays `song` with `queue` as the queue, without leaving the screen the phone shows. */
    playSong: (song: SongResult, queue: SongResult[]) => void;
};

let registered: CarPlayPlayback | null = null;

/** Called by App with its playback; returns the function that takes it back. */
export const registerCarPlayPlayback = (playback: CarPlayPlayback): (() => void) => {
    registered = playback;
    return () => {
        if (registered === playback) registered = null;
    };
};

export const getCarPlayPlayback = (): CarPlayPlayback | null => registered;
