import { afterEach, describe, expect, it, vi } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import { registerOnlineMusicProvider, unregisterOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import type { UnifiedSong } from '@/types';
import type { OnlineExternalPlaybackProvider, OnlineMusicProvider, ProviderCapabilities } from '@/types/onlineMusic';

// test/unit/onlineMusic/omniExternalPlayback.test.ts

const providerIds = ['ext-test', 'plain-test', 'half-test'];
const capabilities: ProviderCapabilities = {
    search: false, playback: true, lyrics: false, auth: false, userLibrary: false,
    playlists: false, albums: false, artists: false, recommendations: false,
    mutations: false, wordByWordLyrics: false,
};
const song = (owner: string, mediaId = '1'): UnifiedSong => ({
    id: mediaId,
    name: `${owner}:${mediaId}`,
    artists: [],
    album: { id: '', name: '' },
    durationMs: 1,
    sourceRef: { kind: 'online', providerId: owner, mediaId },
});

const engine = (): OnlineExternalPlaybackProvider => ({
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    setMonitoring: vi.fn(),
    subscribeState: vi.fn(() => () => undefined),
});

const plainProvider: OnlineMusicProvider = {
    id: 'plain-test',
    displayName: 'plain-test',
    capabilities,
    normalizeSong: raw => song('plain-test', String((raw as { id?: string }).id || '1')),
};

const externalProvider: OnlineMusicProvider = {
    ...plainProvider,
    id: 'ext-test',
    displayName: 'ext-test',
    capabilities: { ...capabilities, externalPlayback: true },
    externalPlayback: engine(),
};

afterEach(() => {
    providerIds.forEach(unregisterOnlineMusicProvider);
});

describe('omni external playback', () => {
    it('treats a song as external only when its provider declares externalPlayback and exposes an engine', () => {
        registerOnlineMusicProvider(externalProvider);
        registerOnlineMusicProvider(plainProvider);

        expect(omni.isExternalPlaybackSong(song('ext-test'))).toBe(true);
        expect(omni.isExternalPlaybackSong(song('plain-test'))).toBe(false);
        expect(omni.getExternalPlaybackEngine(song('ext-test'))).toBe(externalProvider.externalPlayback);
        expect(omni.getExternalPlaybackEngine(song('plain-test'))).toBeNull();
    });

    it('answers false and null for local, missing and unregistered songs instead of throwing', () => {
        expect(omni.isExternalPlaybackSong(null)).toBe(false);
        expect(omni.isExternalPlaybackSong(undefined)).toBe(false);
        expect(omni.isExternalPlaybackSong({ ...song('x'), sourceRef: { kind: 'local', mediaId: 'a' } })).toBe(false);
        expect(omni.isExternalPlaybackSong(song('not-registered'))).toBe(false);
        expect(omni.getExternalPlaybackEngine(song('not-registered'))).toBeNull();
    });

    it('does not treat a declared capability without an engine as external', () => {
        registerOnlineMusicProvider({ ...plainProvider, id: 'half-test', capabilities: { ...capabilities, externalPlayback: true } });

        expect(omni.isExternalPlaybackSong(song('half-test'))).toBe(false);
        expect(omni.getExternalPlaybackEngine(song('half-test'))).toBeNull();
    });

    it('does not treat an engine without the declared capability as external', () => {
        registerOnlineMusicProvider({ ...plainProvider, id: 'half-test', externalPlayback: engine() });

        expect(omni.isExternalPlaybackSong(song('half-test'))).toBe(false);
        expect(omni.getExternalPlaybackEngine(song('half-test'))).toBeNull();
    });
});
