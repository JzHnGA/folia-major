import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/appleMusicCatalogLookup.test.ts
// Drives the Apple catalog lookup through an injected fetch; nothing here touches the network.

type CatalogRow = { trackName?: string; artistName?: string; collectionName?: string; trackTimeMillis?: number };

const song = { id: 'ABCDEF0123456789', name: 'Wo De Ai Mei Qian Zou', artist: 'Nana Ou-Yang', durationMs: 199597 };
const row = (overrides: CatalogRow = {}): CatalogRow => ({
    trackName: '我的愛沒前奏', artistName: '歐陽娜娜', collectionName: '我的愛沒前奏 - Single', trackTimeMillis: 199597, ...overrides,
});

const respond = (results: CatalogRow[], init: { ok?: boolean; status?: number } = {}) => vi.fn(async (_input: unknown, _init?: unknown) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => ({ resultCount: results.length, results }),
}));

// Fresh module graph per test: the lookup keeps a per-song cache.
const load = async () => (await import('@/services/onlineMusic/appleMusicCatalogLookup')).lookupAppleMusicMatchHints;
const asFetch = (mock: ReturnType<typeof respond>) => mock as unknown as typeof fetch;

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Apple catalog lookup request', () => {
    it('asks the Taiwan song catalog for ten rows with the title and artist as the term', async () => {
        const lookup = await load();
        const fetchMock = respond([row()]);
        await lookup(song, asFetch(fetchMock));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = new URL(String(fetchMock.mock.calls[0][0]));
        expect(`${url.origin}${url.pathname}`).toBe('https://itunes.apple.com/search');
        expect(url.searchParams.get('term')).toBe('Wo De Ai Mei Qian Zou Nana Ou-Yang');
        expect(url.searchParams.get('entity')).toBe('song');
        expect(url.searchParams.get('country')).toBe('tw');
        expect(url.searchParams.get('limit')).toBe('10');
    });
});

