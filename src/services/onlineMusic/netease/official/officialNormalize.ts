import type { UnifiedSong } from '../../../../types';
import type { MediaId, ProviderCollection, ProviderUser } from '../../../../types/onlineMusic';

// src/services/onlineMusic/netease/official/officialNormalize.ts
// The official OpenAPI's records as the app's songs and users. Official ids are encrypted strings
// ("1CE4E2A5D6869390649E6FF192436A5F"), not the numbers the legacy API uses: they are kept as they
// are (never through toNeteaseId), and a numeric `originalId`, where a record carries one, goes into
// providerData. A song from this provider and one from the legacy provider never share an id.

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw => (value && typeof value === 'object' ? value as Raw : {});
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value as unknown[] : []);
const asText = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const asId = (value: unknown, fallback: MediaId): MediaId => (typeof value === 'string' || typeof value === 'number' ? value : fallback);

/** Plain http from NetEase's CDN, made https: the iOS build keeps ATS strict (no arbitrary loads). */
export const toHttps = (url: unknown): string | undefined => (
    typeof url === 'string' && url ? url.replace(/^http:\/\//i, 'https://') : undefined
);

const artistsOf = (record: Raw): Array<{ id: MediaId; name: string }> => {
    const own = asList(record.artists);
    const list = own.length > 0 ? own : asList(record.fullArtists);
    const artists = list
        .map((item, index) => {
            const artist = asRecord(item);
            return { id: asId(artist.id, `artist-${index}`), name: asText(artist.name) };
        })
        .filter(artist => artist.name);
    if (artists.length > 0) return artists;
    // The recent-plays record names its artist in flat fields.
    const flat = asText(record.artistName);
    return flat ? [{ id: asId(record.artistId, 'artist-0'), name: flat }] : [];
};

const isNormalizedSong = (record: Raw): boolean => {
    const sourceRef = asRecord(record.sourceRef);
    return sourceRef.kind === 'online' && sourceRef.providerId === 'netease' && Array.isArray(record.artists) && Boolean(record.album);
};

export const normalizeOfficialSong = (raw: unknown): UnifiedSong => {
    const record = asRecord(raw);
    // A song that was normalized already (a cache read back) is handed in again: keep it.
    if (isNormalizedSong(record)) return raw as UnifiedSong;
    const album = asRecord(record.album);
    const id = asText(record.id);
    const originalId = asText(record.originalId ?? record.originalSongId);
    const duration = Number(record.duration ?? record.durationMs ?? 0);
    // visible false is NetEase's own 无版权 flag for this app; playFlag false alone (a VIP or paid song
    // with no privilege) is a restriction, not a song that is gone, so it does not mark the song.
    const playable = record.visible !== false;
    const alg = asText(record.alg);
    return {
        id,
        name: asText(record.name) || 'Unknown Song',
        artists: artistsOf(record),
        album: {
            id: asId(album.id ?? record.albumId, 0),
            name: asText(album.name) || asText(record.albumName) || 'Unknown Album',
            coverUrl: toHttps(record.coverImgUrl ?? album.picUrl ?? album.coverImgUrl),
        },
        durationMs: Number.isFinite(duration) ? duration : 0,
        aliases: [],
        translatedNames: [],
        isPureMusic: false,
        ...(playable ? {} : { resourceState: false }),
        sourceRef: {
            kind: 'online',
            providerId: 'netease',
            mediaId: id,
            providerData: {
                official: true,
                ...(originalId ? { originalId } : {}),
                ...(alg ? { alg } : {}),
                ...(record.vipPlayFlag === true || record.payPlayFlag === true ? { paid: true } : {}),
            },
        },
    };
};

export const normalizeOfficialUser = (raw: unknown): ProviderUser => {
    const record = asRecord(raw);
    // 15 黑胶SVIP, 6 黑胶VIP (用户基本信息 docs); anything else is no membership the app tells apart.
    const vipTypes = asList(record.vipDetail).map(item => Number(asRecord(item).type));
    const member = vipTypes.includes(15) || vipTypes.includes(6);
    return {
        id: asText(record.id ?? record.userId),
        nickname: asText(record.nickname),
        avatarUrl: toHttps(record.avatarUrl),
        ...(member ? { vipType: vipTypes.includes(15) ? 15 : 11 } : {}),
    };
};

const millis = (value: unknown): number => Math.max(0, Math.round(Number(value) || 0));

/**
 * The 逐字歌词 answer's lines as YRC text (`[start,duration](wordStart,wordDuration,0)word`), the
 * form the lyric parser reads for the legacy API. A "(" inside a word would end it early in that
 * form, so it is written full-width.
 */
export const officialWordLinesToYrc = (lines: unknown): string | null => {
    const text = asList(lines)
        .map(item => {
            const line = asRecord(item);
            const body = asList(line.words)
                .map(asRecord)
                .filter(word => typeof word.words === 'string')
                .map(word => `(${millis(word.suspend)},${millis(word.duration)},0)${asText(word.words).replace(/\(/g, '（')}`)
                .join('');
            return body ? `[${millis(line.start)},${millis(line.duration)}]${body}` : '';
        })
        .filter(Boolean)
        .join('\n');
    return text || null;
};

// NetEase marks the account's own 我喜欢的音乐 playlist with specialType 5.
const LIKED_SPECIAL_TYPE = 5;

/**
 * An official playlist or album record as the app's collection. Playlists (created, subscribed,
 * 红心, 雷达, detail) and albums (detail, subscribed) share the field names the docs show: id, name,
 * coverImgUrl, describe/description, trackCount, playCount, creatorNickName, artists, publishTime.
 */
export const normalizeOfficialCollection = (raw: unknown, type = 'playlist', extra: { isOwned?: boolean } = {}): ProviderCollection => {
    const record = asRecord(raw);
    const isAlbum = type === 'album';
    const artists = asList(record.artists)
        .map((item, index) => {
            const artist = asRecord(item);
            return { id: asId(artist.id, `artist-${index}`), name: asText(artist.name) };
        })
        .filter(artist => artist.name);
    const description = asText(record.describe) || asText(record.description) || asText(record.briefDesc);
    const trackCount = Number(record.trackCount ?? record.size);
    const playCount = Number(record.playCount);
    const publishedAt = Number(record.publishTime);
    const creatorName = asText(record.creatorNickName);
    const liked = !isAlbum && Number(record.specialType) === LIKED_SPECIAL_TYPE;
    return {
        providerId: 'netease',
        id: asText(record.id),
        name: asText(record.name),
        type,
        coverUrl: toHttps(record.coverImgUrl ?? record.picUrl),
        ...(description ? { description } : {}),
        ...(Number.isFinite(trackCount) && trackCount >= 0 && record.trackCount !== undefined ? { trackCount } : {}),
        ...(Number.isFinite(playCount) && playCount > 0 ? { playCount } : {}),
        ...(isAlbum && artists.length > 0 ? { artists } : {}),
        ...(isAlbum && Number.isFinite(publishedAt) && publishedAt > 0 ? { publishedAt } : {}),
        ...(isAlbum && asText(record.company) ? { publisher: asText(record.company) } : {}),
        ...(!isAlbum && creatorName ? { creator: { id: creatorName, nickname: creatorName, avatarUrl: toHttps(record.creatorAvatarUrl) } } : {}),
        ...(extra.isOwned ? { isOwned: true } : {}),
        ...(liked ? { isLiked: true } : {}),
    };
};
