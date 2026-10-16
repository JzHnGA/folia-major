import { useCallback, useEffect, useRef } from 'react';
import i18n from '../i18n/config';
import { omni } from '../services/onlineMusic/omni';
import { clearProviderAccountSnapshot, loadProviderAccountSnapshot, saveProviderAccountSnapshot } from '../services/onlineMusic/providerAccountCache';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { OnlineProviderError } from '../types/onlineMusic';
import type { ProviderCollection } from '../types/onlineMusic';

// src/hooks/useAppleMusicLibrary.ts

const PROVIDER_ID = 'apple-music';
const PAGE_SIZE = 50;
const PERMISSION_DENIED_ERROR = 'apple-music-permission-denied';

// The hint is shown once per session; re-tests on window focus would otherwise repeat it.
let permissionHintShown = false;

// Apple Music exists only in the macOS desktop app; elsewhere the provider is unregistered or reports no runtime.
const isProviderAvailableHere = (): boolean => (
    omni.getProviderSummaries().some(provider => provider.providerId === PROVIDER_ID)
    && omni.getProviderAvailability(PROVIDER_ID).reason !== 'runtime-unavailable'
);

// Shows the account as signed out with the permission error, and explains how to grant access the first time.
const markPermissionDenied = () => {
    useOnlineProviderAccountStore.getState().clearAccount(PROVIDER_ID, PERMISSION_DENIED_ERROR);
    if (permissionHintShown) return;
    permissionHintShown = true;
    setStatusMessage({ type: 'error', text: i18n.t('appleMusic.permissionDenied') });
};

// Loads the local Music library as a single always-signed-in account and keeps its playlists in sync.
export const useAppleMusicLibrary = () => {
    const generation = useRef(0);
    const pendingSave = useRef<Promise<unknown>>(Promise.resolve());
    const refresh = useCallback(async (): Promise<boolean> => {
        if (!isProviderAvailableHere()) return false;
        const current = ++generation.current;
        const store = useOnlineProviderAccountStore.getState();
        try {
            // Not gated on availability: a denied permission makes it 'not-configured', and only this probe can recover from that.
            // The probe never sends an Apple Event, so it does not launch Music.
            const user = await omni.getLoginStatus(PROVIDER_ID);
            if (generation.current !== current) return false;
            if (!user) {
                if (omni.getProviderAvailability(PROVIDER_ID).reason === 'not-configured') markPermissionDenied();
                else store.clearAccount(PROVIDER_ID);
                return false;
            }
            const visibleUser = useOnlineProviderAccountStore.getState().accounts[PROVIDER_ID]?.user;
            if (!visibleUser || String(visibleUser.id) !== String(user.id)) {
                const snapshot = await loadProviderAccountSnapshot(PROVIDER_ID).catch(() => null);
                if (generation.current !== current) return false;
                const matching = snapshot && String(snapshot.user.id) === String(user.id) ? snapshot : null;
                store.updateAccount(PROVIDER_ID, { status: 'authenticated', user, collections: matching?.collections || [],
                    hydration: 'ready', freshness: 'stale', lastUpdatedAt: matching?.savedAt, error: undefined });
            } else {
                store.updateAccount(PROVIDER_ID, { status: 'authenticated', user, hydration: 'ready', error: undefined });
            }
            // Reading the playlists talks to Music (and launches it), so it waits until Apple Music is the provider in use.
            if (useOnlineProviderAccountStore.getState().activeProviderId !== PROVIDER_ID) return true;
            store.updateAccount(PROVIDER_ID, { freshness: 'refreshing' });
            const collections: ProviderCollection[] = [];
            let offset = 0;
            while (true) {
                const page = await omni.getProviderUserPlaylists(PROVIDER_ID, user.id, { offset, limit: PAGE_SIZE });
                if (generation.current !== current) return false;
                collections.push(...page.items);
                if (!page.hasMore || page.nextOffset <= offset) break;
                offset = page.nextOffset;
            }
            const save = pendingSave.current.catch(() => {}).then(() => {
                if (generation.current !== current) return null;
                // Commit before saving so nothing written during persistence is overwritten afterward.
                store.updateAccount(PROVIDER_ID, { status: 'authenticated', user, collections, hydration: 'ready', error: undefined });
                return saveProviderAccountSnapshot(PROVIDER_ID, { user, collections, likedSongIds: [] });
            });
            pendingSave.current = save;
            const saved = await save;
            if (generation.current !== current) return false;
            if (!saved) return false;
            store.updateAccount(PROVIDER_ID, { freshness: 'fresh', lastUpdatedAt: saved.savedAt });
            return true;
        } catch (error) {
            if (generation.current !== current) return false;
            const code = error instanceof OnlineProviderError ? error.code : undefined;
            if (code === 'auth-required') {
                markPermissionDenied();
            } else if (code === 'unavailable') {
                // Music is not running: keep what the snapshot showed and say nothing.
                store.updateAccount(PROVIDER_ID, { hydration: 'ready', freshness: 'stale', error: undefined });
            } else {
                store.updateAccount(PROVIDER_ID, { hydration: 'ready', freshness: 'error',
                    status: useOnlineProviderAccountStore.getState().accounts[PROVIDER_ID]?.user ? 'authenticated' : 'error',
                    error: 'apple-music-refresh-failed' });
            }
            return false;
        }
    }, []);
    const logout = useCallback(async () => {
        generation.current++;
        useOnlineProviderAccountStore.getState().clearAccount(PROVIDER_ID);
        await pendingSave.current.catch(() => {});
        await Promise.all([omni.logout(PROVIDER_ID), clearProviderAccountSnapshot(PROVIDER_ID)]);
    }, []);
    useEffect(() => {
        let previousProviderId = useOnlineProviderAccountStore.getState().activeProviderId;
        void refresh();
        // Switching to Apple Music is what makes the playlists load, since the startup refresh skips them otherwise.
        const unsubscribe = useOnlineProviderAccountStore.subscribe(state => {
            if (state.activeProviderId === previousProviderId) return;
            previousProviderId = state.activeProviderId;
            if (state.activeProviderId === PROVIDER_ID) void refresh();
        });
        return () => {
            generation.current++;
            unsubscribe();
        };
    }, [refresh]);
    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        // Granting access in System Settings has to work without restarting Folia, and returning to the window is the signal for it.
        const retestPermission = () => {
            if (useOnlineProviderAccountStore.getState().accounts[PROVIDER_ID]?.error === PERMISSION_DENIED_ERROR) void refresh();
        };
        window.addEventListener('focus', retestPermission);
        return () => window.removeEventListener('focus', retestPermission);
    }, [refresh]);
    return { refresh, logout };
};
