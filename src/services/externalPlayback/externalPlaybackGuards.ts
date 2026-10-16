import type { SongResult } from '../../types';
import { omni } from '../onlineMusic/omni';

// src/services/externalPlayback/externalPlaybackGuards.ts
// The one check Automix, prefetch and export make before touching a song's audio: an external
// engine plays the real sound, and Folia's own <audio> only carries a silent WAV for the clock.

// True when any of the songs is played by an external engine (Music.app), not by the <audio> element.
export const involvesExternalPlayback = (...songs: Array<SongResult | null | undefined>): boolean => (
    songs.some(song => omni.isExternalPlaybackSong(song))
);

// Which side of a song change an external engine plays: 'both' when it plays both songs, null when it plays neither.
// Automix blends a change with exactly one external side and hard-cuts 'both', since Music.app plays one song at a time.
export const externalSideOf = (
    from: SongResult | null | undefined,
    to: SongResult | null | undefined,
): 'from' | 'to' | 'both' | null => {
    const fromExternal = omni.isExternalPlaybackSong(from);
    const toExternal = omni.isExternalPlaybackSong(to);
    if (fromExternal && toExternal) return 'both';
    if (fromExternal) return 'from';
    return toExternal ? 'to' : null;
};
