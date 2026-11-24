import { create } from 'zustand';
import i18n from '../i18n/config';
import {
    authState,
    isNativeSecurityAvailable,
    lockNow,
    refreshToken,
    setAppLock,
    signInWithGoogle,
    signOut,
    status,
} from '../services/security/nativeSecurity';
import { readVaultMeta, restoreVault, startFresh, syncVault } from '../services/security/vaultSync';
import type { SecurityAuthState, SecurityStatus, VaultMeta } from '../services/security/types';

// src/stores/useSecurityStore.ts
// The account & security page's state. Every action is a thin wrapper that keeps `busy` / `error`
// honest and refreshes the native status after a change; the security decisions themselves stay in
// Swift (OAuth, Keychain, biometrics, Rules).

const SIGNED_OUT: SecurityAuthState = {
    signedIn: false,
    uid: null,
    email: null,
    displayName: null,
    expiresAt: null,
};

type SecurityStore = {
    available: boolean;
    status: SecurityStatus | null;
    auth: SecurityAuthState;
    vaultMeta: VaultMeta | null;
    loading: boolean;
    busy: string | null;
    error: string | null;
    notice: string | null;
    lastSyncAt: number | null;

    initialize: () => Promise<void>;
    refresh: () => Promise<void>;
    signIn: () => Promise<void>;
    refreshSession: () => Promise<void>;
    signOut: () => Promise<void>;
    setLock: (enabled: boolean) => Promise<void>;
    lock: () => Promise<void>;
    syncNow: () => Promise<void>;
    restore: () => Promise<void>;
    resetVault: () => Promise<void>;
    dismissMessages: () => void;
};

const messageOf = (error: unknown): string => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) {
        const value = (error as { message?: unknown }).message;
        if (typeof value === 'string') return value;
    }
    return 'Something went wrong.';
};

export const useSecurityStore = create<SecurityStore>((set, get) => {
    const fail = (error: unknown, extra: Partial<SecurityStore> = {}) => {
        set({ busy: null, error: messageOf(error), ...extra });
    };

    const refreshMeta = async () => {
        try {
            const vaultMeta = await readVaultMeta();
            set({ vaultMeta });
        } catch {
            // Metadata is optional; a missing one is not an error the user needs to see.
        }
    };

    return {
        available: isNativeSecurityAvailable(),
        status: null,
        auth: SIGNED_OUT,
        vaultMeta: null,
        loading: true,
        busy: null,
        error: null,
        notice: null,
        lastSyncAt: null,

        initialize: async () => {
            if (!isNativeSecurityAvailable()) {
                set({ loading: false, available: false });
                return;
            }
            set({ loading: true, error: null });
            try {
                const [nextStatus, nextAuth] = await Promise.all([status(), authState()]);
                set({ status: nextStatus, auth: nextAuth, loading: false, busy: null });
                await refreshMeta();
            } catch (error) {
                fail(error, { loading: false });
            }
        },

        refresh: async () => {
            if (!isNativeSecurityAvailable()) return;
            try {
                const nextStatus = await status();
                set({ status: nextStatus });
            } catch {
                // The page stays usable with the previous status.
            }
        },

        signIn: async () => {
            if (get().busy) return;
            set({ busy: 'signin', error: null, notice: null });
            try {
                const nextAuth = await signInWithGoogle();
                const nextStatus = await status();
                set({ auth: nextAuth, status: nextStatus, busy: null, notice: i18n.t('options.accountNoticeSignedIn') });
            } catch (error) {
                fail(error);
            }
        },

        refreshSession: async () => {
            if (get().busy) return;
            set({ busy: 'refresh', error: null, notice: null });
            try {
                const nextAuth = await refreshToken();
                set({ auth: nextAuth, busy: null, notice: i18n.t('options.accountNoticeRefreshed') });
            } catch (error) {
                fail(error);
            }
        },

        signOut: async () => {
            if (get().busy) return;
            set({ busy: 'signout', error: null, notice: null });
            try {
                await signOut();
                const nextStatus = await status();
                set({
                    auth: SIGNED_OUT,
                    status: nextStatus,
                    vaultMeta: null,
                    lastSyncAt: null,
                    busy: null,
                    notice: i18n.t('options.accountNoticeSignedOut'),
                });
            } catch (error) {
                fail(error);
            }
        },

        setLock: async (enabled: boolean) => {
            if (get().busy) return;
            set({ busy: 'lock', error: null, notice: null });
            try {
                const applied = await setAppLock(enabled);
                const nextStatus = await status();
                set({
                    status: nextStatus,
                    busy: null,
                    notice: i18n.t(applied ? 'options.accountNoticeLockOn' : 'options.accountNoticeLockOff'),
                });
            } catch (error) {
                fail(error);
            }
        },

        lock: async () => {
            try {
                await lockNow();
                const nextStatus = await status();
                set({ status: nextStatus });
            } catch (error) {
                fail(error);
            }
        },

        syncNow: async () => {
            if (get().busy) return;
            set({ busy: 'sync', error: null, notice: null });
            try {
                const result = await syncVault();
                const nextStatus = await status();
                set({
                    status: nextStatus,
                    busy: null,
                    lastSyncAt: result.savedAt,
                    notice: i18n.t('options.accountNoticeSynced'),
                });
                await refreshMeta();
            } catch (error) {
                fail(error);
            }
        },

        restore: async () => {
            if (get().busy) return;
            set({ busy: 'restore', error: null, notice: null });
            try {
                const result = await restoreVault();
                set({
                    busy: null,
                    lastSyncAt: result.savedAt,
                    notice: i18n.t('options.accountNoticeRestored'),
                });
            } catch (error) {
                fail(error);
            }
        },

        resetVault: async () => {
            if (get().busy) return;
            set({ busy: 'reset', error: null, notice: null });
            try {
                await startFresh();
                set({ busy: null, vaultMeta: null, lastSyncAt: null, notice: i18n.t('options.accountNoticeReset') });
            } catch (error) {
                fail(error);
            }
        },

        dismissMessages: () => set({ error: null, notice: null }),
    };
});
