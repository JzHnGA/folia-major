import type { SongResult, UnifiedSong } from '../../../../types';
import { OnlineProviderError } from '../../../../types/onlineMusic';
import type {
    AudioQualityPreference,
    LoginFailureDetail,
    LoginState,
    MediaId,
    OnlineMusicProvider,
    ProviderLyricsResult,
} from '../../../../types/onlineMusic';
import { processNeteaseLyrics } from '../../../../utils/lyrics/neteaseProcessing';
import { getPlaybackSourceRef } from '../../../../utils/appPlaybackGuards';
import {
    dropOfficialSignIn,
    hasOfficialSignIn,
    keepOfficialSignIn,
    officialGatewayReady,
    officialRequest,
    pollOfficialLogin,
    startOfficialLogin,
} from './officialGateway';
import { normalizeOfficialCollection, normalizeOfficialSong, normalizeOfficialUser, toHttps } from './officialNormalize';

// src/services/onlineMusic/netease/official/officialProvider.ts
// NetEase through the official OpenAPI (the "云音乐-CLI 版" app), registered under the same id
// `netease` as the legacy NeteaseCloudMusicApi provider; neteaseProviderChoice.ts picks one of the
// two per build. The MVP is search, song details, playback, lyrics and the same-device QR login;
// what the official API has no counterpart for (playlists, likes, recommendations, explore) is
// declared false instead of shown half-working.

// The official song ids: encrypted hex strings. An all-digit id is a legacy-provider id (a song saved
// before the switch): it names nothing here and is never sent, as one bad id can fail a whole batch.
const OFFICIAL_ID = /^(?!\d+$)[A-Za-z0-9]{1,64}$/;
const SONG_LIST_BATCH = 100;
const LOGIN_TTL_MS = 5 * 60 * 1000;

const officialId = (id: MediaId): string => {
    const value = String(id);
    if (!OFFICIAL_ID.test(value)) throw new OnlineProviderError('invalid-response', `Not an official NetEase id: ${value}`, 'netease');
    return value;
};

const isOfficialSong = (song: SongResult): boolean => {
    const source = getPlaybackSourceRef(song);
    return source.kind === 'online' && OFFICIAL_ID.test(source.mediaId);
};

const bitrateOf = (quality: AudioQualityPreference): 128 | 320 | 999 | 1999 => {
    if (quality === 'standard') return 128;
    if (quality === 'lossless') return 999;
    if (quality === 'hires') return 1999;
    return 320;
};

const qualityOfBitrate = (br: number, asked: AudioQualityPreference): AudioQualityPreference => {
    if (br >= 1_900_000) return 'hires';
    if (br >= 900_000) return 'lossless';
    if (br >= 300_000) return 'high';
    if (br > 0) return 'standard';
    return asked;
};

// Liked song ids are read from the 红心 playlist a page of this many at a time, up to LIKED_PAGES pages.
const LIKED_PAGE = 500;
const LIKED_PAGES = 10;

const recordCount = (data: unknown): number | null => {
    const count = Number((data as { recordCount?: unknown } | null)?.recordCount);
    return Number.isFinite(count) && count >= 0 ? count : null;
};

/** A page of the account's playlists of one kind, as collections. */
const readPlaylists = async (kind: 'created' | 'subscribed', limit: number, offset: number) => {
    const result = await officialRequest('userPlaylists', { kind, limit, offset }, 'the playlists');
    const items = records(result.data).map(raw => normalizeOfficialCollection(raw, 'playlist', { isOwned: kind === 'created' }));
    const total = recordCount(result.data);
    return { items, hasMore: total !== null ? offset + items.length < total : items.length === limit };
};

const records = (data: unknown): unknown[] => {
    const value = data as { records?: unknown[] } | unknown[] | null;
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.records) ? value.records : [];
};

// The QR codes being waited on, by uniKey: the poll runs as the anonymous token the code was made with.
const pendingLogins = new Map<string, { anonymousToken: string; qrCodeUrl: string }>();

