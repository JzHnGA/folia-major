import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAudioSourceMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: { getAudioSource: getAudioSourceMock },
}));

import {
    carrierRegistry,
    createCarrierRegistry,
    createCarrierSlot,
    type CarrierRegistry,
} from '@/services/externalPlayback/carrierRegistry';
import type { SongResult } from '@/types';
import { OnlineProviderError } from '@/types/onlineMusic';

// test/unit/externalPlayback/carrierRegistry.test.ts
// The shared, reference-counted silent carrier per external song: one URL while held, revoked only after
// the last holder lets go and no deck still renders it.

const songOf = (id: string): SongResult => ({
    id,
    name: id,
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'apple', mediaId: id },
});
const APPLE = songOf('apple-a');
const OTHER = songOf('apple-b');

/** Lets every already-settled promise continuation run. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Mints `blob:<id>:<n>` with n counting across the registry's mints; revoke is recorded, nothing is on a deck. */
const makeDeps = () => {
    let minted = 0;
    return {
        create: vi.fn<(song: SongResult) => Promise<string>>(async song => `blob:${song.id}:${++minted}`),
        revoke: vi.fn<(url: string) => void>(),
        isInUse: vi.fn<(url: string) => boolean>(() => false),
    };
};

describe('createCarrierRegistry', () => {
    let deps: ReturnType<typeof makeDeps>;
    let registry: CarrierRegistry;

    beforeEach(() => {
        deps = makeDeps();
        registry = createCarrierRegistry(deps);
    });

    it('hands out one URL per song while it is held', async () => {
        const [a, b] = await Promise.all([registry.acquire(APPLE), registry.acquire(APPLE)]);
        expect(a).toBe(b);
        expect(deps.create).toHaveBeenCalledTimes(1);
        expect(registry.peek(APPLE)).toBe(a);
    });

    it('revokes only after the last release', async () => {
        const url = await registry.acquire(APPLE);
        await registry.acquire(APPLE);

        registry.release(APPLE);
        expect(deps.revoke).not.toHaveBeenCalled();
        expect(registry.owns(url)).toBe(true);

        registry.release(APPLE);
        expect(deps.revoke).toHaveBeenCalledExactlyOnceWith(url);
        expect(registry.owns(url)).toBe(false);
    });

    it('keeps a released carrier while a deck still renders it and sweeps it later', async () => {
        const url = await registry.acquire(APPLE);
        deps.isInUse.mockReturnValue(true);
        registry.release(APPLE);
        expect(deps.revoke).not.toHaveBeenCalled();
        expect(registry.owns(url)).toBe(false);

        deps.isInUse.mockReturnValue(false);
        await registry.acquire(OTHER);
        expect(deps.revoke).toHaveBeenCalledExactlyOnceWith(url);
    });

    it('mints a fresh carrier for a song acquired again after its last release', async () => {
        const first = await registry.acquire(APPLE);
        registry.release(APPLE);
        const second = await registry.acquire(APPLE);
        expect(second).not.toBe(first);
        expect(deps.create).toHaveBeenCalledTimes(2);
    });

    it('forgets a carrier that failed to mint', async () => {
        deps.create.mockRejectedValueOnce(new OnlineProviderError('not-playable', 'no carrier'));
        const waiters = [registry.acquire(APPLE), registry.acquire(APPLE)];
        await expect(waiters[0]).rejects.toThrow('no carrier');
        await expect(waiters[1]).rejects.toThrow('no carrier');

        expect(() => registry.release(APPLE)).not.toThrow();
        expect(registry.peek(APPLE)).toBeNull();
        await expect(registry.acquire(APPLE)).resolves.toBe('blob:apple-a:1');
        expect(deps.create).toHaveBeenCalledTimes(2);
    });

    it('releases by URL and says whether it owned it', async () => {
        const url = await registry.acquire(APPLE);
        expect(registry.releaseUrl('blob:other')).toBe(false);
        expect(deps.revoke).not.toHaveBeenCalled();

        expect(registry.releaseUrl(url)).toBe(true);
        expect(deps.revoke).toHaveBeenCalledExactlyOnceWith(url);
        expect(registry.releaseUrl(url)).toBe(false);
    });

    // A skip lands while the carrier is still being built: nobody ever sees the URL to release it,
    // so the registry has to remember it and revoke it itself.
    it('revokes a carrier whose last holder let go before it finished minting', async () => {
        const pending = registry.acquire(APPLE);
        registry.release(APPLE);
        expect(registry.peek(APPLE)).toBeNull();

        const url = await pending;
        await flush();
        expect(deps.revoke).toHaveBeenCalledExactlyOnceWith(url);
        expect(registry.owns(url)).toBe(false);
    });

    it('does not let a release for a failed mint take a later holder\'s reference', async () => {
        deps.create.mockRejectedValueOnce(new OnlineProviderError('not-playable', 'no carrier'));
        await expect(registry.acquire(APPLE)).rejects.toThrow();
        const url = await registry.acquire(APPLE);

        registry.release(OTHER);
        expect(registry.owns(url)).toBe(true);
        expect(deps.revoke).not.toHaveBeenCalled();
    });

    it('mints through omni at standard quality and rejects a source without a playable URL', async () => {
        getAudioSourceMock.mockResolvedValueOnce({ url: 'blob:omni-carrier', fetchedAt: 1, quality: 'standard' });
        await expect(carrierRegistry.acquire(songOf('singleton-ok'))).resolves.toBe('blob:omni-carrier');
        expect(getAudioSourceMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'singleton-ok' }), 'standard');

        getAudioSourceMock.mockResolvedValueOnce(null);
        await expect(carrierRegistry.acquire(songOf('singleton-none'))).rejects.toMatchObject({
            name: 'OnlineProviderError',
            code: 'not-playable',
        });
    });
});

