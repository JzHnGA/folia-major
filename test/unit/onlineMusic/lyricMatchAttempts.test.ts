import { describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import { buildLyricMatchAttempts, runLyricMatchAttempts } from '@/services/onlineMusic/lyricMatchAttempts';

// test/unit/onlineMusic/lyricMatchAttempts.test.ts

const song: SongResult = {
    id: 'ABCDEF0123456789',
    name: 'Wo De Ai Mei Qian Zou',
    artists: [{ id: 'artist:Nana Ou-Yang', name: 'Nana Ou-Yang' }],
    album: { id: 'album', name: 'Single Album' },
    durationMs: 199597,
    sourceRef: { kind: 'online', providerId: 'apple-music', mediaId: 'ABCDEF0123456789' },
};
const original = { title: 'Wo De Ai Mei Qian Zou', artist: 'Nana Ou-Yang', album: 'Single Album', durationMs: 199597 };

describe('buildLyricMatchAttempts', () => {
    it('is a single attempt with the song names when there are no hints', () => {
        expect(buildLyricMatchAttempts(song)).toEqual([original]);
        expect(buildLyricMatchAttempts(song, undefined)).toEqual([original]);
        expect(buildLyricMatchAttempts(song, {})).toEqual([original]);
    });

    it('puts the hinted names first and the song names second', () => {
        const attempts = buildLyricMatchAttempts(song, { title: '我的爱没前奏', artist: '欧阳娜娜', album: '我的爱没前奏' });
        expect(attempts).toEqual([
            { title: '我的爱没前奏', artist: '欧阳娜娜', album: '我的爱没前奏', durationMs: 199597 },
            original,
        ]);
    });

    it('fills the names a hint lacks from the song', () => {
        expect(buildLyricMatchAttempts(song, { title: '我的爱没前奏' })).toEqual([
            { title: '我的爱没前奏', artist: 'Nana Ou-Yang', album: 'Single Album', durationMs: 199597 },
            original,
        ]);
    });

    it('is a single attempt when the hints equal the song names', () => {
        expect(buildLyricMatchAttempts(song, { title: original.title, artist: original.artist, album: original.album })).toEqual([original]);
        expect(buildLyricMatchAttempts(song, { title: original.title })).toEqual([original]);
    });

    it('joins several artists the way the matcher always received them', () => {
        const duo: SongResult = { ...song, artists: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] };
        expect(buildLyricMatchAttempts(duo)[0].artist).toBe('A, B');
    });
});

describe('runLyricMatchAttempts', () => {
    const attempts = buildLyricMatchAttempts(song, { title: '我的爱没前奏' });
    const hit = { lyrics: { lines: [], isWordByWord: false }, source: 'qq' as const };
    const accepts = (value: object) => 'lyrics' in value;

    it('stops at the first attempt the caller accepts', async () => {
        const run = vi.fn(async () => hit);
        expect(await runLyricMatchAttempts(attempts, run, accepts)).toBe(hit);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(attempts[0]);
    });

    it('moves on to the next attempt when the first is not accepted', async () => {
        const run = vi.fn(async (attempt: typeof attempts[number]) => (attempt === attempts[0] ? null : hit));
        expect(await runLyricMatchAttempts(attempts, run, accepts)).toBe(hit);
        expect(run).toHaveBeenCalledTimes(2);
        expect(run).toHaveBeenLastCalledWith(attempts[1]);
    });

    it('keeps the first answer that is not a match when no attempt is accepted', async () => {
        const pureMusic = { isPureMusic: true as const };
        const run = vi.fn(async (attempt: typeof attempts[number]) => (attempt === attempts[0] ? pureMusic : null));
        expect(await runLyricMatchAttempts(attempts, run, accepts)).toBe(pureMusic);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('returns null when nothing answers', async () => {
        expect(await runLyricMatchAttempts(attempts, async () => null, accepts)).toBeNull();
    });

    it('tries the song names even when the hinted attempt fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const run = vi.fn(async (attempt: typeof attempts[number]) => {
            if (attempt === attempts[0]) throw new Error('boom');
            return hit;
        });
        expect(await runLyricMatchAttempts(attempts, run, accepts)).toBe(hit);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('lets an error from the last attempt reach the caller, as an error always did', async () => {
        const run = vi.fn(async () => { throw new Error('boom'); });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await expect(runLyricMatchAttempts(attempts, run, accepts)).rejects.toThrow('boom');
        expect(run).toHaveBeenCalledTimes(2);
    });
});
