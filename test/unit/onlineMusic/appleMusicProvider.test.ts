import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppleMusicBridgeResult, AppleMusicOperation, AppleMusicPlaylistRecord, AppleMusicTrackRecord } from '@/services/onlineMusic/appleMusicTransport';
import type { UnifiedSong } from '@/types';

// test/unit/onlineMusic/appleMusicProvider.test.ts
// Drives the Apple Music provider and transport through a fake window.electron.appleMusic bridge.

const track: AppleMusicTrackRecord = {
    id: 'ABCDEF0123456789', name: '测试歌曲', artist: '测试歌手', albumArtist: '测试专辑艺人', album: '测试专辑', duration: 213.4,
};
const sibling: AppleMusicTrackRecord = { ...track, id: '0123456789ABCDEF', name: '同专辑另一首', duration: 180 };
const otherAlbum: AppleMusicTrackRecord = { ...track, id: 'FEDCBA9876543210', album: '另一张专辑' };
const assetId = `sha256:${'a'.repeat(64)}`;
const coverUrl = `folia-cover://asset/${encodeURIComponent(assetId)}?size=1024`;
const albumId = 'album:测试专辑艺人|测试专辑';

type Handler = (args?: Record<string, unknown>) => AppleMusicBridgeResult | Promise<AppleMusicBridgeResult>;
const ok = (data: unknown): AppleMusicBridgeResult => ({ ok: true, data });
const fail = (code: 'auth-required' | 'unavailable' | 'network'): AppleMusicBridgeResult => ({ ok: false, error: { code, message: `bridge ${code}` } });

let handlers: Partial<Record<AppleMusicOperation, Handler>>;
const request = vi.fn(async (op: AppleMusicOperation, args?: Record<string, unknown>): Promise<AppleMusicBridgeResult> => {
    const handler = handlers[op];
    return handler ? handler(args) : fail('unavailable');
});
const unsubscribeState = vi.fn();
const setMonitoring = vi.fn(async (_active: boolean) => undefined);
const onState = vi.fn((_listener: unknown) => unsubscribeState);

const installBridge = (platform = 'darwin') => {
    vi.stubGlobal('window', { electron: { platform, hasLocalCoverAsset: vi.fn(), appleMusic: { request, setMonitoring, onState } } });
};
const calls = (op: AppleMusicOperation) => request.mock.calls.filter(([name]) => name === op);

// Fresh module graph per test: the transport remembers permission and the provider keeps caches.
const load = async () => {
    const provider = (await import('@/services/onlineMusic/appleMusicProvider')).appleMusicProvider;
    const transport = await import('@/services/onlineMusic/appleMusicTransport');
    return { provider, transport };
};

const originalCreateObjectURL = URL.createObjectURL;

beforeEach(() => {
    vi.resetModules();
    request.mockClear();
    setMonitoring.mockClear();
    onState.mockClear();
    unsubscribeState.mockClear();
    handlers = {};
    installBridge();
    URL.createObjectURL = vi.fn(() => 'blob:apple-music-carrier');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    URL.createObjectURL = originalCreateObjectURL;
});

