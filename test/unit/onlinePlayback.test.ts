import { beforeEach, describe, expect, it, vi } from 'vitest';

const cachedAudioMock = vi.hoisted(() => vi.fn());
const songCacheMock = vi.hoisted(() => vi.fn());
const sourceMock = vi.hoisted(() => vi.fn());
const lyricsMock = vi.hoisted(() => vi.fn());
const autoMatchMock = vi.hoisted(() => vi.fn());
const loadLyricsStateMock = vi.hoisted(() => vi.fn());
const saveLyricsStateMock = vi.hoisted(() => vi.fn());
const isUrlValidMock = vi.hoisted(() => vi.fn(() => true));
const updatePrefetchedAudioUrlMock = vi.hoisted(() => vi.fn());
const isExternalMock = vi.hoisted(() => vi.fn((_song?: unknown) => false));
const hintsMock = vi.hoisted(() => vi.fn(async (_song?: unknown): Promise<unknown> => null));
// The settings store mock reads this object, so a test flips one field instead of re-mocking the store.
const lyricSettings = vi.hoisted(() => ({ autoUseBestLyric: true, preferredAlternativeLyricSource: 'qq' }));

vi.mock('@/services/onlineMusic/resourceCache', () => ({
    getCachedSongAudioBlob: cachedAudioMock,
    getSongCacheWithLegacyMigration: songCacheMock,
}));

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        getAudioSource: sourceMock,
        getLyrics: lyricsMock,
        isExternalPlaybackSong: isExternalMock,
        getLyricMatchHints: hintsMock,
    },
}));

vi.mock('@/stores/useLyricSettingsStore', () => ({
    useLyricSettingsStore: {
        getState: () => lyricSettings,
    },
}));

vi.mock('@/utils/lyrics/autoMatchBestLyric', () => ({
    autoMatchBestLyric: autoMatchMock,
}));

// Spread the real module so markOnlineLyricsPureMusic stays real - the shape it writes is the
// thing under test, and a stubbed one would assert nothing.
vi.mock('@/utils/onlineLyricsState', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/onlineLyricsState')>()),
    loadOnlineLyricsState: loadLyricsStateMock,
    resolveOnlineLyrics: (_state: unknown, lyrics: unknown) => lyrics,
    saveOnlineLyricsState: saveLyricsStateMock,
}));

vi.mock('@/services/prefetchService', () => ({
    isUrlValid: isUrlValidMock,
    updatePrefetchedAudioUrl: updatePrefetchedAudioUrlMock,
}));

vi.mock('@/services/db', () => ({
    saveToCache: vi.fn(),
}));

vi.mock('@/utils/blobGuards', () => ({
    createSafeObjectUrl: vi.fn(() => 'blob:test'),
}));

import { loadOnlineSongAudioSource, loadOnlineSongLyrics } from '@/services/onlinePlayback';
import { markOnlineLyricsPureMusic } from '@/utils/onlineLyricsState';
import type { SongResult } from '@/types';
import { OnlineProviderError } from '@/types/onlineMusic';

// test/unit/onlinePlayback.test.ts

// Runs before every describe's own beforeEach, so neither the external-song flag nor the lyric
// settings can leak from one describe into the next (mockClear alone keeps a mockReturnValue).
beforeEach(() => {
    isExternalMock.mockReset();
    isExternalMock.mockReturnValue(false);
    hintsMock.mockReset();
    hintsMock.mockResolvedValue(null);
    lyricSettings.autoUseBestLyric = true;
    lyricSettings.preferredAlternativeLyricSource = 'qq';
});

const song: SongResult = {
    id: 'online-song',
    name: 'Song',
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'kugou', mediaId: 'online-song' },
};

