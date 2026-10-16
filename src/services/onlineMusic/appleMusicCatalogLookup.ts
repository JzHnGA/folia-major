import * as OpenCC from 'opencc-js';
import { normalizeLyricMatchText } from '../../utils/lyrics/matchScore';

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
// A failed request (network, timeout, bad answer) is not asked again for this long; an answer that simply had no usable row is kept for good.
const FAILURE_CACHE_MS = 30_000;

const t2sConverter = OpenCC.Converter({ from: 't', to: 'cn' });

interface CacheEntry {
    pending: Promise<AppleMusicMatchHints | null>;
    // Set when the request failed; the entry then only suppresses retries until FAILURE_CACHE_MS has passed.
    failedAt?: number;
}

// Per song, the in-flight or settled answer.
const hintCache = new Map<string, CacheEntry>();

const cleanName = (value: unknown): string => (typeof value === 'string' ? t2sConverter(value.trim()) : '');

// Apple names single and EP releases "<title> - Single" / "<title> - EP"; the suffix is never part of a lyric site's album name.
export const stripAppleReleaseSuffix = (album: string): string => album.replace(/\s+-\s+(?:Single|EP)\s*$/i, '').trim();

const cleanAlbumName = (value: unknown): string => (
    typeof value === 'string' ? t2sConverter(stripAppleReleaseSuffix(value)) : ''
);

// True when two names share a text after normalization, either one inside the other; an empty name never overlaps.
const namesOverlap = (a: string, b: string): boolean => {
    const left = normalizeLyricMatchText(a);
    const right = normalizeLyricMatchText(b);
    return Boolean(left) && Boolean(right) && (left.includes(right) || right.includes(left));
};

// Picks the catalog row for the library song and turns it into simplified-Chinese match hints.
// Rows count only within the duration tolerance. One such row is taken as is; with several, the closest is taken only when its
// title or artist overlaps the library's, so an unrelated recording of the same length cannot steer the lyric search.
function pickHints(results: unknown[], song: AppleMusicLookupSong): AppleMusicMatchHints | null {
    const candidates: Array<{ row: Record<string, unknown>; gap: number }> = [];
    for (const item of results) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const length = row.trackTimeMillis;
        if (typeof length !== 'number' || !Number.isFinite(length)) continue;
        const gap = Math.abs(length - song.durationMs);
        if (gap <= DURATION_TOLERANCE_MS) candidates.push({ row, gap });
    }
    if (candidates.length === 0) return null;
    // Array.prototype.sort is stable, so equal gaps keep the catalog's own ranking.
    candidates.sort((a, b) => a.gap - b.gap);
    const best = candidates[0].row;
    const title = cleanName(best.trackName);
    const artist = cleanName(best.artistName);
    const album = cleanAlbumName(best.collectionName);
    if (candidates.length > 1 && !namesOverlap(title, song.name) && !namesOverlap(artist, song.artist)) return null;
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
        return pickHints(body.results, song);
    } finally {
        clearTimeout(timer);
    }
}

// Looks a Music.app song up in Apple's public catalog and returns its localized title, artist and album as simplified Chinese.
// Never throws: any failure (network, timeout, bad answer) is null. An answer is cached per song id - a failure for 30 s so a
// dead network is not asked again on every song change, "no usable row" for the rest of the session. `now` is injectable for tests.
export function lookupAppleMusicMatchHints(
    song: AppleMusicLookupSong,
    fetchImpl: typeof fetch = fetch,
    now: () => number = Date.now,
): Promise<AppleMusicMatchHints | null> {
    const cached = hintCache.get(song.id);
    if (cached && (cached.failedAt === undefined || now() - cached.failedAt < FAILURE_CACHE_MS)) return cached.pending;
    // Without a duration nothing can confirm a catalog row is this recording.
    if (!Number.isFinite(song.durationMs) || song.durationMs <= 0) return Promise.resolve(null);
    const entry: CacheEntry = {
        pending: requestHints(song, fetchImpl).catch(error => {
            entry.failedAt = now();
            console.warn('[AppleMusicCatalog] Lookup failed; matching with the library names', error);
            return null;
        }),
    };
    hintCache.set(song.id, entry);
    return entry.pending;
}
