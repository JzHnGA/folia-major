import type { SongResult } from '../../types';
import { OnlineProviderError } from '../../types/onlineMusic';
import { getOnlineProviderIdForSong, getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { toSafePlaybackUrl } from '../../utils/appPlaybackHelpers';
import { isUrlOnAudioElement } from '../../utils/mediaElementSources';
import { omni } from '../onlineMusic/omni';

// src/services/externalPlayback/carrierRegistry.ts
// Shares one silent carrier per external song across everything that renders it (the active deck, Automix's
// preroll), counts who holds it, and revokes it only once the last holder let go and no deck still shows it.

export interface CarrierRegistryDeps {
    /** Mints the carrier URL for a song. */
    create(song: SongResult): Promise<string>;
    revoke(url: string): void;
    /** True while a media element still renders the URL. */
    isInUse(url: string): boolean;
}

export interface CarrierRegistry {
    /**
     * Takes a reference (counted synchronously) and resolves with the song's carrier URL; every acquire of the
     * same playback key gets the same URL while it is held. A rejected acquire holds nothing, so it is not released.
     */
    acquire(song: SongResult): Promise<string>;
    /** The resolved URL of a held song; null while it is minting or not held. */
    peek(song: SongResult): string | null;
    /** Gives one reference back; no-op for a song that is not held. */
    release(song: SongResult): void;
    /** `release` by URL; false when the URL is not a held carrier. */
    releaseUrl(url: string): boolean;
    owns(url: string): boolean;
}

/** One held song: how many hold it, and the single mint every holder shares. */
interface CarrierEntry {
    holders: number;
    url: string | null;
    minting: Promise<string>;
}

// Builds a registry over the given mint/revoke/in-use hooks. At zero holders an entry leaves the table at once
// (a later acquire mints anew) and its URL waits in a revoke list that every call sweeps, so a carrier a deck is
// still sounding survives until that deck lets go.
export const createCarrierRegistry = (deps: CarrierRegistryDeps): CarrierRegistry => {
    const entries = new Map<string, CarrierEntry>();
    let awaitingRevoke: string[] = [];

    const sweep = () => {
        awaitingRevoke = awaitingRevoke.filter(url => {
            if (deps.isInUse(url)) return true;
            deps.revoke(url);
            return false;
        });
    };

    const mint = (key: string, song: SongResult): CarrierEntry => {
        const entry: CarrierEntry = {
            holders: 0,
            url: null,
            minting: deps.create(song).then(
                url => {
                    entry.url = url;
                    // Every holder let go while it was minting, so nobody is left to release this URL.
                    if (entries.get(key) !== entry) {
                        awaitingRevoke.push(url);
                        sweep();
                    }
                    return url;
                },
                error => {
                    if (entries.get(key) === entry) entries.delete(key);
                    throw error;
                },
            ),
        };
        entries.set(key, entry);
        return entry;
    };

    const letGo = (key: string, entry: CarrierEntry) => {
        entry.holders -= 1;
        if (entry.holders > 0) return;
        entries.delete(key);
        if (entry.url) awaitingRevoke.push(entry.url);
    };

    return {
        acquire(song) {
            const key = getPlaybackSongKey(song);
            const entry = entries.get(key) ?? mint(key, song);
            entry.holders += 1;
            sweep();
            return entry.minting;
        },
        peek(song) {
            return entries.get(getPlaybackSongKey(song))?.url ?? null;
        },
        release(song) {
            const key = getPlaybackSongKey(song);
            const entry = entries.get(key);
            if (entry) letGo(key, entry);
            sweep();
        },
        releaseUrl(url) {
            const held = Array.from(entries).find(([, entry]) => entry.url === url);
            if (held) letGo(held[0], held[1]);
            sweep();
            return Boolean(held);
        },
        owns(url) {
            return Array.from(entries.values()).some(entry => entry.url === url);
        },
    };
};

// The app-wide registry: carriers are minted by the song's provider through Omni.
export const carrierRegistry: CarrierRegistry = createCarrierRegistry({
    async create(song) {
        const source = await omni.getAudioSource(song, 'standard');
        const url = toSafePlaybackUrl(source?.url);
        if (!url) {
            throw new OnlineProviderError('not-playable', 'The provider returned no carrier audio', getOnlineProviderIdForSong(song) ?? undefined);
        }
        return url;
    },
    revoke: url => URL.revokeObjectURL(url),
    isInUse: isUrlOnAudioElement,
});

export const acquireCarrier = (song: SongResult): Promise<string> => carrierRegistry.acquire(song);

export const releaseCarrier = (song: SongResult): void => carrierRegistry.release(song);

/** Holds one song's carrier ahead of time, e.g. a preroll deck's. */
export interface CarrierSlot {
    /** Wants this song (null: none); returns its carrier URL once minted, null while minting or after a failed mint. */
    want(song: SongResult | null): string | null;
}

// Creates a slot that holds at most one song of the registry: a new song releases the old one first, and a song
// whose mint failed is not retried until the slot moves to another song or to null.
export const createCarrierSlot = (registry: CarrierRegistry): CarrierSlot => {
    let wantedKey: string | null = null;
    let held: SongResult | null = null;
    let url: string | null = null;
    /** Bumped on every song change, so an acquire that settles after a change (even back to the same song) is ignored. */
    let generation = 0;

    return {
        want(song) {
            const key = song ? getPlaybackSongKey(song) : null;
            if (key === wantedKey) return url;

            if (held) registry.release(held);
            wantedKey = key;
            held = song;
            url = null;
            generation += 1;
            if (!song) return null;

            const ticket = generation;
            registry.acquire(song).then(
                minted => {
                    // Moved on while minting: that reference was already given back, so the URL is not ours.
                    if (ticket === generation) url = minted;
                },
                () => {
                    // A rejected acquire holds nothing, so there is nothing to release when moving on.
                    if (ticket === generation) held = null;
                },
            );
            return null;
        },
    };
};