describe('online audio ReplayGain plumbing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cachedAudioMock.mockResolvedValue(null);
        isUrlValidMock.mockReturnValue(true);
        isExternalMock.mockReturnValue(false);
    });

    it.each(['preview-only', 'region-restricted', 'auth-required'] as const)('preserves %s for the queue and does not cache audio', async reason => {
        sourceMock.mockRejectedValueOnce(new OnlineProviderError(reason, 'Playback unavailable', 'bodian'));
        await expect(loadOnlineSongAudioSource(song, 'high', null)).resolves.toEqual({ kind: 'unavailable', reason });
        expect(updatePrefetchedAudioUrlMock).not.toHaveBeenCalled();
    });

    it('returns provider metadata and stores it with the prefetched URL', async () => {
        sourceMock.mockResolvedValue({
            url: 'https://audio.test/song.flac',
            fetchedAt: 1,
            quality: 'high',
            replayGain: { trackGain: -12.1, trackPeak: 0.95 },
        });

        const result = await loadOnlineSongAudioSource(song, 'high', null);

        expect(result).toMatchObject({
            kind: 'ok',
            audioSrc: 'https://audio.test/song.flac',
            replayGain: { trackGain: -12.1, trackPeak: 0.95 },
        });
        expect(updatePrefetchedAudioUrlMock).toHaveBeenCalledWith(
            song,
            'https://audio.test/song.flac',
            'high',
            { trackGain: -12.1, trackPeak: 0.95 },
        );
    });

    it('reuses prefetched metadata without asking the provider again', async () => {
        const prefetched = {
            audioUrl: 'https://audio.test/prefetched.flac',
            audioUrlFetchedAt: Date.now(),
            replayGain: { trackGain: -3.2 },
        } as any;

        const result = await loadOnlineSongAudioSource(song, 'high', prefetched);

        expect(result).toMatchObject({
            kind: 'ok',
            audioSrc: 'https://audio.test/prefetched.flac',
            replayGain: { trackGain: -3.2 },
        });
        expect(sourceMock).not.toHaveBeenCalled();
    });

    it('leaves ReplayGain absent when the provider has no metadata', async () => {
        sourceMock.mockResolvedValue({
            url: 'https://audio.test/song.mp3',
            fetchedAt: 1,
            quality: 'high',
        });

        const result = await loadOnlineSongAudioSource(song, 'high', null);

        expect(result).toMatchObject({ kind: 'ok', audioSrc: 'https://audio.test/song.mp3' });
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.replayGain).toBeUndefined();
        }
        expect(updatePrefetchedAudioUrlMock).toHaveBeenCalledWith(song, 'https://audio.test/song.mp3', 'high', undefined);
    });

    it('hands an external carrier back as a blob to revoke and never stores it as a prefetched URL', async () => {
        isExternalMock.mockReturnValue(true);
        sourceMock.mockResolvedValue({ url: 'blob:carrier', fetchedAt: 1, quality: 'high' });

        const result = await loadOnlineSongAudioSource(song, 'high', null);

        expect(result).toEqual({ kind: 'ok', audioSrc: 'blob:carrier', blobUrl: 'blob:carrier', replayGain: undefined });
        expect(updatePrefetchedAudioUrlMock).not.toHaveBeenCalled();
    });
});

describe('online QQ lyric candidate plumbing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        songCacheMock.mockResolvedValue(null);
        loadLyricsStateMock.mockResolvedValue(null);
    });

    it('passes the already-loaded QQ song and lyrics to auto-match as its provider candidate', async () => {
        const qqSong: SongResult = {
            ...song,
            id: 201,
            qqMid: 'qq-mid',
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'qq-mid' },
        };
        const lyrics = {
            lines: [{ startTime: 0, endTime: 1, fullText: 'line', words: [] }],
            isWordByWord: true,
        };
        lyricsMock.mockResolvedValue({
            lyrics,
            mainText: '[00:00.00]line',
            wordByWordText: '[0,1000](0,1000,0)line',
            translationText: null,
            isPureMusic: false,
            chorusRanges: [],
        });
        autoMatchMock.mockResolvedValue({
            lyrics,
            source: 'qq',
            id: 201,
            qqMid: 'qq-mid',
            song: qqSong,
        });

        await loadOnlineSongLyrics(qqSong, null, null, {
            isCurrent: () => true,
            onLyrics: vi.fn(),
            onDone: vi.fn(),
        });

        expect(autoMatchMock).toHaveBeenCalledWith('Song', '', 1000, expect.objectContaining({
            preferredSource: 'qq',
            providerCandidate: expect.objectContaining({
                providerId: 'qq',
                song: qqSong,
                lyricsResult: expect.objectContaining({ lyrics, isPureMusic: false }),
            }),
        }));
        expect(saveLyricsStateMock).not.toHaveBeenCalled();
    });

    it('reports done before the auto-match search finishes, so audio never waits on it', async () => {
        // onDone is what releases playback. Auto-match asks every provider for a BETTER lyric file
        // and takes seconds when it finds none - an instrumental interlude matches nothing
        // anywhere. Holding the audio for an optional upgrade turned every such song change into
        // seconds of silence, and with a blended change the outgoing track has already ended by
        // then, so silence is all that is left.
        const lyrics = {
            lines: [{ startTime: 0, endTime: 1, fullText: 'line', words: [] }],
            isWordByWord: false,
        };
        lyricsMock.mockResolvedValue({
            lyrics,
            mainText: '[00:00.00]line',
            wordByWordText: null,
            translationText: null,
            isPureMusic: false,
            chorusRanges: [],
        });

        let finishAutoMatch = () => { };
        autoMatchMock.mockReturnValue(new Promise(resolve => {
            finishAutoMatch = () => resolve(null);
        }));

        const onDone = vi.fn();
        const onLyrics = vi.fn();
        const pending = loadOnlineSongLyrics(song, null, null, {
            isCurrent: () => true,
            onLyrics,
            onDone,
        });

        await vi.waitFor(() => expect(autoMatchMock).toHaveBeenCalled());

        // Still inside the search, and playback has already been let go.
        expect(onDone).toHaveBeenCalled();
        expect(onLyrics).toHaveBeenCalledWith(lyrics);

        finishAutoMatch();
        await pending;
    });
});

