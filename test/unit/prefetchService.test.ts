import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lyricsMock = vi.hoisted(() => vi.fn());
const hintsMock = vi.hoisted(() => vi.fn(async (_song?: unknown): Promise<unknown> => null));
const isExternalMock = vi.hoisted(() => vi.fn((_song?: unknown) => false));
const autoMatchMock = vi.hoisted(() => vi.fn());
const saveLyricsStateMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        canPlaySong: () => true,
        getAudioSource: vi.fn(async () => null),
        getLyrics: lyricsMock,
        getLyricMatchHints: hintsMock,
        isExternalPlaybackSong: isExternalMock,
    },
}));

vi.mock('@/services/onlineMusic/resourceCache', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/onlineMusic/resourceCache')>()),
    getSongCacheWithLegacyMigration: vi.fn(async () => null),
    hasCachedSongAudio: vi.fn(async () => false),
}));

vi.mock('@/utils/lyrics/autoMatchBestLyric', () => ({
    autoMatchBestLyric: autoMatchMock,
}));

vi.mock('@/utils/onlineLyricsState', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/onlineLyricsState')>()),
    loadOnlineLyricsState: vi.fn(async () => null),
    saveOnlineLyricsState: saveLyricsStateMock,
}));

vi.mock('@/services/automix/profileService', () => ({
    ensureTrackProfile: vi.fn(),
    setAnalysisScope: vi.fn(),
}));

import type { SongResult } from '@/types';
import { clearPrefetchRuntime, getPrefetchWindowKey, getPrefetchedData, prefetchNearbySongs, shouldRefreshPrefetchAfterQueueEdit, updatePrefetchedAudioUrl } from '@/services/prefetchService';

// test/unit/prefetchService.test.ts

const song: SongResult = {
    id: 'prefetch-song',
    name: 'Song',
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: 'prefetch-song' },
};

describe('prefetched online ReplayGain metadata', () => {
    beforeEach(() => clearPrefetchRuntime());

    it('keeps ReplayGain alongside a prefetched URL', () => {
        updatePrefetchedAudioUrl(song, 'https://audio.test/song.flac', 'high', {
            trackGain: -7.1,
            trackPeak: 0.9,
        });

        expect(getPrefetchedData(song, 'high')).toMatchObject({
            audioUrl: 'https://audio.test/song.flac',
            replayGain: { trackGain: -7.1, trackPeak: 0.9 },
        });
    });

    it('keeps the media-cache sentinel, which has no quality to mismatch', () => {
        // 'CACHED_IN_DB' says the bytes are already on disk. It is not a URL, so there is nothing
        // to re-fetch at a different quality - but the mismatch branch answered by nulling it,
        // and a cached track therefore reported itself as uncached the first time anything asked.
        updatePrefetchedAudioUrl(song, 'CACHED_IN_DB', 'standard');

        expect(getPrefetchedData(song, 'hires')).toMatchObject({ audioUrl: 'CACHED_IN_DB' });
    });

    it('invalidates URL metadata together on a quality mismatch', () => {
        updatePrefetchedAudioUrl(song, 'https://audio.test/song.flac', 'high', { trackGain: -7.1 });

        expect(getPrefetchedData(song, 'lossless')).toMatchObject({
            audioUrl: null,
            replayGain: undefined,
        });
    });
});

describe('prefetch window key', () => {
    const track = (id: string): SongResult => ({
        ...song,
        id,
        sourceRef: { kind: 'online', providerId: 'netease', mediaId: id },
    });
    const queue = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(track);

    it('changes only when the songs around the playing one change', () => {
        const current = queue[2];
        const window = getPrefetchWindowKey(current, queue);
        // 窗口（b c d e）外的编辑（把 g 挪到 f 前面）不需要重新预取。
        expect(getPrefetchWindowKey(current, [queue[0], queue[1], queue[2], queue[3], queue[4], queue[6], queue[5]])).toBe(window);
        // 下一首换了（把 f 挪到正在播放的下一首）就要。
        expect(getPrefetchWindowKey(current, [queue[0], queue[1], queue[2], queue[5], queue[3], queue[4], queue[6]])).not.toBe(window);
        // 上一首换了也要（「上一首」是预取的）。
        expect(getPrefetchWindowKey(current, [queue[1], queue[0], queue[2], queue[3], queue[4], queue[5], queue[6]])).not.toBe(window);
    });

    it('is empty when the playing song is not in the queue', () => {
        expect(getPrefetchWindowKey(track('z'), queue)).toBe('');
    });
});

