import type { SongResult } from '../../types';
import type { ProviderLyricMatchHints } from '../../types/onlineMusic';
import { normalizeLyricMatchText } from '../../utils/lyrics/matchScore';
import { getProviderSongMetadata } from './songMetadata';

// src/services/onlineMusic/lyricMatchAttempts.ts

export interface LyricMatchAttempt {
    title: string;
    artist: string;
    album?: string;
    durationMs: number;
}

// Lists the name sets an automatic lyric search should try for a song, in order: the provider's hinted names
// (a hint the provider does not give is filled from the song) and then the song's own names.
// Hints whose title and artist read the same as the song's once normalized (traditional vs simplified, case, punctuation) add no new search:
// one attempt remains, which takes the hinted album when there is one.
export function buildLyricMatchAttempts(song: SongResult, matchHints?: ProviderLyricMatchHints | null): LyricMatchAttempt[] {
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
    const sameSearch = normalizeLyricMatchText(hinted.title) === normalizeLyricMatchText(original.title)
        && normalizeLyricMatchText(hinted.artist) === normalizeLyricMatchText(original.artist);
    return sameSearch ? [{ ...original, album: hinted.album }] : [hinted, original];
}

// Runs the attempts one after another and stops at the first answer the caller accepts, or at one the caller calls final
// (an instrumental verdict reached by the first names needs no second opinion from the weaker ones).
// With none accepted, the first answer that is not null is kept; a failed attempt only ends the search when it is the last.
export async function runLyricMatchAttempts<T>(
    attempts: LyricMatchAttempt[],
    run: (attempt: LyricMatchAttempt) => Promise<T | null>,
    isAccepted: (answer: T) => boolean,
    isFinal: (answer: T) => boolean = () => false,
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
        if (answer === null) continue;
        if (isAccepted(answer) || isFinal(answer)) return answer;
        if (fallback === null) fallback = answer;
    }
    return fallback;
}