/**
 * The same-device confirmation (方案 A): the NetEase app's own scheme with the code's address in it.
 * The login window shows it as its "log in in the app" button and opens it once by itself on a phone,
 * which takes the NetEase app straight to the confirmation of this code. The QR code stays on screen
 * for another device, or for when the NetEase app is not installed.
 */
const appLoginUrl = (qrCodeUrl: string): string => `orpheus://openurl?url=${encodeURIComponent(qrCodeUrl)}`;

const getLyrics = async (song: SongResult): Promise<ProviderLyricsResult> => {
    const songId = officialId(song.id);
    // Line lyrics only: the CLI app type may not call the word-by-word interface (NetEase answers
    // 300 应用未授权, seen on a device 2026-11-19), so it is not asked.
    const line = await officialRequest('lyric', { songId }, 'the lyrics');
    const lineData = (line.data ?? {}) as Record<string, unknown>;
    const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
    const mainText = textOf(lineData.lyric);
    const translation = textOf(lineData.transLyric);
    const romanization = textOf(lineData.romalrc);
    const pureMusic = lineData.pureMusic === true || lineData.noLyric === true;
    const processed = await processNeteaseLyrics({
        type: 'netease',
        ...(mainText ? { lrc: { lyric: mainText } } : {}),
        ...(translation ? { tlyric: { lyric: translation } } : {}),
        ...(romanization ? { romalrc: { lyric: romanization } } : {}),
        ...(pureMusic ? { pureMusic: true } : {}),
    });
    return {
        lyrics: processed.lyrics,
        mainText: processed.mainLrc,
        wordByWordText: processed.yrcLrc,
        translationText: processed.transLrc,
        romanizationText: processed.romanizationLrc ?? null,
        isPureMusic: processed.isPureMusic || pureMusic,
        chorusRanges: [],
    };
};

/**
 * What the login window is told when a step of the official login throws: no reach is
 * "unreachable"; otherwise the gateway's or NetEase's code and our own sentence (never a token), so
 * the window and its details name the cause instead of "Unknown error".
 */
const describeOfficialLoginFailure = (_step: unknown, error: unknown): LoginFailureDetail | null => {
    if (!(error instanceof OnlineProviderError)) {
        return error instanceof Error && error.message ? { message: error.message } : null;
    }
    if (error.code === 'network') return { case: 'unreachable', message: error.message };
    const cause: unknown = error.cause;
    const answer = cause && typeof cause === 'object' ? cause as { error?: { code?: string }; upstreamCode?: number | null } : null;
    const upstream = answer?.upstreamCode;
    return {
        code: answer?.error?.code ?? error.code,
        message: error.message,
        ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
        ...(upstream !== undefined && upstream !== null ? { upstreamCode: String(upstream) } : {}),
    };
};

const checkLogin = async (key: string): Promise<LoginState> => {
    const pending = pendingLogins.get(key);
    if (!pending) return { state: 'expired' };
    let result;
    try {
        result = await pollOfficialLogin(key, pending.anonymousToken);
    } catch (error) {
        // No answer from NetEase this time (gateway or network): the code is still valid there, so
        // the login keeps checking, as the legacy provider does for its backend's 502.
        if (error instanceof OnlineProviderError && error.code === 'network') {
            return { state: 'error', message: error.message, transient: true };
        }
        throw error;
    }
    const status = Number(result.status);
    switch (status) {
        case 800:
            pendingLogins.delete(key);
            return { state: 'expired' };
        case 801: return { state: 'waiting' };
        case 802: return { state: 'scanned' };
        case 803:
            // Cancelled while this check was out: the window is gone, the login is not applied.
            if (!pendingLogins.has(key)) return { state: 'expired' };
            if (typeof result.accessToken === 'string' && typeof result.refreshToken === 'string') {
                await keepOfficialSignIn(result.accessToken, result.refreshToken);
                pendingLogins.delete(key);
                console.info('[NeteaseOfficial] The QR login was confirmed');
                return { state: 'confirmed' };
            }
            return { state: 'error', message: 'NetEase confirmed the login without tokens' };
        default:
            return {
                state: 'error',
                message: `NetEase QR status ${status}: ${result.message ?? ''}`,
                failure: { code: String(status), ...(result.message ? { message: result.message } : {}) },
            };
    }
};

