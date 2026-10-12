import type { SongResult, UnifiedSong } from '../../types';
import type {
    MediaId, OnlineAuthProvider, OnlineCatalogProvider, OnlineExternalPlaybackProvider, OnlineLibraryProvider, OnlineLyricsProvider,
    OnlineMusicProvider, OnlinePlaybackProvider, OnlineSearchProvider, ProviderAudioSource, ProviderCollection, ProviderPage,
} from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { createSilentCarrierUrl } from '../externalPlayback/silentCarrier';
import { getLocalCoverAssetUrl } from '../localCoverAssetUrl';
import {
    getAppleMusicPermission, isAppleMusicBridgeAvailable, requestAppleMusic, setAppleMusicMonitoring, subscribeAppleMusicState,
} from './appleMusicTransport';
import type { AppleMusicPlaylistRecord, AppleMusicTrackRecord } from './appleMusicTransport';

// src/services/onlineMusic/appleMusicProvider.ts

export const APPLE_MUSIC_PROVIDER_ID = 'apple-music';

const LIBRARY_PLAYLIST_ID = 'library';
const LIBRARY_PLAYLIST_NAME = '资料库全部歌曲';
const LOCAL_USER = { id: 'local', nickname: '音乐资料库' };
const PLAYLIST_CACHE_MS = 60_000;
const ARTWORK_TIMEOUT_MS = 1500;
const COVER_SIZE = 1024;
// The bridge rejects searches above these bounds.
const MAX_SEARCH_LIMIT = 100;
const MAX_QUERY_LENGTH = 200;

interface CachedPlaylist {
    at: number;
    tracks: Promise<AppleMusicTrackRecord[]>;
    count?: number;
}

const playlistTracks = new Map<string, CachedPlaylist>();
// The first artwork any track of an album reports covers every other track of that album.
const albumArtwork = new Map<string, string>();

const clearAppleMusicCaches = () => {
    playlistTracks.clear();
    albumArtwork.clear();
};

const albumIdOf = (record: AppleMusicTrackRecord): string => `album:${record.albumArtist || record.artist}|${record.album}`;

const coverUrlOf = (assetId: string | undefined): string | undefined => (
    (assetId && getLocalCoverAssetUrl(assetId, COVER_SIZE)) || undefined
);

const pageOf = <T>(items: T[], total: number | undefined, offset: number, hasMore: boolean): ProviderPage<T> => ({
    items, ...(total === undefined ? {} : { total }), hasMore, nextOffset: offset + items.length,
});

// Turns a Music.app track record into the canonical song; the persistent ID is the identity and the duration rides along for the silent carrier.
function normalizeAppleMusicSong(raw: unknown): UnifiedSong {
    const record = raw as Partial<AppleMusicTrackRecord> | null;
    if (!record || typeof record.id !== 'string' || !record.id) {
        throw new OnlineProviderError('invalid-response', 'Apple Music track has no persistent id', APPLE_MUSIC_PROVIDER_ID);
    }
    const track: AppleMusicTrackRecord = {
        id: record.id,
        name: String(record.name ?? ''),
        artist: String(record.artist ?? ''),
        albumArtist: String(record.albumArtist ?? ''),
        album: String(record.album ?? ''),
        duration: Number.isFinite(record.duration) ? Number(record.duration) : 0,
        ...(record.artworkAssetId ? { artworkAssetId: record.artworkAssetId } : {}),
    };
    const albumId = albumIdOf(track);
    if (track.artworkAssetId) albumArtwork.set(albumId, track.artworkAssetId);
    const coverUrl = coverUrlOf(track.artworkAssetId ?? albumArtwork.get(albumId));
    return {
        id: track.id,
        name: track.name,
        artists: [{ id: `artist:${track.artist}`, name: track.artist }],
        album: { id: albumId, name: track.album, ...(coverUrl ? { coverUrl } : {}) },
        durationMs: Math.round(track.duration * 1000),
        sourceRef: {
            kind: 'online', providerId: APPLE_MUSIC_PROVIDER_ID, mediaId: track.id, providerData: { durationSec: track.duration },
        },
    };
}

// Returns the Music app persistent ID of a song, refusing songs that belong to another provider.
function appleMusicMediaId(song: SongResult): string {
    const source = getPlaybackSourceRef(song);
    if (source.kind !== 'online' || source.providerId !== APPLE_MUSIC_PROVIDER_ID) {
        throw new OnlineProviderError('unsupported', 'Song does not belong to Apple Music', APPLE_MUSIC_PROVIDER_ID);
    }
    return source.mediaId;
}

const isPositiveFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

// Reads a whole playlist once per minute; concurrent page requests share the same bridge call.
function loadPlaylistTracks(id: MediaId): Promise<AppleMusicTrackRecord[]> {
    const key = String(id);
    const cached = playlistTracks.get(key);
    if (cached && Date.now() - cached.at < PLAYLIST_CACHE_MS) return cached.tracks;
    const entry: CachedPlaylist = {
        at: Date.now(),
        tracks: requestAppleMusic<AppleMusicTrackRecord[]>('getPlaylistTracks', { playlistId: key }).then(records => {
            if (!Array.isArray(records)) throw new OnlineProviderError('invalid-response', 'Apple Music track list is missing', APPLE_MUSIC_PROVIDER_ID);
            entry.count = records.length;
            return records;
        }),
    };
    playlistTracks.set(key, entry);
    // A failed read must not be served again for the rest of the minute.
    entry.tracks.catch(() => {
        if (playlistTracks.get(key) === entry) playlistTracks.delete(key);
    });
    return entry.tracks;
}

const search: OnlineSearchProvider = {
    async searchSongs(query, limit, offset) {
        const text = query.trim().slice(0, MAX_QUERY_LENGTH);
        if (!text) return pageOf<UnifiedSong>([], 0, offset, false);
        const requested = Math.max(1, Math.min(offset + limit, MAX_SEARCH_LIMIT));
        const records = await requestAppleMusic<AppleMusicTrackRecord[]>('searchLibrary', { query: text, limit: requested });
        if (!Array.isArray(records)) throw new OnlineProviderError('invalid-response', 'Apple Music search list is missing', APPLE_MUSIC_PROVIDER_ID);
        const items = records.slice(offset, offset + limit).map(normalizeAppleMusicSong);
        // The bridge returns up to the requested number of songs (music videos are skipped), so a short answer is the whole result.
        const exhausted = records.length < requested;
        return pageOf(items, exhausted ? records.length : undefined, offset, !exhausted && requested < MAX_SEARCH_LIMIT);
    },
};

