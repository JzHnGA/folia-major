import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// test/unit/electron/appleMusicScript.test.ts — runs the embedded JXA handlers against a stubbed Music application.

const require = createRequire(import.meta.url);
const { MUSIC_APP_JXA_SOURCE } = require('../../../electron/appleMusic/musicAppScript.cjs');

type Kind = 'song' | 'music video';
const hit = (id: string, kind: Kind) => ({
    persistentID: () => id, name: () => `name ${id}`, artist: () => 'artist', albumArtist: () => 'album artist',
    album: () => 'album', duration: () => 100, mediaKind: () => kind,
});

// Evaluates the script in a context where only the JXA globals it touches exist, then returns its handler table.
function loadHandlers(hits: ReturnType<typeof hit>[] | null) {
    const application = { running: () => true, libraryPlaylists: [{}], search: () => hits };
    const context = vm.createContext({ ObjC: { import: () => undefined }, $: {}, Application: () => application });
    vm.runInContext(MUSIC_APP_JXA_SOURCE, context);
    return vm.runInContext('handlers', context) as { searchLibrary: (args: { query: string; limit: number }) => Array<{ id: string; mediaKind: string }> };
}

describe('Music app script searchLibrary', () => {
    const mixed = [hit('V1', 'music video'), hit('V2', 'music video'), hit('S1', 'song'), hit('V3', 'music video'), hit('S2', 'song'), hit('S3', 'song')];

    it('skips non-songs without letting them use up the limit', () => {
        const result = loadHandlers(mixed).searchLibrary({ query: 'q', limit: 2 });
        expect(result.map(track => track.id)).toEqual(['S1', 'S2']);
        expect(result.every(track => track.mediaKind === 'song')).toBe(true);
    });

    it('returns every song when fewer than the limit exist, and nothing for no hits', () => {
        expect(loadHandlers(mixed).searchLibrary({ query: 'q', limit: 10 }).map(track => track.id)).toEqual(['S1', 'S2', 'S3']);
        expect(loadHandlers(null).searchLibrary({ query: 'q', limit: 10 })).toEqual([]);
    });

    it('stops reading hits once the limit is reached', () => {
        const reads: string[] = [];
        const counted = ['S1', 'S2', 'S3'].map(id => ({ ...hit(id, 'song'), persistentID: () => { reads.push(id); return id; } }));
        loadHandlers(counted).searchLibrary({ query: 'q', limit: 2 });
        expect(reads).toEqual(['S1', 'S2']);
    });
});