describe('instrumental tracks, once auto-match has settled them', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        songCacheMock.mockResolvedValue(null);
        loadLyricsStateMock.mockResolvedValue(null);
    });

    it('stores the verdict, so the search is not repeated on every play', async () => {
        // Without a stored answer `hasOnlineOverride` stays false, which is the flag that decides
        // whether to auto-match at all - so every instrumental in the library re-ran the full
        // QQ/NetEase/AMLLDB/Kugou search on every prefetch pass and every play, forever.
        lyricsMock.mockResolvedValue({
            lyrics: null,
            mainText: null,
            wordByWordText: null,
            translationText: null,
            isPureMusic: true,
            chorusRanges: [],
        });
        autoMatchMock.mockResolvedValue({ isPureMusic: true, source: 'netease', id: 1 });

        const onLyrics = vi.fn();
        await loadOnlineSongLyrics(song, null, null, {
            isCurrent: () => true,
            onLyrics,
            onDone: vi.fn(),
        });

        expect(saveLyricsStateMock).toHaveBeenCalledWith(song, expect.objectContaining({
            hasOnlineOverride: true,
            matchedIsPureMusic: true,
        }));
        expect(onLyrics).toHaveBeenCalledWith(null);
    });

    it('does not mistake a match from the track\'s own provider for an instrumental', async () => {
        // A MATCH object also carries `isPureMusic: false`, so the old `'isPureMusic' in bestMatch`
        // test was true for it too. A best match that came from the track's own provider fails the
        // override branch above, fell into this one, and had its perfectly good lyrics discarded.
        const lyrics = {
            lines: [{ startTime: 0, endTime: 1, fullText: 'line', words: [] }],
            isWordByWord: false,
        };
        lyricsMock.mockResolvedValue({
            lyrics,
            mainText: '[00:00.00]line',
            wordByWordText: null,
            translationText: null,
            isPureMusic: false,
            chorusRanges: [],
        });
        // song.sourceRef.providerId is 'kugou', so this is the same-provider case.
        autoMatchMock.mockResolvedValue({ lyrics, source: 'kugou', id: 'online-song', song, isPureMusic: false });

        const onLyrics = vi.fn();
        const onPureMusicChange = vi.fn();
        await loadOnlineSongLyrics(song, null, null, {
            isCurrent: () => true,
            onLyrics,
            onPureMusicChange,
            onDone: vi.fn(),
        });

        expect(onLyrics).toHaveBeenLastCalledWith(lyrics);
        expect(onPureMusicChange).not.toHaveBeenCalledWith(true);
        expect(saveLyricsStateMock).not.toHaveBeenCalled();
    });

    it('never takes an imported selection away from the listener', async () => {
        // A background auto-match can run over a track the listener imported lyrics for. Recording
        // the instrumental verdict must not replace their choice - resolveOnlineLyrics still
        // prefers the import.
        const imported = { lines: [], isWordByWord: false };
        const merged = markOnlineLyricsPureMusic({ lyricsSource: 'imported', importedLyrics: imported });

        expect(merged.lyricsSource).toBe('imported');
        expect(merged.importedLyrics).toBe(imported);
        expect(merged.matchedIsPureMusic).toBe(true);
    });
});