// Waits for the artwork request for a short while; the answer is stored even when it arrives after the wait is over.
async function fetchArtworkBestEffort(song: SongResult, mediaId: string): Promise<void> {
    const albumId = song.album?.id !== undefined ? String(song.album.id) : '';
    if (!albumId || song.album?.coverUrl || albumArtwork.has(albumId)) return;
    const request = requestAppleMusic<{ assetId: string } | null>('getArtwork', { id: mediaId }).then(result => {
        if (result?.assetId) albumArtwork.set(albumId, result.assetId);
    }).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, ARTWORK_TIMEOUT_MS); });
    try {
        await Promise.race([request, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

const playback: OnlinePlaybackProvider = {
    async getSongDetail(id) {
        return normalizeAppleMusicSong(await requestAppleMusic<AppleMusicTrackRecord>('getTrack', { id: String(id) }));
    },
    // Hands out a silent carrier as long as the track; the real audio is played by Music.app once the engine starts it.
    async getAudioSource(song): Promise<ProviderAudioSource> {
        const mediaId = appleMusicMediaId(song);
        const source = getPlaybackSourceRef(song);
        const knownDuration = source.kind === 'online' ? source.providerData?.durationSec : undefined;
        const durationSec = isPositiveFinite(knownDuration)
            ? knownDuration
            : (await requestAppleMusic<AppleMusicTrackRecord>('getTrack', { id: mediaId })).duration;
        if (!isPositiveFinite(durationSec)) {
            throw new OnlineProviderError('not-playable', 'Apple Music track has no usable duration', APPLE_MUSIC_PROVIDER_ID);
        }
        await fetchArtworkBestEffort(song, mediaId);
        let url: string | null;
        try {
            url = createSilentCarrierUrl(durationSec);
        } catch (error) {
            // An absurd duration makes the carrier too large to allocate.
            throw new OnlineProviderError('not-playable', 'Silent carrier could not be built', APPLE_MUSIC_PROVIDER_ID, error);
        }
        if (!url) throw new OnlineProviderError('not-playable', 'Silent carrier is unavailable', APPLE_MUSIC_PROVIDER_ID);
        return { url, fetchedAt: Date.now(), quality: 'standard' };
    },
};

const lyrics: OnlineLyricsProvider = {
    // Music.app has no lyrics API we use, so the shared automatic matching supplies them.
    async getLyrics() {
        return { lyrics: null, isPureMusic: false };
    },
};

const auth: OnlineAuthProvider = {
    // The probe only proves the bridge is there; Automation permission shows up on the first real request.
    // After a refusal, one listPlaylists re-tests it while Music is already running (so it is not launched): access may have been granted since.
    async getLoginStatus() {
        const state = await requestAppleMusic<{ running?: boolean } | null>('probe');
        if (getAppleMusicPermission() === 'denied') {
            if (!state?.running) return null;
            try {
                await requestAppleMusic('listPlaylists');
            } catch {
                return null;
            }
        }
        return getAppleMusicPermission() === 'denied' ? null : { ...LOCAL_USER };
    },
    async logout() {
        clearAppleMusicCaches();
    },
};

const library: OnlineLibraryProvider = {
    async getUserPlaylists(_userId, limit, offset) {
        const records = await requestAppleMusic<AppleMusicPlaylistRecord[]>('listPlaylists');
        if (!Array.isArray(records)) throw new OnlineProviderError('invalid-response', 'Apple Music playlist list is missing', APPLE_MUSIC_PROVIDER_ID);
        const collections: ProviderCollection[] = records.map(record => ({
            providerId: APPLE_MUSIC_PROVIDER_ID,
            id: record.id,
            name: record.kind === 'library' ? LIBRARY_PLAYLIST_NAME : record.name,
            type: 'playlist',
            isOwned: true,
            providerData: { kind: record.kind },
        }));
        // The whole library comes first; the sort is stable, so the other playlists keep Music's order.
        collections.sort((a, b) => Number(b.providerData?.kind === 'library') - Number(a.providerData?.kind === 'library'));
        const items = collections.slice(offset, offset + limit);
        return pageOf(items, collections.length, offset, offset + items.length < collections.length);
    },
};

const catalog: OnlineCatalogProvider = {
    async getPlaylistTracks(id, limit, offset) {
        const records = await loadPlaylistTracks(id);
        const items = records.slice(offset, offset + limit).map(normalizeAppleMusicSong);
        return pageOf(items, records.length, offset, offset + items.length < records.length);
    },
    async getPlaylistDetail(id, collection) {
        if (!collection) return null;
        const cached = playlistTracks.get(String(id));
        const count = cached && Date.now() - cached.at < PLAYLIST_CACHE_MS ? cached.count : undefined;
        return count === undefined ? collection : { ...collection, trackCount: count };
    },
};

const externalPlayback: OnlineExternalPlaybackProvider = {
    async play(song, positionSec) {
        await requestAppleMusic('play', { id: appleMusicMediaId(song), position: positionSec });
    },
    async pause() { await requestAppleMusic('pause'); },
    async resume() { await requestAppleMusic('resume'); },
    async seek(positionSec) { await requestAppleMusic('seek', { position: positionSec }); },
    async stop() { await requestAppleMusic('stop'); },
    // The bridge only accepts 0..1, so rounding noise from a volume curve must not turn into a refusal.
    async setVolume(volume) { await requestAppleMusic('setVolume', { volume: Math.min(1, Math.max(0, volume)) }); },
    setMonitoring: setAppleMusicMonitoring,
    subscribeState: subscribeAppleMusicState,
};

export const appleMusicProvider: OnlineMusicProvider = {
    id: APPLE_MUSIC_PROVIDER_ID,
    displayName: 'Apple Music',
    shortName: 'Apple Music',
    getAvailability() {
        if (!isAppleMusicBridgeAvailable()) return { configured: false, reason: 'runtime-unavailable' };
        if (getAppleMusicPermission() === 'denied') return { configured: false, reason: 'not-configured' };
        return { configured: true };
    },
    capabilities: {
        search: true, playback: true, lyrics: true, auth: true, userLibrary: true, playlists: true, externalPlayback: true,
        albums: false, artists: false, recommendations: false, mutations: false, wordByWordLyrics: false,
    },
    normalizeSong: normalizeAppleMusicSong,
    songMetadata: {
        // The album map may know a cover the stored song never received.
        getSongMetadata(song) {
            const metadata = createProviderSongMetadata(song);
            if (metadata.coverUrl) return metadata;
            const coverUrl = coverUrlOf(albumArtwork.get(String(song.album?.id)));
            return coverUrl ? { ...metadata, coverUrl, album: { ...metadata.album, coverUrl } } : metadata;
        },
    },
    search,
    playback,
    lyrics,
    auth,
    library,
    catalog,
    externalPlayback,
};
