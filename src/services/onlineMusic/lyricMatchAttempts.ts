import type { SongResult } from '../../types';
import type { ProviderLyricsResult } from '../../types/onlineMusic';
import { getProviderSongMetadata } from './songMetadata';

// src/services/onlineMusic/lyricMatchAttempts.ts

export type LyricMatchHints = NonNullable<ProviderLyricsResult['matchHints']>;

export interface LyricMatchAttempt {
    title: string;
    artist: string;
    album?: string;
    durationMs: number;
}

// Lists the name sets an automatic lyric search should try for a song, in order: the provider's hinted names
// (a hint the provider does not give is filled from the song) and then the song's own names. One set when there are no hints or they add nothing.
export function buildLyricMatchAttempts(song: SongResult, matchHints?: LyricMatchHints | null): LyricMatchAttempt[] {
    const metadata = getProviderSongMetadata(song);
    const original: LyricMatchAttempt = {
        title: song.name,
        artist: metadata.artists.map(artist => artist.name).filter(Boolean).join(', '),
        album: metadata.album?.name,
        durationMs: metadata.durationMs,
    };
    if (!matchHints) return [original];
    const hinted: LyricMatchAttempt = {
        title: matchHints.title?.trim() || original.title,
        artist: matchHints.artist?.trim() || original.artist,
        album: matchHints.album?.trim() || original.album,
        durationMs: original.durationMs,
    };
    const sameAsOriginal = hinted.title === original.title && hinted.artist === original.artist && hinted.album === original.album;
    return sameAsOriginal ? [original] : [hinted, original];
}

// Runs the attempts one after another and stops at the first answer the caller accepts.
// With none accepted, the first answer that is not null is kept (an instrumental verdict, for one); a failed attempt only ends the search when it is the last.
export async function runLyricMatchAttempts<T>(
    attempts: LyricMatchAttempt[],
    run: (attempt: LyricMatchAttempt) => Promise<T | null>,
    isAccepted: (answer: T) => boolean,
): Promise<T | null> {
    let fallback: T | null = null;
    for (let index = 0; index < attempts.length; index += 1) {
        let answer: T | null;
        try {
            answer = await run(attempts[index]);
        } catch (error) {
            if (index === attempts.length - 1) throw error;
            console.warn('[LyricMatch] Attempt failed; trying the next names', error);
            continue;
        }
        if (answer !== null && isAccepted(answer)) return answer;
        if (answer !== null && fallback === null) fallback = answer;
    }
    return fallback;
}