describe('prefetch refresh after an in-place queue edit', () => {
    const track = (id: string): SongResult => ({
        ...song,
        id,
        sourceRef: { kind: 'online', providerId: 'netease', mediaId: id },
    });
    const queue = ['a', 'b', 'c', 'd', 'e', 'f'].map(track);
    const current = queue[1];

    it('refreshes only when the window around the playing song changed', () => {
        expect(shouldRefreshPrefetchAfterQueueEdit(current, queue, [queue[0], queue[1], queue[4], queue[2], queue[3], queue[5]])).toBe(true);
        expect(shouldRefreshPrefetchAfterQueueEdit(current, queue, [queue[0], queue[1], queue[2], queue[3], queue[5], queue[4]])).toBe(false);
        expect(shouldRefreshPrefetchAfterQueueEdit(current, queue, queue)).toBe(false);
        expect(shouldRefreshPrefetchAfterQueueEdit(null, queue, [...queue].reverse())).toBe(false);
    });

    it('leaves the prefetch alone when the playing song was removed from the queue', () => {
        // 新窗口键为空：invalidateAndRefetch 会删掉当前歌的预取、中止邻近预取又不重启，所以不刷新。
        expect(shouldRefreshPrefetchAfterQueueEdit(current, queue, queue.filter(item => item !== current))).toBe(false);
    });

    it('does not refresh a queue left with only the playing song', () => {
        expect(shouldRefreshPrefetchAfterQueueEdit(current, queue, [current])).toBe(false);
    });
});

describe('prefetch lyric auto-match with provider match hints', () => {
    const playing: SongResult = { ...song, id: 'playing', sourceRef: { kind: 'online', providerId: 'netease', mediaId: 'playing' } };
    const appleSong: SongResult = {
        id: 'apple-song',
        name: 'Wo De Ai Mei Qian Zou',
        artists: [{ id: 1, name: 'Nana Ou-Yang' }],
        album: { id: 2, name: 'Wo De Ai Mei Qian Zou' },
        durationMs: 199597,
        sourceRef: { kind: 'online', providerId: 'apple-music', mediaId: '0123456789ABCDEF' },
    };
    const parsed = { lines: [{ startTime: 0, endTime: 1, fullText: 'line', words: [] }], isWordByWord: false };
    const hints = { title: '我的爱没前奏', artist: '欧阳娜娜', album: '我的爱没前奏' };

    // Runs one prefetch pass over the song after the playing one; the idle-callback fallback is a 100 ms timer.
    const prefetchApple = async () => {
        await prefetchNearbySongs(playing, [playing, appleSong], 'high');
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(0);
    };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('window', {});
        clearPrefetchRuntime();
        vi.clearAllMocks();
        isExternalMock.mockReset();
        isExternalMock.mockImplementation(candidate => (candidate as SongResult | undefined)?.id === appleSong.id);
        lyricsMock.mockResolvedValue({ lyrics: null, isPureMusic: false });
        hintsMock.mockReset();
        hintsMock.mockResolvedValue(hints);
        autoMatchMock.mockReset();
    });

    afterEach(() => {
        clearPrefetchRuntime();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('searches with the hinted names first and keeps the lyrics it finds', async () => {
        autoMatchMock.mockResolvedValue({ id: 1, source: 'qq', lyrics: parsed, isPureMusic: false });
        await prefetchApple();
        expect(hintsMock).toHaveBeenCalledWith(appleSong);
        expect(autoMatchMock).toHaveBeenCalledTimes(1);
        expect(autoMatchMock).toHaveBeenCalledWith('我的爱没前奏', '欧阳娜娜', 199597, expect.objectContaining({ album: '我的爱没前奏' }));
        expect(getPrefetchedData(appleSong)?.lyrics).toEqual(parsed);
    });

    it('falls back to the library names when the hinted search finds nothing', async () => {
        autoMatchMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 2, source: 'netease', lyrics: parsed, isPureMusic: false });
        await prefetchApple();
        expect(autoMatchMock).toHaveBeenCalledTimes(2);
        expect(autoMatchMock).toHaveBeenNthCalledWith(2, 'Wo De Ai Mei Qian Zou', 'Nana Ou-Yang', 199597, expect.objectContaining({ album: 'Wo De Ai Mei Qian Zou' }));
        expect(getPrefetchedData(appleSong)?.lyrics).toEqual(parsed);
    });

    it('searches once with the library names when the provider has no hints', async () => {
        hintsMock.mockResolvedValue(null);
        autoMatchMock.mockResolvedValue(null);
        await prefetchApple();
        expect(autoMatchMock).toHaveBeenCalledTimes(1);
        expect(autoMatchMock).toHaveBeenCalledWith('Wo De Ai Mei Qian Zou', 'Nana Ou-Yang', 199597, expect.objectContaining({ album: 'Wo De Ai Mei Qian Zou' }));
    });

    it('stops at an instrumental verdict reached by the hinted search', async () => {
        autoMatchMock.mockResolvedValueOnce({ isPureMusic: true }).mockResolvedValueOnce({ id: 2, source: 'netease', lyrics: parsed, isPureMusic: false });
        await prefetchApple();
        expect(autoMatchMock).toHaveBeenCalledTimes(1);
        expect(getPrefetchedData(appleSong)?.lyrics).toBeNull();
        expect(getPrefetchedData(appleSong)?.lyricRaw?.isPureMusic).toBe(true);
    });
});