describe('Apple Music song normalization', () => {
    it('normalizes Music.app tracks with a stable apple-music identity', async () => {
        const { provider } = await load();
        const song = provider.normalizeSong(track);
        expect(song.sourceRef).toEqual({ kind: 'online', providerId: 'apple-music', mediaId: 'ABCDEF0123456789', providerData: { durationSec: 213.4 } });
        expect(song.durationMs).toBe(213400);
        expect(song.id).toBe('ABCDEF0123456789');
        expect(song.artists).toEqual([{ id: 'artist:测试歌手', name: '测试歌手' }]);
        expect(song.album).toMatchObject({ id: albumId, name: '测试专辑' });
        expect(song.album.coverUrl).toBeUndefined();
    });

    it('falls back to the track artist when the album artist is empty', async () => {
        const { provider } = await load();
        expect(provider.normalizeSong({ ...track, albumArtist: '' }).album.id).toBe('album:测试歌手|测试专辑');
    });

    it('uses the track artwork first, then shares it with every track of the same album', async () => {
        const { provider } = await load();
        expect(provider.normalizeSong({ ...track, artworkAssetId: assetId }).album.coverUrl).toBe(coverUrl);
        expect(provider.normalizeSong(sibling).album.coverUrl).toBe(coverUrl);
        expect(provider.normalizeSong(otherAlbum).album.coverUrl).toBeUndefined();
    });

    it('fills the cover from the album map when reading song metadata', async () => {
        const { provider } = await load();
        const bare = provider.normalizeSong(track);
        expect(provider.songMetadata!.getSongMetadata(bare).coverUrl).toBeUndefined();
        provider.normalizeSong({ ...sibling, artworkAssetId: assetId });
        const metadata = provider.songMetadata!.getSongMetadata(bare);
        expect(metadata.coverUrl).toBe(coverUrl);
        expect(metadata.album.coverUrl).toBe(coverUrl);
        expect(metadata.durationMs).toBe(213400);
    });

    it('declares exactly the capabilities the Music app can serve', async () => {
        const { provider } = await load();
        expect(provider.capabilities).toMatchObject({
            search: true, playback: true, lyrics: true, auth: true, userLibrary: true, playlists: true, externalPlayback: true,
            albums: false, artists: false, recommendations: false, mutations: false, wordByWordLyrics: false,
        });
        expect(provider.auth?.getQrKey).toBeUndefined();
        expect(provider.auth?.createQr).toBeUndefined();
        expect(provider.auth?.checkQr).toBeUndefined();
    });
});