describe('Apple catalog lookup matching', () => {
    it('only accepts a row whose duration is within one second of the library duration', async () => {
        const lookup = await load();
        expect(await lookup({ ...song, id: 'a' }, asFetch(respond([row({ trackTimeMillis: 199597 + 1000 })])))).toMatchObject({ title: '我的爱没前奏' });
        expect(await lookup({ ...song, id: 'b' }, asFetch(respond([row({ trackTimeMillis: 199597 - 1000 })])))).toMatchObject({ title: '我的爱没前奏' });
        expect(await lookup({ ...song, id: 'c' }, asFetch(respond([row({ trackTimeMillis: 199597 + 1001 })])))).toBeNull();
        expect(await lookup({ ...song, id: 'd' }, asFetch(respond([row({ trackTimeMillis: 199597 - 1001 })])))).toBeNull();
    });

    it('ignores rows without a usable duration', async () => {
        const lookup = await load();
        const rows = [row({ trackTimeMillis: undefined }), row({ trackTimeMillis: Number.NaN })];
        expect(await lookup(song, asFetch(respond(rows)))).toBeNull();
    });

    it('takes the row whose duration is closest when several qualify', async () => {
        const lookup = await load();
        const rows = [
            row({ trackName: '遠', trackTimeMillis: 199597 + 900 }),
            row({ trackName: '近', trackTimeMillis: 199597 + 40 }),
            row({ trackName: '中', trackTimeMillis: 199597 - 300 }),
        ];
        expect((await lookup(song, asFetch(respond(rows))))?.title).toBe('近');
    });

    it('returns null when the catalog has no rows', async () => {
        const lookup = await load();
        expect(await lookup(song, asFetch(respond([])))).toBeNull();
    });

    it('does not look anything up for a song without a duration to verify against', async () => {
        const lookup = await load();
        const fetchMock = respond([row()]);
        expect(await lookup({ ...song, durationMs: 0 }, asFetch(fetchMock))).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('Apple catalog lookup names', () => {
    it('drops the Single and EP suffix from the album name', async () => {
        const lookup = await load();
        expect((await lookup({ ...song, id: 'a' }, asFetch(respond([row({ collectionName: '我的愛沒前奏 - Single' })]))))?.album).toBe('我的爱没前奏');
        expect((await lookup({ ...song, id: 'b' }, asFetch(respond([row({ collectionName: '愛的練習 - EP' })]))))?.album).toBe('爱的练习');
        expect((await lookup({ ...song, id: 'c' }, asFetch(respond([row({ collectionName: 'Greatest Hits' })]))))?.album).toBe('Greatest Hits');
    });

    it('converts the title, artist and album from traditional to simplified Chinese', async () => {
        const lookup = await load();
        const hints = await lookup(song, asFetch(respond([row({ trackName: '我愛的女孩', artistName: '歐陽娜娜', collectionName: '我愛的女孩 - Single' })])));
        expect(hints).toEqual({ title: '我爱的女孩', artist: '欧阳娜娜', album: '我爱的女孩' });
    });

    it('leaves out the names the catalog row does not carry', async () => {
        const lookup = await load();
        const hints = await lookup(song, asFetch(respond([row({ collectionName: undefined, artistName: '' })])));
        expect(hints).toEqual({ title: '我的爱没前奏' });
    });
});

describe('Apple catalog lookup cache', () => {
    it('answers the same song id from memory', async () => {
        const lookup = await load();
        const fetchMock = respond([row()]);
        const first = await lookup(song, asFetch(fetchMock));
        const second = await lookup(song, asFetch(fetchMock));
        expect(second).toEqual(first);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('remembers a song the catalog does not know', async () => {
        const lookup = await load();
        const fetchMock = respond([]);
        expect(await lookup(song, asFetch(fetchMock))).toBeNull();
        expect(await lookup(song, asFetch(fetchMock))).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('asks again for a different song id', async () => {
        const lookup = await load();
        const fetchMock = respond([row()]);
        await lookup(song, asFetch(fetchMock));
        await lookup({ ...song, id: '0123456789ABCDEF' }, asFetch(fetchMock));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('shares one request between concurrent lookups of the same song', async () => {
        const lookup = await load();
        const fetchMock = respond([row()]);
        await Promise.all([lookup(song, asFetch(fetchMock)), lookup(song, asFetch(fetchMock))]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('Apple catalog lookup failures', () => {
    it('returns null when the request fails', async () => {
        const lookup = await load();
        const fetchMock = vi.fn(async () => { throw new TypeError('network down'); });
        expect(await lookup(song, fetchMock as unknown as typeof fetch)).toBeNull();
    });

    it('returns null for a non-200 answer', async () => {
        const lookup = await load();
        expect(await lookup(song, asFetch(respond([row()], { ok: false, status: 503 })))).toBeNull();
    });

    it('returns null when the answer cannot be parsed', async () => {
        const lookup = await load();
        const broken = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }));
        expect(await lookup(song, broken as unknown as typeof fetch)).toBeNull();
        const shapeless = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: 'nope' }) }));
        expect(await lookup({ ...song, id: 'other' }, shapeless as unknown as typeof fetch)).toBeNull();
    });

    it('does not remember a failure, so the next play can try again', async () => {
        const lookup = await load();
        const failing = vi.fn(async () => { throw new TypeError('network down'); });
        expect(await lookup(song, failing as unknown as typeof fetch)).toBeNull();
        expect(await lookup(song, asFetch(respond([row()])))).toMatchObject({ title: '我的爱没前奏' });
    });

    it('gives up after five seconds by aborting the request', async () => {
        vi.useFakeTimers();
        const lookup = await load();
        let signal: AbortSignal | undefined;
        const hanging = vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
            signal = init?.signal;
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const pending = lookup(song, hanging as unknown as typeof fetch);
        await vi.advanceTimersByTimeAsync(4999);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal?.aborted).toBe(true);
        expect(await pending).toBeNull();
    });
});
