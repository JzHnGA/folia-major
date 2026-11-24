import { describe, expect, it } from 'vitest';
import { normalizeOfficialCollection, normalizeOfficialSong, normalizeOfficialUser, officialWordLinesToYrc, toHttps } from '../../../src/services/onlineMusic/netease/official/officialNormalize';

// test/unit/onlineMusic/neteaseOfficial.test.ts
// The official OpenAPI records as the app's songs: encrypted ids kept as strings, https covers, the
// word-by-word answer as YRC text.

describe('official NetEase normalization', () => {
    const record = {
        id: '1CE4E2A5D6869390649E6FF192436A5F',
        name: '陈酒新茶令',
        duration: 243487,
        artists: [],
        fullArtists: [{ id: null, name: 'Assen捷&东篱' }],
        album: { id: '0E5E42FD4DD36BC27098853AE9BBF2CE', name: '原创作品集' },
        coverImgUrl: 'http://p1.music.126.net/x.jpg',
        playFlag: true,
        alg: 'alg_search_basic',
        visible: true,
    };

    it('keeps the encrypted id and maps the record', () => {
        const song = normalizeOfficialSong(record);
        expect(song.id).toBe('1CE4E2A5D6869390649E6FF192436A5F');
        expect(song.sourceRef).toMatchObject({ kind: 'online', providerId: 'netease', mediaId: '1CE4E2A5D6869390649E6FF192436A5F' });
        expect(song.artists.map(artist => artist.name)).toEqual(['Assen捷&东篱']);
        expect(song.album.coverUrl).toBe('https://p1.music.126.net/x.jpg');
        expect(song.durationMs).toBe(243487);
        expect(song.resourceState).toBeUndefined();
    });

    it('keeps originalId and alg in providerData and marks unplayable songs', () => {
        expect(normalizeOfficialSong({ ...record, playFlag: false }).resourceState).toBeUndefined();
        const song = normalizeOfficialSong({ ...record, originalId: 4132379, visible: false });
        const providerData = (song.sourceRef as { providerData?: Record<string, unknown> }).providerData;
        expect(providerData).toMatchObject({ official: true, originalId: '4132379', alg: 'alg_search_basic' });
        expect(song.resourceState).toBe(false);
    });

    it('hands a normalized song back unchanged', () => {
        const song = normalizeOfficialSong(record);
        expect(normalizeOfficialSong(song)).toBe(song);
    });

    it('rewrites only http to https', () => {
        expect(toHttps('http://iot202.music.126.net/a.mp3')).toBe('https://iot202.music.126.net/a.mp3');
        expect(toHttps('https://a/b')).toBe('https://a/b');
        expect(toHttps(null)).toBeUndefined();
    });

    it('maps the profile', () => {
        expect(normalizeOfficialUser({ id: 'ED04', nickname: 'n', avatarUrl: 'http://p1/a.jpg', vipDetail: [{ type: 6 }] }))
            .toEqual({ id: 'ED04', nickname: 'n', avatarUrl: 'https://p1/a.jpg', vipType: 11 });
    });

    it('writes the word-by-word lines as YRC', () => {
        const yrc = officialWordLinesToYrc([
            { start: 1000, duration: 2000, words: [{ suspend: 1000, duration: 500, words: '你(' }, { suspend: 1500, duration: 1500, words: '好' }] },
            { start: 3000, duration: 0, words: [] },
        ]);
        expect(yrc).toBe('[1000,2000](1000,500,0)你（(1500,1500,0)好');
        expect(officialWordLinesToYrc([])).toBeNull();
        expect(officialWordLinesToYrc(undefined)).toBeNull();
    });

    it('maps playlists, the liked playlist and albums', () => {
        const owned = normalizeOfficialCollection({ id: '1A99', name: '老歌', coverImgUrl: 'http://p1/c.jpg', creatorNickName: 'me', trackCount: 3, specialType: 0 }, 'playlist', { isOwned: true });
        expect(owned).toMatchObject({ providerId: 'netease', id: '1A99', type: 'playlist', coverUrl: 'https://p1/c.jpg', trackCount: 3, isOwned: true });
        expect(owned.isLiked).toBeUndefined();
        expect(normalizeOfficialCollection({ id: '3C80', name: '喜欢的音乐', specialType: 5, trackCount: 214 }).isLiked).toBe(true);
        const album = normalizeOfficialCollection({ id: '7C11', name: '万有引力', artists: [{ id: 'C158', name: '汪苏泷' }], publishTime: 1645974328526, company: 'X' }, 'album');
        expect(album).toMatchObject({ type: 'album', artists: [{ id: 'C158', name: '汪苏泷' }], publishedAt: 1645974328526, publisher: 'X' });
    });
});