describe('Apple Music library and catalog', () => {
    const records: AppleMusicPlaylistRecord[] = [
        { id: '1111111111111111', name: '我的歌单', kind: 'user' },
        { id: 'library', name: '', kind: 'library' },
        { id: '2222222222222222', name: '智能歌单', kind: 'smart' },
    ];

    it('lists the whole library first under its own name, then user and smart playlists', async () => {
        const { provider } = await load();
        handlers.listPlaylists = () => ok(records);
        const page = await provider.library!.getUserPlaylists('local', 10, 0);
        expect(page.items).toEqual([
            { providerId: 'apple-music', id: 'library', name: '资料库全部歌曲', type: 'playlist', isOwned: true, providerData: { kind: 'library' } },
            { providerId: 'apple-music', id: '1111111111111111', name: '我的歌单', type: 'playlist', isOwned: true, providerData: { kind: 'user' } },
            { providerId: 'apple-music', id: '2222222222222222', name: '智能歌单', type: 'playlist', isOwned: true, providerData: { kind: 'smart' } },
        ]);
        expect(page).toMatchObject({ total: 3, hasMore: false, nextOffset: 3 });
    });

    it('slices playlists by offset and limit', async () => {
        const { provider } = await load();
        handlers.listPlaylists = () => ok(records);
        const page = await provider.library!.getUserPlaylists('local', 1, 1);
        expect(page.items.map(item => item.id)).toEqual(['1111111111111111']);
        expect(page).toMatchObject({ total: 3, hasMore: true, nextOffset: 2 });
    });

    it('pages playlist tracks from one cached bridge call', async () => {
        const { provider } = await load();
        const library = Array.from({ length: 5 }, (_, index) => ({ ...track, id: `000000000000000${index}` }));
        handlers.getPlaylistTracks = () => ok(library);
        const first = await provider.catalog!.getPlaylistTracks!('library', 2, 0);
        const second = await provider.catalog!.getPlaylistTracks!('library', 2, 2);
        const last = await provider.catalog!.getPlaylistTracks!('library', 2, 4);
        expect(calls('getPlaylistTracks')).toEqual([['getPlaylistTracks', { playlistId: 'library' }]]);
        expect(first.items.map(song => song.id)).toEqual(['0000000000000000', '0000000000000001']);
        expect(second.items.map(song => song.id)).toEqual(['0000000000000002', '0000000000000003']);
        expect(first).toMatchObject({ total: 5, hasMore: true, nextOffset: 2 });
        expect(second).toMatchObject({ total: 5, hasMore: true, nextOffset: 4 });
        expect(last).toMatchObject({ total: 5, hasMore: false, nextOffset: 5 });
        expect(last.items).toHaveLength(1);
    });

    it('shares one bridge call between concurrent page requests and reloads after 60 seconds', async () => {
        const { provider } = await load();
        vi.useFakeTimers();
        handlers.getPlaylistTracks = () => ok([track]);
        await Promise.all([
            provider.catalog!.getPlaylistTracks!('library', 1, 0),
            provider.catalog!.getPlaylistTracks!('library', 1, 1),
        ]);
        expect(calls('getPlaylistTracks')).toHaveLength(1);
        vi.advanceTimersByTime(59_000);
        await provider.catalog!.getPlaylistTracks!('library', 1, 0);
        expect(calls('getPlaylistTracks')).toHaveLength(1);
        vi.advanceTimersByTime(2_000);
        await provider.catalog!.getPlaylistTracks!('library', 1, 0);
        expect(calls('getPlaylistTracks')).toHaveLength(2);
    });

    it('does not cache a failed playlist read', async () => {
        const { provider } = await load();
        handlers.getPlaylistTracks = () => fail('network');
        await expect(provider.catalog!.getPlaylistTracks!('library', 1, 0)).rejects.toMatchObject({ code: 'network', providerId: 'apple-music' });
        handlers.getPlaylistTracks = () => ok([track]);
        expect((await provider.catalog!.getPlaylistTracks!('library', 1, 0)).items).toHaveLength(1);
        expect(calls('getPlaylistTracks')).toHaveLength(2);
    });

    it('returns the given collection from the detail call and adds the track count once it is known', async () => {
        const { provider } = await load();
        const collection = { providerId: 'apple-music', id: 'library', name: '资料库全部歌曲', type: 'playlist' };
        expect(await provider.catalog!.getPlaylistDetail!('library')).toBeNull();
        expect(await provider.catalog!.getPlaylistDetail!('library', collection)).toEqual(collection);
        handlers.getPlaylistTracks = () => ok([track, sibling]);
        await provider.catalog!.getPlaylistTracks!('library', 10, 0);
        expect(await provider.catalog!.getPlaylistDetail!('library', collection)).toEqual({ ...collection, trackCount: 2 });
    });

    it('returns an empty page for a blank search without calling the bridge', async () => {
        const { provider } = await load();
        const page = await provider.search!.searchSongs('   ', 20, 0);
        expect(page).toEqual({ items: [], total: 0, hasMore: false, nextOffset: 0 });
        expect(request).not.toHaveBeenCalled();
    });

    it('searches with an offset-covering limit capped at 100 and slices the page', async () => {
        const { provider } = await load();
        const found = Array.from({ length: 6 }, (_, index) => ({ ...track, id: `000000000000000${index}` }));
        handlers.searchLibrary = () => ok(found);
        const page = await provider.search!.searchSongs('测试', 3, 3);
        expect(calls('searchLibrary')).toEqual([['searchLibrary', { query: '测试', limit: 6 }]]);
        expect(page.items.map(song => song.id)).toEqual(['0000000000000003', '0000000000000004', '0000000000000005']);
        expect(page).toMatchObject({ hasMore: true, nextOffset: 6 });
        await provider.search!.searchSongs('测试', 50, 80);
        expect(calls('searchLibrary')[1]).toEqual(['searchLibrary', { query: '测试', limit: 100 }]);
    });

    it('ends the search when the library returns fewer tracks than requested', async () => {
        const { provider } = await load();
        handlers.searchLibrary = () => ok([track]);
        const page = await provider.search!.searchSongs('测试', 20, 0);
        expect(page).toMatchObject({ total: 1, hasMore: false, nextOffset: 1 });
    });

    it('reads one track for the song detail', async () => {
        const { provider } = await load();
        handlers.getTrack = () => ok(track);
        const song = await provider.playback!.getSongDetail('ABCDEF0123456789');
        expect(calls('getTrack')).toEqual([['getTrack', { id: 'ABCDEF0123456789' }]]);
        expect(song?.sourceRef).toMatchObject({ providerId: 'apple-music', mediaId: 'ABCDEF0123456789' });
    });

    it('returns empty lyrics so the shared auto-match runs', async () => {
        const { provider } = await load();
        const song = provider.normalizeSong(track);
        expect(await provider.lyrics!.getLyrics(song)).toEqual({ lyrics: null, isPureMusic: false });
    });
});

