import { describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        isExternalPlaybackSong: (song: SongResult | null | undefined) => (
            song?.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'apple-music'
        ),
    },
}));

import { involvesExternalPlayback } from '@/services/externalPlayback/externalPlaybackGuards';

// test/unit/externalPlayback/externalPlaybackGuards.test.ts
// involvesExternalPlayback: the one question Automix, prefetch and export ask before touching a song's audio.

const makeSong = (providerId: string): SongResult => ({
    id: `${providerId}-song`,
    name: 'Song',
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId, mediaId: `${providerId}-song` },
} as SongResult);

const neteaseSong = makeSong('netease');
const appleSong = makeSong('apple-music');

describe('involvesExternalPlayback', () => {
    it('is true when any of the songs plays through an external engine', () => {
        expect(involvesExternalPlayback(neteaseSong, appleSong)).toBe(true);
        expect(involvesExternalPlayback(appleSong, neteaseSong)).toBe(true);
        expect(involvesExternalPlayback(neteaseSong, null, undefined)).toBe(false);
    });

    it('is false for no songs at all', () => {
        expect(involvesExternalPlayback()).toBe(false);
        expect(involvesExternalPlayback(null, undefined)).toBe(false);
    });
});
