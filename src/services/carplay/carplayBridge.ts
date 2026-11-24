import i18n from '../../i18n/config';
import { useOnlineProviderAccountStore, type OnlineProviderAccountState } from '../../stores/useOnlineProviderAccountStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import type { SongResult } from '../../types';
import type { ProviderCollection } from '../../types/onlineMusic';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { omni } from '../onlineMusic/omni';
import { isSongUnavailable } from '../onlineMusic/songAvailability';
import { getCarPlayPlayback } from './carplayPlayback';

// src/services/carplay/carplayBridge.ts
// The web half of Ecria on CarPlay (the native half is ios/App/App/CarPlaySceneDelegate.swift). The
// car asks, through the EcriaCarPlay plugin's "request" event, for three things, and is answered by
// request id: "home" (the daily songs and the signed-in account's playlists, liked songs first), the
// songs of one of those ("tracks"), and to play one of them with the rest as its queue ("play").
// Lists come from the account store and omni, so the car shows what the phone's library shows.

const DAILY_ID = 'daily';
/** Songs read for one list: CarPlay shows a few hundred at most. */
const MAX_TRACKS = 300;
const PAGE = 100;

type CarPlayRequest = { requestId: string; kind: string; params?: Record<string, unknown> };
type CarPlayAnswer = Record<string, unknown>;

/** The songs of each list as the car last saw them, so "play" plays from the same queue. */
const shownTracks = new Map<string, SongResult[]>();

const bridge = () => (typeof window === 'undefined' ? undefined : window.Capacitor?.Plugins?.EcriaCarPlay);

const textParam = (value: unknown): string => (typeof value === 'string' ? value : '');

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

/** The signed-in account's playlists the car lists: liked songs first; the cloud drive and listening ranks left out. */
const accountCollections = async (): Promise<ProviderCollection[]> => {
    const store = useOnlineProviderAccountStore.getState();
    const providerId = store.activeProviderId;
    if (!providerId) return [];
    // Not read yet at all (the car connected before the phone's start-up read finished): read it now.
    const accountOf = () => useOnlineProviderAccountStore.getState().accounts[providerId] as OnlineProviderAccountState | undefined;
    const before = accountOf();
    if (!before || (before.status === 'unknown' && before.collections.length === 0)) {
        await omni.readAccount(providerId, 'start');
    }
    const lists = (accountOf()?.collections ?? []).filter(collection => collection.type === 'playlist' || collection.type === 'album');
    return [...lists.filter(collection => collection.isLiked), ...lists.filter(collection => !collection.isLiked)];
};

const answerHome = async (): Promise<CarPlayAnswer> => {
    const providerId = useOnlineProviderAccountStore.getState().activeProviderId;
    const collections = await accountCollections();
    const sections: CarPlayAnswer[] = [];
    if (providerId && omni.supportsDailySongs(providerId) && collections.length > 0) {
        sections.push({
            title: t('carplay.forYou'),
            items: [{ id: DAILY_ID, title: t('carplay.dailySongs'), subtitle: t('carplay.dailySongsDetail') }],
        });
    }
    if (collections.length > 0) {
        sections.push({
            title: t('carplay.playlists'),
            items: collections.map(collection => ({
                id: `${collection.type}:${collection.id}`,
                title: collection.name,
                subtitle: collection.trackCount !== undefined ? t('carplay.songCount', { count: collection.trackCount }) : undefined,
                imageUrl: collection.coverUrl,
            })),
        });
    }
    return { sections, emptyText: t('carplay.signInOnPhone') };
};

const readCollectionTracks = async (collectionId: string): Promise<SongResult[]> => {
    if (collectionId === DAILY_ID) return (await omni.getDailySongs()).slice(0, MAX_TRACKS);
    const collection = (await accountCollections()).find(item => `${item.type}:${item.id}` === collectionId);
    if (!collection) throw new Error(`No list ${collectionId}`);
    const tracks: SongResult[] = [];
    let offset = 0;
    while (tracks.length < MAX_TRACKS) {
        const page = await omni.getCollectionTracks(collection, { limit: PAGE, offset });
        tracks.push(...page.items);
        if (!page.hasMore || page.items.length === 0) break;
        offset = page.nextOffset;
    }
    return tracks.slice(0, MAX_TRACKS);
};

const answerTracks = async (params: Record<string, unknown>): Promise<CarPlayAnswer> => {
    const collectionId = textParam(params.collectionId);
    const tracks = await readCollectionTracks(collectionId);
    shownTracks.set(collectionId, tracks);
    const current = usePlaybackStore.getState().currentSong;
    const currentKey = current ? getPlaybackSongKey(current) : null;
    return {
        tracks: tracks.map(song => ({
            key: getPlaybackSongKey(song),
            title: song.name,
            subtitle: song.artists.map(artist => artist.name).filter(Boolean).join(' / '),
            imageUrl: song.album.coverUrl,
            unavailable: isSongUnavailable(song),
            playing: getPlaybackSongKey(song) === currentKey,
        })),
        emptyText: t('carplay.emptyList'),
    };
};

const answerPlay = (params: Record<string, unknown>): CarPlayAnswer => {
    const tracks = shownTracks.get(textParam(params.collectionId)) ?? [];
    const song = tracks.find(item => getPlaybackSongKey(item) === params.trackKey);
    const playback = getCarPlayPlayback();
    if (!song) throw new Error('That song is no longer in the list');
    if (!playback) throw new Error('Playback is not ready');
    playback.playSong(song, tracks);
    return {};
};

const answer = async (request: CarPlayRequest): Promise<CarPlayAnswer> => {
    const params = request.params ?? {};
    switch (request.kind) {
        case 'home': return answerHome();
        case 'tracks': return answerTracks(params);
        case 'play': return answerPlay(params);
        default: throw new Error(`Unknown request ${request.kind}`);
    }
};

/** Listens for the car's requests in the iOS app; does nothing elsewhere. */
export const installCarPlayBridge = (): void => {
    const plugin = bridge();
    if (!plugin) return;
    void plugin.addListener('request', (request: CarPlayRequest) => {
        void (async () => {
            try {
                const data = await answer(request);
                await plugin.respond({ requestId: request.requestId, ok: true, data });
            } catch (error) {
                console.warn(`[carplay] ${request.kind} failed`, error);
                await plugin.respond({ requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        })();
    }).then(() => plugin.ready());
    console.info('[carplay] bridge installed');
};