describe('Apple Music silent carrier', () => {
    const urlCalls = () => (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls as [Blob][];

    it('returns a silent blob carrier without starting playback', async () => {
        const { provider } = await load();
        handlers.getArtwork = () => ok(null);
        const song = provider.normalizeSong(track);
        const source = await provider.playback!.getAudioSource(song, 'lossless');
        expect(source).toMatchObject({ url: 'blob:apple-music-carrier', quality: 'standard' });
        expect(source?.fetchedAt).toBeTypeOf('number');
        expect(urlCalls()).toHaveLength(1);
        expect(urlCalls()[0][0].size).toBe(44 + Math.ceil(213.4 * 8000));
        expect(request.mock.calls.map(([op]) => op)).not.toContain('play');
        expect(calls('getTrack')).toHaveLength(0);
    });

    it('asks the Music app for the duration when the song does not carry one', async () => {
        const { provider } = await load();
        handlers.getTrack = () => ok({ ...track, duration: 100 });
        handlers.getArtwork = () => ok(null);
        const song = { ...provider.normalizeSong(track), sourceRef: { kind: 'online', providerId: 'apple-music', mediaId: track.id } } as UnifiedSong;
        await provider.playback!.getAudioSource(song, 'standard');
        expect(calls('getTrack')).toEqual([['getTrack', { id: track.id }]]);
        expect(urlCalls()[0][0].size).toBe(44 + 100 * 8000);
    });

    it('refuses to build a carrier without a positive duration', async () => {
        const { provider } = await load();
        handlers.getTrack = () => ok({ ...track, duration: 0 });
        const song = { ...provider.normalizeSong(track), sourceRef: { kind: 'online', providerId: 'apple-music', mediaId: track.id } } as UnifiedSong;
        await expect(provider.playback!.getAudioSource(song, 'standard')).rejects.toMatchObject({ code: 'not-playable', providerId: 'apple-music' });
        const zero = { ...song, sourceRef: { ...song.sourceRef, providerData: { durationSec: 0 } } } as UnifiedSong;
        await expect(provider.playback!.getAudioSource(zero, 'standard')).rejects.toMatchObject({ code: 'not-playable' });
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('reports a carrier that is too large to build as not playable', async () => {
        const { provider } = await load();
        handlers.getArtwork = () => ok(null);
        const huge = provider.normalizeSong({ ...track, duration: 1e12 });
        await expect(provider.playback!.getAudioSource(huge, 'standard')).rejects.toMatchObject({ code: 'not-playable', providerId: 'apple-music' });
    });

    it('refuses a song of another provider', async () => {
        const { provider } = await load();
        const foreign = { ...provider.normalizeSong(track), sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' } } as UnifiedSong;
        await expect(provider.playback!.getAudioSource(foreign, 'standard')).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('treats a missing object URL as not playable', async () => {
        const { provider } = await load();
        handlers.getArtwork = () => ok(null);
        (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
        await expect(provider.playback!.getAudioSource(provider.normalizeSong(track), 'standard')).rejects.toMatchObject({ code: 'not-playable' });
    });

    it('stores the fetched artwork under the album so later songs and metadata see it', async () => {
        const { provider } = await load();
        handlers.getArtwork = () => ok({ assetId });
        const song = provider.normalizeSong(track);
        await provider.playback!.getAudioSource(song, 'standard');
        expect(calls('getArtwork')).toEqual([['getArtwork', { id: track.id }]]);
        expect(provider.songMetadata!.getSongMetadata(song).coverUrl).toBe(coverUrl);
        expect(provider.normalizeSong(sibling).album.coverUrl).toBe(coverUrl);
    });

    it('skips the artwork request when the album cover is already known', async () => {
        const { provider } = await load();
        const song = provider.normalizeSong({ ...track, artworkAssetId: assetId });
        await provider.playback!.getAudioSource(song, 'standard');
        expect(calls('getArtwork')).toHaveLength(0);
    });

    it('ignores an artwork failure', async () => {
        const { provider } = await load();
        handlers.getArtwork = () => fail('unavailable');
        const source = await provider.playback!.getAudioSource(provider.normalizeSong(track), 'standard');
        expect(source?.url).toBe('blob:apple-music-carrier');
    });

    it('stops waiting for the artwork after 1500 ms but still keeps a late result', async () => {
        const { provider } = await load();
        vi.useFakeTimers();
        let finishArtwork: (result: AppleMusicBridgeResult) => void = () => undefined;
        handlers.getArtwork = () => new Promise<AppleMusicBridgeResult>(resolve => { finishArtwork = resolve; });
        const song = provider.normalizeSong(track);
        let settled = false;
        const pending = provider.playback!.getAudioSource(song, 'standard').then(source => { settled = true; return source; });
        await vi.advanceTimersByTimeAsync(1499);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending)?.url).toBe('blob:apple-music-carrier');
        expect(provider.songMetadata!.getSongMetadata(song).coverUrl).toBeUndefined();
        finishArtwork(ok({ assetId }));
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.songMetadata!.getSongMetadata(song).coverUrl).toBe(coverUrl);
    });
});

describe('Apple Music account and availability', () => {
    it('signs in the local library from the probe without touching permissions', async () => {
        const { provider, transport } = await load();
        handlers.probe = () => ok({ running: false, permission: 'unknown' });
        expect(await provider.auth!.getLoginStatus()).toEqual({ id: 'local', nickname: '音乐资料库' });
        expect(provider.getAvailability!()).toEqual({ configured: true });
        expect(transport.getAppleMusicPermission()).toBe('unknown');
        expect(calls('probe')).toHaveLength(1);
    });

    it('returns no user once a real request was refused with auth-required', async () => {
        const { provider } = await load();
        handlers.probe = () => ok({ running: true, permission: 'unknown' });
        handlers.listPlaylists = () => fail('auth-required');
        await expect(provider.library!.getUserPlaylists('local', 10, 0)).rejects.toMatchObject({ code: 'auth-required' });
        expect(await provider.auth!.getLoginStatus()).toBeNull();
        expect(provider.getAvailability!()).toEqual({ configured: false, reason: 'not-configured' });
    });

    it('reports not-configured after the bridge answers auth-required, and recovers on the next success', async () => {
        const { provider, transport } = await load();
        handlers.getTrack = () => fail('auth-required');
        await expect(transport.requestAppleMusic('getTrack', { id: track.id })).rejects.toMatchObject({
            name: 'OnlineProviderError', code: 'auth-required', providerId: 'apple-music', message: 'bridge auth-required',
        });
        expect(transport.getAppleMusicPermission()).toBe('denied');
        expect(provider.getAvailability!()).toEqual({ configured: false, reason: 'not-configured' });
        handlers.getTrack = () => ok(track);
        await transport.requestAppleMusic('getTrack', { id: track.id });
        expect(transport.getAppleMusicPermission()).toBe('granted');
        expect(provider.getAvailability!()).toEqual({ configured: true });
    });

    it.each(['probe', 'getState', 'stop'] as const)('does not read a successful %s as granted access', async op => {
        const { provider, transport } = await load();
        handlers.getTrack = () => fail('auth-required');
        handlers[op] = () => ok(op === 'probe' ? { running: false, permission: 'unknown' } : null);
        await expect(transport.requestAppleMusic('getTrack', { id: track.id })).rejects.toBeDefined();
        await transport.requestAppleMusic(op);
        expect(transport.getAppleMusicPermission()).toBe('denied');
        expect(provider.getAvailability!()).toEqual({ configured: false, reason: 'not-configured' });
    });

    describe('after the permission was refused', () => {
        const refuse = async () => {
            const loaded = await load();
            handlers.listPlaylists = () => fail('auth-required');
            await expect(loaded.provider.library!.getUserPlaylists('local', 10, 0)).rejects.toMatchObject({ code: 'auth-required' });
            expect(loaded.transport.getAppleMusicPermission()).toBe('denied');
            request.mockClear();
            return loaded;
        };

        it('signs in again once a running Music app accepts a real request', async () => {
            const { provider, transport } = await refuse();
            handlers.probe = () => ok({ running: true, permission: 'unknown' });
            handlers.listPlaylists = () => ok([]);
            expect(await provider.auth!.getLoginStatus()).toEqual({ id: 'local', nickname: '音乐资料库' });
            expect(transport.getAppleMusicPermission()).toBe('granted');
            expect(provider.getAvailability!()).toEqual({ configured: true });
            expect(request.mock.calls.map(([op]) => op)).toEqual(['probe', 'listPlaylists']);
        });

        it('stays signed out without another request while Music is not running', async () => {
            const { provider } = await refuse();
            handlers.probe = () => ok({ running: false, permission: 'unknown' });
            handlers.listPlaylists = () => ok([]);
            expect(await provider.auth!.getLoginStatus()).toBeNull();
            expect(provider.getAvailability!()).toEqual({ configured: false, reason: 'not-configured' });
            expect(request.mock.calls.map(([op]) => op)).toEqual(['probe']);
        });

        it('stays signed out when the running Music app still refuses', async () => {
            const { provider } = await refuse();
            handlers.probe = () => ok({ running: true, permission: 'unknown' });
            expect(await provider.auth!.getLoginStatus()).toBeNull();
            expect(provider.getAvailability!()).toEqual({ configured: false, reason: 'not-configured' });
            expect(request.mock.calls.map(([op]) => op)).toEqual(['probe', 'listPlaylists']);
        });

        it('stays signed out when the re-test fails for another reason', async () => {
            const { provider, transport } = await refuse();
            handlers.probe = () => ok({ running: true, permission: 'unknown' });
            handlers.listPlaylists = () => fail('network');
            expect(await provider.auth!.getLoginStatus()).toBeNull();
            expect(transport.getAppleMusicPermission()).toBe('denied');
        });
    });

    it('is runtime-unavailable without the desktop bridge', async () => {
        const { provider, transport } = await load();
        expect(transport.isAppleMusicBridgeAvailable()).toBe(true);
        expect(provider.getAvailability!()).toEqual({ configured: true });
        delete (window.electron as { appleMusic?: unknown }).appleMusic;
        expect(transport.isAppleMusicBridgeAvailable()).toBe(false);
        expect(provider.getAvailability!()).toEqual({ configured: false, reason: 'runtime-unavailable' });
        await expect(transport.requestAppleMusic('probe')).rejects.toMatchObject({ code: 'unavailable', providerId: 'apple-music' });
        await expect(provider.auth!.getLoginStatus()).rejects.toMatchObject({ code: 'unavailable' });
    });

    it('is runtime-unavailable off macOS and outside Electron', async () => {
        const { provider, transport } = await load();
        installBridge('win32');
        expect(provider.getAvailability!()).toEqual({ configured: false, reason: 'runtime-unavailable' });
        vi.unstubAllGlobals();
        expect(transport.isAppleMusicBridgeAvailable()).toBe(false);
        expect(provider.getAvailability!()).toEqual({ configured: false, reason: 'runtime-unavailable' });
    });

    it('turns a rejected IPC call into a network error', async () => {
        const { transport } = await load();
        request.mockRejectedValueOnce(new Error('Untrusted renderer'));
        await expect(transport.requestAppleMusic('getState')).rejects.toMatchObject({ code: 'network', providerId: 'apple-music' });
    });

    it('clears the playlist and artwork caches on logout', async () => {
        const { provider } = await load();
        handlers.getPlaylistTracks = () => ok([{ ...track, artworkAssetId: assetId }]);
        const song = (await provider.catalog!.getPlaylistTracks!('library', 10, 0)).items[0];
        expect(provider.songMetadata!.getSongMetadata({ ...song, album: { ...song.album, coverUrl: undefined } }).coverUrl).toBe(coverUrl);
        await provider.auth!.logout();
        expect(provider.songMetadata!.getSongMetadata({ ...song, album: { ...song.album, coverUrl: undefined } }).coverUrl).toBeUndefined();
        await provider.catalog!.getPlaylistTracks!('library', 10, 0);
        expect(calls('getPlaylistTracks')).toHaveLength(2);
    });
});

describe('Apple Music external playback engine', () => {
    it('routes engine commands to the bridge with the song persistent id', async () => {
        const { provider } = await load();
        for (const op of ['play', 'pause', 'resume', 'seek', 'setVolume', 'stop'] as const) handlers[op] = () => ok(null);
        const engine = provider.externalPlayback!;
        const song = provider.normalizeSong(track);
        await engine.play(song, 12);
        await engine.pause();
        await engine.resume();
        await engine.seek(30.5);
        await engine.setVolume(0.5);
        await engine.stop();
        expect(request.mock.calls).toEqual([
            ['play', { id: 'ABCDEF0123456789', position: 12 }],
            ['pause', {}],
            ['resume', {}],
            ['seek', { position: 30.5 }],
            ['setVolume', { volume: 0.5 }],
            ['stop', {}],
        ]);
    });

    it('keeps the volume inside the 0..1 range the bridge accepts', async () => {
        const { provider } = await load();
        handlers.setVolume = () => ok(null);
        await provider.externalPlayback!.setVolume(1.0000000002);
        await provider.externalPlayback!.setVolume(-0.0000001);
        expect(request.mock.calls).toEqual([['setVolume', { volume: 1 }], ['setVolume', { volume: 0 }]]);
    });

    it('surfaces a refused command as a provider error', async () => {
        const { provider } = await load();
        handlers.play = () => fail('auth-required');
        await expect(provider.externalPlayback!.play(provider.normalizeSong(track), 0)).rejects.toMatchObject({ code: 'auth-required', providerId: 'apple-music' });
    });

    it('refuses to play a song that is not from Apple Music', async () => {
        const { provider } = await load();
        const foreign = { ...provider.normalizeSong(track), sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' } } as UnifiedSong;
        await expect(provider.externalPlayback!.play(foreign, 0)).rejects.toMatchObject({ code: 'unsupported' });
        expect(request).not.toHaveBeenCalled();
    });

    it('forwards monitoring and state subscriptions to the preload bridge', async () => {
        const { provider } = await load();
        const listener = vi.fn();
        const unsubscribe = provider.externalPlayback!.subscribeState(listener);
        expect(onState).toHaveBeenCalledWith(listener);
        unsubscribe();
        expect(unsubscribeState).toHaveBeenCalledTimes(1);
        provider.externalPlayback!.setMonitoring(true);
        expect(setMonitoring).toHaveBeenCalledWith(true);
    });

    it('does not throw when monitoring or subscribing without the bridge', async () => {
        const { provider } = await load();
        vi.unstubAllGlobals();
        expect(() => provider.externalPlayback!.setMonitoring(false)).not.toThrow();
        expect(() => provider.externalPlayback!.subscribeState(vi.fn())()).not.toThrow();
        installBridge();
        setMonitoring.mockRejectedValueOnce(new Error('Untrusted renderer'));
        expect(() => provider.externalPlayback!.setMonitoring(true)).not.toThrow();
        // A rejected IPC call must be swallowed, not left as an unhandled rejection.
        await new Promise(resolve => setTimeout(resolve, 0));
    });
});

describe('Apple Music registration', () => {
    // With a window present, the registry's i18n import reads localStorage while loading.
    const stubStorage = () => vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    const loadRegistry = async () => {
        vi.resetModules();
        return import('@/services/onlineMusic/providerRegistry');
    };

    it('registers with the provider registry on the macOS desktop bridge', async () => {
        stubStorage();
        const registry = await loadRegistry();
        expect(registry.getOnlineMusicProvider('apple-music')?.displayName).toBe('Apple Music');
        expect(registry.listOnlineMusicProviders().map(provider => provider.id)).toEqual(['netease', 'kugou', 'qq', 'bodian', 'apple-music']);
    });

    it('does not register without a window, off macOS, or without the Music bridge', async () => {
        vi.unstubAllGlobals();
        const noWindow = await loadRegistry();
        expect(noWindow.getOnlineMusicProvider('apple-music')).toBeNull();
        expect(noWindow.getOnlineMusicProvider('bodian')).not.toBeNull();

        stubStorage();
        installBridge('win32');
        expect((await loadRegistry()).getOnlineMusicProvider('apple-music')).toBeNull();

        installBridge();
        delete (window.electron as { appleMusic?: unknown }).appleMusic;
        expect((await loadRegistry()).getOnlineMusicProvider('apple-music')).toBeNull();
    });
});
