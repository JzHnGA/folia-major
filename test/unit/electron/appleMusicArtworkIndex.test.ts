import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/electron/appleMusicArtworkIndex.test.ts — Music track -> cover asset index: tolerant load, cap, recency and debounced writes.

const require = createRequire(import.meta.url);
const { createArtworkIndex } = require('../../../electron/appleMusic/artworkIndex.cjs');

const DEBOUNCE_MS = 1000;

function setup(options: { stored?: unknown; readThrows?: boolean; limit?: number; writeThrows?: boolean } = {}) {
    const write = vi.fn((_entries: Record<string, string>) => {
        if (options.writeThrows) throw new Error('disk full');
    });
    const read = vi.fn(() => {
        if (options.readThrows) throw new Error('ENOENT');
        return options.stored;
    });
    const index = createArtworkIndex({ read, write, limit: options.limit, debounceMs: DEBOUNCE_MS });
    return { index, read, write };
}

describe('createArtworkIndex', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('loads the stored entries lazily and only once', () => {
        const { index, read } = setup({ stored: { A: 'sha256:a' } });
        expect(read).not.toHaveBeenCalled();
        expect(index.get('A')).toBe('sha256:a');
        expect(index.get('B')).toBeUndefined();
        expect(read).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['an array', ['sha256:a']],
        ['a string', 'garbage'],
        ['null', null],
        ['undefined', undefined],
    ])('starts empty when the stored value is %s', (_label, stored) => {
        const { index } = setup({ stored });
        expect(index.get('A')).toBeUndefined();
        index.set('A', 'sha256:a');
        expect(index.get('A')).toBe('sha256:a');
    });

    it('starts empty when reading throws', () => {
        const { index } = setup({ readThrows: true });
        expect(index.get('A')).toBeUndefined();
    });

    it('drops stored values that are not strings', () => {
        const { index } = setup({ stored: { A: 'sha256:a', B: 7, C: null, D: { id: 'x' }, E: 'sha256:e' } });
        expect(index.get('A')).toBe('sha256:a');
        expect(index.get('B')).toBeUndefined();
        expect(index.get('C')).toBeUndefined();
        expect(index.get('D')).toBeUndefined();
        expect(index.get('E')).toBe('sha256:e');
    });

    it('evicts the least recently set entry once the cap is exceeded', () => {
        const { index, write } = setup({ limit: 3 });
        index.set('A', 'a');
        index.set('B', 'b');
        index.set('C', 'c');
        index.set('D', 'd');
        expect(index.get('A')).toBeUndefined();
        expect(index.get('B')).toBe('b');
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(write).toHaveBeenCalledWith({ B: 'b', C: 'c', D: 'd' });
    });

    it('trims an oversized stored index to the cap, oldest first', () => {
        const { index } = setup({ limit: 2, stored: { A: 'a', B: 'b', C: 'c' } });
        expect(index.get('A')).toBeUndefined();
        expect(index.get('B')).toBe('b');
        expect(index.get('C')).toBe('c');
    });

    it('makes a re-set key the most recent one', () => {
        const { index, write } = setup({ limit: 3 });
        index.set('A', 'a');
        index.set('B', 'b');
        index.set('C', 'c');
        index.set('A', 'a2');
        index.set('D', 'd');
        expect(index.get('A')).toBe('a2');
        expect(index.get('B')).toBeUndefined();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(Object.keys(write.mock.calls[0][0])).toEqual(['C', 'A', 'D']);
    });

    it('does not schedule a write when the value is unchanged', () => {
        const { index, write } = setup({ stored: { A: 'a' } });
        index.set('A', 'a');
        vi.advanceTimersByTime(DEBOUNCE_MS * 5);
        expect(write).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not move a key whose value is unchanged', () => {
        const { index, write } = setup({ limit: 2 });
        index.set('A', 'a');
        index.set('B', 'b');
        vi.advanceTimersByTime(DEBOUNCE_MS);
        index.set('A', 'a');
        index.set('C', 'c');
        expect(index.get('A')).toBeUndefined();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(write).toHaveBeenLastCalledWith({ B: 'b', C: 'c' });
    });

    it('coalesces many sets inside the debounce window into one write with the final object', () => {
        const { index, write } = setup();
        index.set('A', 'a');
        vi.advanceTimersByTime(DEBOUNCE_MS / 2);
        index.set('B', 'b');
        index.set('A', 'a2');
        index.set('C', 'c');
        expect(write).not.toHaveBeenCalled();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith({ B: 'b', A: 'a2', C: 'c' });
        vi.advanceTimersByTime(DEBOUNCE_MS * 5);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('schedules a fresh write for a change made after the previous write', () => {
        const { index, write } = setup();
        index.set('A', 'a');
        vi.advanceTimersByTime(DEBOUNCE_MS);
        index.set('B', 'b');
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(write).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenLastCalledWith({ A: 'a', B: 'b' });
    });

    it('flush writes a pending change immediately and cancels the timer', () => {
        const { index, write } = setup();
        index.set('A', 'a');
        index.flush();
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith({ A: 'a' });
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(DEBOUNCE_MS * 5);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('flush does nothing when no write is pending', () => {
        const { index, write, read } = setup({ stored: { A: 'a' } });
        index.flush();
        expect(write).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        index.set('B', 'b');
        index.flush();
        index.flush();
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('clear empties the index and writes {} immediately without reading the old file', () => {
        const { index, write, read } = setup({ stored: { A: 'a' } });
        index.clear();
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith({});
        expect(read).not.toHaveBeenCalled();
        expect(index.get('A')).toBeUndefined();
    });

    it('clear cancels a pending write and drops loaded entries', () => {
        const { index, write } = setup();
        index.set('A', 'a');
        index.clear();
        vi.advanceTimersByTime(DEBOUNCE_MS * 5);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith({});
        expect(index.get('A')).toBeUndefined();
    });

    it('never throws out of set, flush or clear when the write fails', () => {
        const { index, write } = setup({ writeThrows: true });
        index.set('A', 'a');
        expect(() => vi.advanceTimersByTime(DEBOUNCE_MS)).not.toThrow();
        index.set('B', 'b');
        expect(() => index.flush()).not.toThrow();
        expect(() => index.clear()).not.toThrow();
        expect(write).toHaveBeenCalledTimes(3);
        expect(console.warn).toHaveBeenCalled();
        expect(index.get('B')).toBeUndefined();
    });

    it('keeps serving the in-memory entry when a write failed', () => {
        const { index } = setup({ writeThrows: true });
        index.set('A', 'a');
        index.flush();
        expect(index.get('A')).toBe('a');
    });
});
