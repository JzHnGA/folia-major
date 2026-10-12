import type { SongResult } from '../../types';
import { omni } from '../onlineMusic/omni';

// src/services/externalPlayback/externalPlaybackGuards.ts
// The one check Automix, prefetch and export make before touching a song's audio: an external
// engine plays the real sound, and Folia's own <audio> only carries a silent WAV for the clock.

// True when any of the songs is played by an external engine (Music.app), not by the <audio> element.
export const involvesExternalPlayback = (...songs: Array<SongResult | null | undefined>): boolean => (
    songs.some(song => omni.isExternalPlaybackSong(song))
);