describe('lyric auto-match for external-playback songs', () => {
    const appleSong: SongResult = {
        id: 'apple-song',
        name: 'Apple Song',
        artists: [{ id: 1, name: 'Artist' }],
        album: { id: 2, name: 'Album' },
        durationMs: 215000,
        sourceRef: { kind: 'online', providerId: 'apple-music', mediaId: '0123456789ABCDEF' },
    };
    const neteaseSong: SongResult = {
        ...song,
        id: 'netease-song',
        sourceRef: { kind: 'online', providerId: 'netease', mediaId: 'netease-song' },
    };
    const parsedFixture = {
        lines: [{ startTime: 0, endTime: 1, fullText: 'line', words: [] }],
        isWordByWord: false,
    };
    const callbacks = {
        isCurrent: () => true,
        onLyrics: vi.fn(),
        onDone: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        songCacheMock.mockResolvedValue(null);
        loadLyricsStateMock.mockResolvedValue(null);
        // An ordinary provider song brings its own lyrics, so the "setting off" case has something to show.
        lyricsMock.mockResolvedValue({
            lyrics: parsedFixture,
            mainText: '[00:00.00]line',
            wordByWordText: null,
            translationText: null,
            isPureMusic: false,
            chorusRanges: [],
        });
    });

    it('auto-matches an external-playback song even when auto-use-best-lyric is off', async () => {
        lyricSettings.autoUseBestLyric = false;
        isExternalMock.mockReturnValue(true);
        lyricsMock.mockResolvedValue({ lyrics: null, isPureMusic: false });
        autoMatchMock.mockResolvedValue({ id: 1, source: 'qq', lyrics: parsedFixture, isPureMusic: false });
        await loadOnlineSongLyrics(appleSong, null, null, callbacks);
        expect(autoMatchMock).toHaveBeenCalledWith(appleSong.name, 'Artist', appleSong.durationMs, expect.objectContaining({ album: 'Album', providerCandidate: undefined }));
        expect(callbacks.onLyrics).toHaveBeenLastCalledWith(parsedFixture);
    });

    it('still respects the setting for ordinary provider songs', async () => {
        lyricSettings.autoUseBestLyric = false;
        isExternalMock.mockReturnValue(false);
        await loadOnlineSongLyrics(neteaseSong, null, null, callbacks);
        expect(autoMatchMock).not.toHaveBeenCalled();
    });

    it('keeps previously matched lyrics authoritative for an external song', async () => {
        // The cache early-return is untouched: a stored match is shown as-is, with no second search.
        lyricSettings.autoUseBestLyric = false;
        isExternalMock.mockReturnValue(true);
        songCacheMock.mockResolvedValue(parsedFixture);
        await loadOnlineSongLyrics(appleSong, null, null, callbacks);
        expect(autoMatchMock).not.toHaveBeenCalled();
        expect(callbacks.onLyrics).toHaveBeenLastCalledWith(parsedFixture);
    });
});