describe('createCarrierSlot', () => {
    let deps: ReturnType<typeof makeDeps>;
    let registry: CarrierRegistry;

    beforeEach(() => {
        deps = makeDeps();
        registry = createCarrierRegistry(deps);
    });

    it('lets a slot hold one song at a time', async () => {
        const slot = createCarrierSlot(registry);

        expect(slot.want(APPLE)).toBeNull();
        await flush();
        const urlA = slot.want(APPLE);
        expect(urlA).toBe('blob:apple-a:1');
        expect(registry.owns(urlA!)).toBe(true);

        expect(slot.want(OTHER)).toBeNull();
        expect(registry.owns(urlA!)).toBe(false);
        expect(deps.revoke).toHaveBeenCalledExactlyOnceWith(urlA);
        await flush();
        const urlB = slot.want(OTHER);
        expect(urlB).toBe('blob:apple-b:2');

        expect(slot.want(null)).toBeNull();
        expect(deps.revoke).toHaveBeenLastCalledWith(urlB);
        expect(registry.owns(urlB!)).toBe(false);
    });

    it('shares the carrier with another holder of the same song', async () => {
        const held = await registry.acquire(APPLE);
        const slot = createCarrierSlot(registry);
        slot.want(APPLE);
        await flush();
        expect(slot.want(APPLE)).toBe(held);

        slot.want(null);
        expect(deps.revoke).not.toHaveBeenCalled();
        expect(registry.owns(held)).toBe(true);
    });

    it('does not retry a song that failed to mint until the song changes', async () => {
        deps.create.mockRejectedValueOnce(new OnlineProviderError('not-playable', 'no carrier'));
        const slot = createCarrierSlot(registry);

        expect(slot.want(APPLE)).toBeNull();
        await flush();
        expect(slot.want(APPLE)).toBeNull();
        expect(slot.want(APPLE)).toBeNull();
        expect(deps.create).toHaveBeenCalledTimes(1);

        slot.want(null);
        slot.want(APPLE);
        await flush();
        expect(deps.create).toHaveBeenCalledTimes(2);
        expect(slot.want(APPLE)).toBe('blob:apple-a:1');
    });

    it('drops a carrier that finished minting after the slot moved on', async () => {
        const slot = createCarrierSlot(registry);
        slot.want(APPLE);
        slot.want(OTHER);
        await flush();

        expect(slot.want(OTHER)).toBe('blob:apple-b:2');
        expect(deps.revoke).toHaveBeenCalledExactlyOnceWith('blob:apple-a:1');
    });

    it('ignores the first mint of a song it left and came back to', async () => {
        const slot = createCarrierSlot(registry);
        slot.want(APPLE);
        slot.want(OTHER);
        slot.want(APPLE);
        await flush();

        expect(slot.want(APPLE)).toBe('blob:apple-a:3');
        expect(registry.owns('blob:apple-a:3')).toBe(true);
        expect(deps.revoke).toHaveBeenCalledWith('blob:apple-a:1');
    });

    it('does not release a failed song\'s reference when it moves on', async () => {
        deps.create.mockRejectedValueOnce(new OnlineProviderError('not-playable', 'no carrier'));
        const slot = createCarrierSlot(registry);
        slot.want(APPLE);
        await flush();

        const url = await registry.acquire(APPLE);
        slot.want(OTHER);
        expect(registry.owns(url)).toBe(true);
        expect(deps.revoke).not.toHaveBeenCalledWith(url);
    });
});
