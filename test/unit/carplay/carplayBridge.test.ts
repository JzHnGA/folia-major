import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/carplay/carplayBridge.test.ts
// The web half of Ecria on CarPlay: what it answers the car for its home list and a list's songs,
// and that playing a song plays it with the list the car showed as its queue.

const liked = { providerId: 'netease', id: '1', name: 'Liked songs', type: 'playlist', isLiked: true, trackCount: 2, coverUrl: 'https://p.example/liked.jpg' };
const mix = { providerId: 'netease', id: '2', name: 'City pop', type: 'playlist', trackCount: 1 };
const cloud = { providerId: 'netease', id: 'cloud', name: 'Cloud', type: 'cloud' };

const song = (id: string, unavailable = false) => ({
    id, name: `Song ${id}`, artists: [{ id: 'a', name: 'imase' }], album: { id: 'al', name: 'Album', coverUrl: `https://p.example/${id}.jpg` },
    durationMs: 1000, unavailable,
});

vi.mock('../../../src/i18n/config', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../../src/stores/useOnlineProviderAccountStore', () => ({
    useOnlineProviderAccountStore: { getState: () => ({ activeProviderId: 'netease', accounts: { netease: { status: 'authenticated', collections: [mix, cloud, liked] } } }) },
}));
vi.mock('../../../src/stores/usePlaybackStore', () => ({ usePlaybackStore: { getState: () => ({ currentSong: null }) } }));
vi.mock('../../../src/utils/appPlaybackGuards', () => ({ getPlaybackSongKey: (s: { id: string }) => `netease:${s.id}` }));
vi.mock('../../../src/services/onlineMusic/songAvailability', () => ({ isSongUnavailable: (s: { unavailable?: boolean }) => Boolean(s.unavailable) }));
vi.mock('../../../src/services/onlineMusic/omni', () => ({
    omni: {
        readAccount: vi.fn(),
        supportsDailySongs: () => true,
        getDailySongs: async () => [song('d1')],
        getCollectionTracks: async (collection: { id: string }) => ({
            items: collection.id === '1' ? [song('s1'), song('s2', true)] : [song('m1')], hasMore: false, nextOffset: 0,
        }),
    },
}));

type Listener = (request: { requestId: string; kind: string; params?: Record<string, unknown> }) => void;
let listener: Listener | null = null;
const respond = vi.fn<(options: unknown) => Promise<undefined>>(async () => undefined);
const ready = vi.fn(async () => undefined);
(globalThis as unknown as { window: unknown }).window = {
    Capacitor: { Plugins: { EcriaCarPlay: {
        addListener: async (_event: string, fn: Listener) => { listener = fn; return { remove: async () => undefined }; },
        ready, respond,
    } } },
};

const { installCarPlayBridge } = await import('../../../src/services/carplay/carplayBridge');
const { registerCarPlayPlayback } = await import('../../../src/services/carplay/carplayPlayback');

const ask = async (kind: string, params: Record<string, unknown> = {}) => {
    respond.mockClear();
    listener!({ requestId: kind, kind, params });
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    return respond.mock.calls[0][0] as unknown as { ok: boolean; data?: Record<string, unknown>; error?: string };
};

describe('CarPlay bridge', () => {
    beforeEach(() => {
        if (!listener) installCarPlayBridge();
    });

    it('says it is ready once it listens', async () => {
        await vi.waitFor(() => expect(ready).toHaveBeenCalled());
    });

    it('lists the daily songs, then the playlists with liked songs first and the cloud drive left out', async () => {
        const answer = await ask('home');
        const sections = answer.data!.sections as { title: string; items: { id: string; title: string }[] }[];
        expect(sections.map(section => section.title)).toEqual(['carplay.forYou', 'carplay.playlists']);
        expect(sections[1].items.map(item => item.id)).toEqual(['playlist:1', 'playlist:2']);
    });

    it('gives a list its songs, unavailable ones marked', async () => {
        const answer = await ask('tracks', { collectionId: 'playlist:1' });
        expect(answer.data!.tracks).toEqual([
            expect.objectContaining({ key: 'netease:s1', title: 'Song s1', subtitle: 'imase', unavailable: false }),
            expect.objectContaining({ key: 'netease:s2', unavailable: true }),
        ]);
    });

    it('plays a song with the list the car showed as its queue', async () => {
        const playSong = vi.fn();
        const unregister = registerCarPlayPlayback({ playSong });
        await ask('tracks', { collectionId: 'playlist:1' });
        const answer = await ask('play', { collectionId: 'playlist:1', trackKey: 'netease:s1' });
        expect(answer.ok).toBe(true);
        expect(playSong).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), [expect.objectContaining({ id: 's1' }), expect.objectContaining({ id: 's2' })]);
        unregister();
    });

    it('fails a play when nothing is registered to play', async () => {
        await ask('tracks', { collectionId: 'playlist:2' });
        const answer = await ask('play', { collectionId: 'playlist:2', trackKey: 'netease:m1' });
        expect(answer).toMatchObject({ ok: false });
    });
});
