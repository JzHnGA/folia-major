import * as OpenCC from 'opencc-js';

// src/services/onlineMusic/appleMusicCatalogLookup.ts

export interface AppleMusicMatchHints {
    title?: string;
    artist?: string;
    album?: string;
}

export interface AppleMusicLookupSong {
    id: string;
    name: string;
    artist: string;
    durationMs: number;
}

const CATALOG_SEARCH_URL = 'https://itunes.apple.com/search';
// The Taiwan storefront returns the Chinese names Music.app's own library often lacks; the mainland one returns nothing.
const CATALOG_COUNTRY = 'tw';
const CATALOG_LIMIT = 10;
const LOOKUP_TIMEOUT_MS = 5000;
// A catalog row is the same recording only if its length agrees with the library's to within a second.
const DURATION_TOLERANCE_MS = 1000;

const t2sConverter = OpenCC.Converter({ from: 't', to: 'cn' });

// Per song, the in-flight or settled answer; a lookup that failed is evicted so a later play can retry.
const hintCache = new Map<string, Promise<AppleMusicMatchHints | null>>();

const cleanName = (value: unknown): string => (typeof value === 'string' ? t2sConverter(value.trim()) : '');

// Apple names single and EP releases "<title> - Single" / "<title> - EP"; the suffix is never part of a lyric site's album name.
export const stripAppleReleaseSuffix = (album: string): string => album.replace(/\s+-\s+(?:Single|EP)\s*$/i, '').trim();

const cleanAlbumName = (value: unknown): string => (
    typeof value === 'string' ? t2sConverter(stripAppleReleaseSuffix(value)) : ''
);

// Takes the catalog row whose duration is closest to the library's (within the tolerance) and turns it into simplified-Chinese match hints.
function pickHints(results: unknown[], durationMs: number): AppleMusicMatchHints | null {
    let best: Record<string, unknown> | null = null;
    let bestGap = Infinity;
    for (const item of results) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const length = row.trackTimeMillis;
        if (typeof length !== 'number' || !Number.isFinite(length)) continue;
        const gap = Math.abs(length - durationMs);
        if (gap <= DURATION_TOLERANCE_MS && gap < bestGap) {
            best = row;
            bestGap = gap;
        }
    }
    if (!best) return null;
    const title = cleanName(best.trackName);
    const artist = cleanName(best.artistName);
    const album = cleanAlbumName(best.collectionName);
    if (!title && !artist && !album) return null;
    return { ...(title ? { title } : {}), ...(artist ? { artist } : {}), ...(album ? { album } : {}) };
}

// Searches the public catalog once; a failed request throws, while an answer with no usable row settles as null.
async function requestHints(song: AppleMusicLookupSong, fetchImpl: typeof fetch): Promise<AppleMusicMatchHints | null> {
    const url = new URL(CATALOG_SEARCH_URL);
    url.searchParams.set('term', `${song.name} ${song.artist}`.trim());
    url.searchParams.set('entity', 'song');
    url.searchParams.set('country', CATALOG_COUNTRY);
    url.searchParams.set('limit', String(CATALOG_LIMIT));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url.toString(), { signal: controller.signal });
        if (!response.ok) throw new Error(`catalog answered ${response.status}`);
        const body = await response.json() as { results?: unknown };
        if (!Array.isArray(body?.results)) throw new Error('catalog answer has no results');
        return pickHints(body.results, song.durationMs);
    } finally {
        clearTimeout(timer);
    }
}

// Looks a Music.app song up in Apple's public catalog and returns its localized title, artist and album as simplified Chinese.
// Never throws: any failure (network, timeout, bad answer) is null, and only settled answers are cached per song id.
export function lookupAppleMusicMatchHints(
    song: AppleMusicLookupSong,
    fetchImpl: typeof fetch = fetch,
): Promise<AppleMusicMatchHints | null> {
    const cached = hintCache.get(song.id);
    if (cached) return cached;
    // Without a duration nothing can confirm a catalog row is this recording.
    if (!Number.isFinite(song.durationMs) || song.durationMs <= 0) return Promise.resolve(null);
    const pending = requestHints(song, fetchImpl).catch(error => {
        if (hintCache.get(song.id) === pending) hintCache.delete(song.id);
        console.warn('[AppleMusicCatalog] Lookup failed; matching with the library names', error);
        return null;
    });
    hintCache.set(song.id, pending);
    return pending;
}