describe('lyric auto-match with provider match hints', () => {
    const appleSong: SongResult = {
        id: 'apple-song',
        name: 'Wo De Ai Mei Qian Zou',
        artists: [{ id: 1, name: 'Nana Ou-Yang' }],
        album: { id: 2, name: 'Wo De Ai Mei Qian Zou' },
        durationMs: 199597,
        sourceRef: { kind: 'online', providerId: 'apple-music', mediaId: '0123456789ABCDEF' },
    };
    const parsedFixture = {
        lines: [{ startTime: 0, endTime: 1, fullText: 'line', words: [] }],
        isWordByWord: false,
    };
    const hints = { title: '我的爱没前奏', artist: '欧阳娜娜', album: '我的爱没前奏' };
    const callbacks = {
        isCurrent: () => true,
        onLyrics: vi.fn(),
        onDone: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        songCacheMock.mockResolvedValue(null);
        loadLyricsStateMock.mockResolvedValue(null);
        isExternalMock.mockReturnValue(true);
        lyricsMock.mockResolvedValue({ lyrics: null, isPureMusic: false });
        hintsMock.mockResolvedValue(hints);
        autoMatchMock.mockReset();
    });

    it('searches with the hinted names first', async () => {
        autoMatchMock.mockResolvedValue({ id: 1, source: 'qq', lyrics: parsedFixture, isPureMusic: false });
        await loadOnlineSongLyrics(appleSong, null, null, callbacks);
        expect(hintsMock).toHaveBeenCalledWith(appleSong);
        expect(autoMatchMock).toHaveBeenCalledTimes(1);
        expect(autoMatchMock).toHaveBeenCalledWith('我的爱没前奏', '欧阳娜娜', 199597, expect.objectContaining({ album: '我的爱没前奏' }));
        expect(callbacks.onLyrics).toHaveBeenLastCalledWith(parsedFixture);
    });

    it('releases the audio before the hints have been looked up, and still matches with them afterwards', async () => {
        let resolveHints!: (value: typeof hints) => void;
        hintsMock.mockImplementation(() => new Promise(resolve => { resolveHints = resolve; }));
        autoMatchMock.mockResolvedValue({ id: 1, source: 'qq', lyrics: parsedFixture, isPureMusic: false });

        const loading = loadOnlineSongLyrics(appleSong, null, null, callbacks);
        await vi.waitFor(() => expect(hintsMock).toHaveBeenCalledTimes(1));
        // The lookup is still outstanding: playback was released and nothing has been searched yet.
        expect(callbacks.onDone).toHaveBeenCalledTimes(1);
        expect(autoMatchMock).not.toHaveBeenCalled();

        resolveHints(hints);
        await loading;
        expect(autoMatchMock).toHaveBeenCalledWith('我的爱没前奏', '欧阳娜娜', 199597, expect.objectContaining({ album: '我的爱没前奏' }));
        expect(callbacks.onLyrics).toHaveBeenLastCalledWith(parsedFixture);
    });

    it('never asks the provider for hints before it has released the audio', async () => {
        const order: string[] = [];
        callbacks.onDone.mockImplementation(() => { order.push('done'); });
        hintsMock.mockImplementation(async () => { order.push('hints'); return hints; });
        autoMatchMock.mockResolvedValue(null);
        await loadOnlineSongLyrics(appleSong, null, null, callbacks);
        expect(order.slice(0, 2)).toEqual(['done', 'hints']);
        callbacks.onDone.mockReset();
    });

    it('falls back to the song names when the hinted search finds nothing', async () => {
        autoMatchMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 2, source: 'netease', lyrics: parsedFixture, isPureMusic: false });
        await loadOnlineSongLyrics(appleSong, null, null, callbacks);
        expect(autoMatchMock).toHaveBeenCalledTimes(2);
        expect(autoMatchMock).toHaveBeenNthCalledWith(1, '我的爱没前奏', '欧阳娜娜', 199597, expect.objectContaining({ album: '我的爱没前奏' }));
        expect(autoMatchMock).toHaveBeenNthCalledWith(2, 'Wo De Ai Mei Qian Zou', 'Nana Ou-Yang', 199597, expect.objectContaining({ album: 'Wo De Ai Mei Qian Zou' }));
        expect(callbacks.onLyrics).toHaveBeenLastCalledWith(parsedFixture);
    });

    it('does not take lyrics the song\'s own provider answered as a match, and keeps searching', async () => {
        autoMatchMock
            .mockResolvedValueOnce({ id: 1, source: 'apple-music', lyrics: parsedFixture, isPureMusic: false })
            .mockResolvedValueOnce({ id: 2, source: 'kugou', lyrics: parsedFixture, isPureMusic: false });
        await loadOnlineSongLyrics(appleSong, null, null, callbacks);
        expect(autoMatchMock).toHaveBeenCalledTimes(2);
        expect(saveLyricsStateMock).toHaveBeenCalledWith(appleSong, expect.objectContaining({ matchedLyricsSource: 'kugou' }));
    });

    it('searches once with the song names when the provider has no hints', async () => {
        hintsMock.mockResolvedValue(null);
        autoMatchMock.mockResolvedValue(null);
        await loadOnlineSongLyrics(appleSong, null, null, callbacks);
        expect(autoMatchMock).toHaveBeenCalledTimes(1);
        expect(autoMatchMock).toHaveBeenCalledWith('Wo De Ai Mei Qian Zou', 'Nana Ou-Yang', 199597, expect.objectContaining({ album: 'Wo De Ai Mei Qian Zou' }));
    });

    it('searches once when the hints read the same as the song names, using the hinted album', async () => {
        hintsMock.mockResolvedValue({ title: 'wo de ai mei qian zou', artist: 'Nana Ou-Yang', album: 'Wo De Ai Mei Qian Zou (Single)' });
        autoMatchMock.mockResolvedValue(null);
        await loadOnlineSongLyrics(appleSong, null, null, callbacks);
        expect(autoMatchMock).toHaveBeenCalledTimes(1);
        expect(autoMatchMock).toHaveBeenCalledWith('Wo De Ai Mei Qian Zou', 'Nana Ou-Yang', 199597, expect.objectContaining({ album: 'Wo De Ai Mei Qian Zou (Single)' }));
    });

    it('stops at an instrumental verdict reached by the hinted search and records it', async () => {
        autoMatchMock.mockResolvedValueOnce({ isPureMusic: true }).mockResolvedValueOnce({ id: 2, source: 'kugou', lyrics: parsedFixture, isPureMusic: false });
        await loadOnlineSongLyrics(appleSong, null, null, callbacks);
        expect(autoMatchMock).toHaveBeenCalledTimes(1);
        expect(saveLyricsStateMock).toHaveBeenCalledWith(appleSong, markOnlineLyricsPureMusic(null));
    });
});