export const neteaseOfficialProvider: OnlineMusicProvider = {
    id: 'netease',
    displayName: 'NetEase Cloud Music',
    shortName: '网易云',
    shortNameKey: 'onlineProviderName.netease',
    mark: { letter: '云', color: '#dc2626' },
    // Only the iOS shell can reach the gateway (the Firebase ID token and the Keychain are native).
    getAvailability: () => (officialGatewayReady() ? { configured: true } : { configured: false, reason: 'runtime-unavailable' }),
    capabilities: {
        search: true,
        playback: true,
        lyrics: true,
        auth: true,
        userLibrary: true,
        playlists: true,
        albums: true,
        artists: false,
        recommendations: true,
        mutations: false,
        wordByWordLyrics: false,
        playbackReports: true,
    },
    normalizeSong: normalizeOfficialSong,
    normalizeCollection: (raw, type) => normalizeOfficialCollection(raw, type),
    normalizeUser: normalizeOfficialUser,
    search: {
        async searchSongs(query, limit, offset) {
            const result = await officialRequest('search', { kind: 'song', keyword: query, limit: Math.min(limit, 100), offset }, 'the search');
            const items = records(result.data).map(normalizeOfficialSong);
            const total = Number((result.data as { recordCount?: number } | null)?.recordCount);
            const known = Number.isFinite(total) && total > 0;
            return {
                items,
                ...(known ? { total } : {}),
                hasMore: known ? offset + items.length < total : items.length === limit,
                nextOffset: offset + items.length,
            };
        },
    },
    playback: {
        async getSongDetail(id) {
            if (!OFFICIAL_ID.test(String(id))) return null;
            const result = await officialRequest('songDetail', { songId: officialId(id) }, 'the song detail');
            return result.data ? normalizeOfficialSong(result.data) : null;
        },
        async getSongDetails(ids) {
            const wanted = ids.map(id => (OFFICIAL_ID.test(String(id)) ? String(id) : null));
            const asked = [...new Set(wanted.filter((id): id is string => id !== null))];
            const found = new Map<string, UnifiedSong>();
            for (let start = 0; start < asked.length; start += SONG_LIST_BATCH) {
                const result = await officialRequest('songDetail', { songIds: asked.slice(start, start + SONG_LIST_BATCH) }, 'the song details');
                for (const raw of records(result.data)) {
                    const song = normalizeOfficialSong(raw);
                    if (song.id) found.set(String(song.id), song);
                }
            }
            return wanted.map(id => (id === null ? null : found.get(id) ?? null));
        },
        songDetailsPerRequest: SONG_LIST_BATCH,
        // NetEase's own 是否有版权 flag (visible false: no rights for this app; seen on a device
        // 2026-11-19, where song detail then gives no URL), kept as resourceState by the normalizer.
        // Shown as unavailable in lists so nobody taps a song that cannot sound.
        getAvailability(song) {
            return song.resourceState === false ? { state: 'unavailable', reason: 'taken-down' } : { state: 'playable' };
        },
        async getAudioSource(song, quality) {
            const result = await officialRequest('playUrl', { songId: officialId(song.id), bitrate: bitrateOf(quality) }, 'the song URL');
            const data = (result.data ?? {}) as Record<string, unknown>;
            const url = toHttps(data.url);
            if (!url) {
                // 10003 无版权（请前往手机端）, 10004 付费/会员; other sub codes say nothing more.
                const subCode = result.subCode ?? '';
                if (subCode === '10004' || data.vipFlag === true || data.payPlayFlag === true) {
                    throw new OnlineProviderError('subscription-required', result.message || 'NetEase: a VIP or paid song', 'netease', result);
                }
                if (subCode === '10003' || data.visible === false) {
                    throw new OnlineProviderError('region-restricted', result.message || 'NetEase: no rights on this device', 'netease', result);
                }
                throw new OnlineProviderError('not-playable', `NetEase gave no URL (sub code ${subCode || 'none'})`, 'netease', result);
            }
            const trial = data.freeTrail && typeof data.freeTrail === 'object' ? data.freeTrail as { start?: number } : null;
            const expiresAt = Number(data.playUrlExpireTime);
            return {
                url,
                fetchedAt: Date.now(),
                quality: qualityOfBitrate(Number(data.br) || 0, quality),
                ...(Number.isFinite(expiresAt) && expiresAt > Date.now() ? { expiresAt } : {}),
                ...(trial ? { preview: true, ...(Number(trial.start) > 0 ? { clipStartMs: Number(trial.start) * 1000 } : {}) } : {}),
                ...(Number.isFinite(Number(data.gain)) && data.gain !== null ? { replayGain: { trackGain: Number(data.gain) } } : {}),
            };
        },
    },
    playbackReports: {
        canReport: isOfficialSong,
        // A finished play is the pair NetEase asks for: `startplay` and `play` (播放数据回传 docs).
        async reportPlayback(song, report) {
            if (!(report.playedSeconds > 0)) return;
            const id = officialId(song.id);
            const providerData = getPlaybackSourceRef(song).kind === 'online' ? (song.sourceRef as { providerData?: Record<string, unknown> }).providerData : undefined;
            const alg = typeof providerData?.alg === 'string' ? providerData.alg : '';
            const bitrate = bitrateOf(report.quality ?? 'high');
            const startLogTime = Date.now() - Math.round(report.playedSeconds * 1000);
            await officialRequest('reportPlay', { id, action: 'startplay', bitrate, startLogTime, alg }, 'the listening report');
            await officialRequest('reportPlay', {
                id,
                action: 'play',
                bitrate,
                startLogTime,
                alg,
                time: report.playedSeconds,
                end: report.totalSeconds && report.playedSeconds >= report.totalSeconds - 1 ? 'playend' : 'ui',
            }, 'the listening report');
        },
    },
    lyrics: { getLyrics },
    library: {
        // Created playlists first (NetEase puts the 红心 playlist at their end), then subscribed ones.
        // The page offset runs over both lists: created ones up to their count, subscribed after.
        async getUserPlaylists(_userId, limit, offset) {
            const created = await readPlaylists('created', 500, 0);
            const createdItems = created.items;
            if (offset < createdItems.length) {
                const items = createdItems.slice(offset, offset + limit);
                return { items, hasMore: true, nextOffset: offset + items.length };
            }
            const subscribedOffset = offset - createdItems.length;
            const subscribed = await readPlaylists('subscribed', limit, subscribedOffset);
            return { items: subscribed.items, hasMore: subscribed.hasMore, nextOffset: offset + subscribed.items.length };
        },
        async getLikedSongIds() {
            const liked = await officialRequest('likedPlaylist', {}, 'the liked songs');
            const playlist = normalizeOfficialCollection(liked.data);
            // Every account has a 红心 playlist: an answer without one is not "nothing liked".
            if (!playlist.id) throw new OnlineProviderError('invalid-response', 'NetEase named no liked playlist', 'netease', liked);
            const ids: MediaId[] = [];
            for (let page = 0; page < LIKED_PAGES; page += 1) {
                const result = await officialRequest('playlistTracks', { playlistId: playlist.id, limit: LIKED_PAGE, offset: page * LIKED_PAGE }, 'the liked songs');
                const songs = records(result.data);
                for (const raw of songs) {
                    const id = normalizeOfficialSong(raw).id;
                    if (id) ids.push(id);
                }
                if (songs.length < LIKED_PAGE) return { ids, whole: true };
            }
            return { ids, whole: false };
        },
        async getUserAlbums(_userId, limit, offset) {
            const result = await officialRequest('userAlbums', { limit, offset }, 'the saved albums');
            const items = records(result.data).map(raw => normalizeOfficialCollection(raw, 'album'));
            const total = recordCount(result.data);
            return { items, hasMore: total !== null ? offset + items.length < total : items.length === limit, nextOffset: offset + items.length };
        },
    },
    catalog: {
        async getPlaylistTracks(id, limit, offset) {
            const result = await officialRequest('playlistTracks', { playlistId: officialId(id), limit: Math.min(limit, 500), offset }, 'the playlist tracks');
            const items = records(result.data).map(normalizeOfficialSong);
            return { items, hasMore: items.length === Math.min(limit, 500), nextOffset: offset + items.length };
        },
        async getPlaylistDetail(id, collection) {
            const result = await officialRequest('playlistDetail', { playlistId: officialId(id) }, 'the playlist');
            return result.data ? { ...normalizeOfficialCollection(result.data), ...(collection?.isOwned ? { isOwned: true } : {}) } : collection ?? null;
        },
        async getAlbumDetail(id, collection) {
            const result = await officialRequest('albumDetail', { albumId: officialId(id) }, 'the album');
            if (!result.data) return collection ?? null;
            const album = normalizeOfficialCollection(result.data, 'album');
            return { ...album, trackCount: album.trackCount ?? collection?.trackCount, coverUrl: album.coverUrl ?? collection?.coverUrl };
        },
        async getAlbumTracks(id) {
            const result = await officialRequest('albumTracks', { albumId: officialId(id) }, 'the album tracks');
            const items = records(result.data).map(normalizeOfficialSong);
            return { items, hasMore: false, nextOffset: items.length };
        },
    },
    recommendations: {
        async getDailySongs() {
            const result = await officialRequest('dailySongs', { limit: 30 }, 'the daily songs');
            return records(result.data).map(normalizeOfficialSong);
        },
        // The CLI app may not read NetEase's recommended playlists (300); its 私人雷达 playlists are
        // the recommendation it can show.
        async getRecommendedCollections(limit) {
            const result = await officialRequest('radarPlaylists', {}, 'the recommended playlists');
            return records(result.data).slice(0, limit).map(raw => normalizeOfficialCollection(raw));
        },
    },
    auth: {
        getLoginTexts: () => ({ title: 'home.loginTitle', note: 'home.loginNote' }),
        async getLoginStatus() {
            if (!officialGatewayReady() || !await hasOfficialSignIn()) return null;
            const result = await officialRequest('userProfile', {}, 'the account');
            // An anonymous token is answered with data: null.
            return result.data ? normalizeOfficialUser(result.data) : null;
        },
        async logout() {
            await dropOfficialSignIn();
        },
        async signInRanOut() {
            await dropOfficialSignIn();
        },
        // The kept account is painted only once NetEase has named the same user, as for the legacy iOS shell.
        showsKeptAccountAtStart: false,
        showsKeptAccountOnStartFailure: true,
        async startLogin() {
            const { uniKey, qrCodeUrl, anonymousToken } = await startOfficialLogin();
            pendingLogins.set(uniKey, { anonymousToken, qrCodeUrl });
            return uniKey;
        },
        // The QR code of NetEase's login address, drawn here (the official API answers only the address).
        async createQr(key) {
            const pending = pendingLogins.get(key);
            if (!pending) throw new OnlineProviderError('invalid-response', 'This login code is no longer known', 'netease');
            const { toDataURL } = await import('qrcode');
            return toDataURL(pending.qrCodeUrl, { width: 480, margin: 1, errorCorrectionLevel: 'M' });
        },
        getLoginCodeUrl: key => {
            const pending = pendingLogins.get(key);
            return pending ? appLoginUrl(pending.qrCodeUrl) : null;
        },
        checkLogin,
        cancelLogin(key) {
            pendingLogins.delete(key);
            return Promise.resolve();
        },
        getLoginTtlMs: () => LOGIN_TTL_MS,
        describeLoginFailure: describeOfficialLoginFailure,
    },
};
