import { getStoredStringOrNull, removeStoredKey } from '../../stores/storagePrimitives';
import { isNativeSecurityAvailable, secureDelete, secureGet, secureSet } from './nativeSecurity';
import type { SecuritySecureId } from './types';

// src/services/security/secureSession.ts
// The NetEase login is a cookie session (MUSIC_U), not OAuth. That cookie is as sensitive as a
// password: anyone who copies it can act as the account. It used to sit in localStorage in
// plaintext. Here it is migrated once into the iOS Keychain, the plaintext copy is removed, and
// the app reads/writes it through an in-memory cache (localStorage is synchronous, Keychain is
// not), so existing provider code keeps working.

type CacheEntry = { readonly loaded: boolean; readonly value: string | null };

const IDS = ['netease.cookie', 'netease.anonymous_cookie'] as const satisfies readonly SecuritySecureId[];

// Only the two cookies that once sat in localStorage are migrated; the other secure ids never were there.
type MigratedSecureId = typeof IDS[number];

const LEGACY_KEYS: Record<MigratedSecureId, readonly string[]> = {
    'netease.cookie': ['online_provider:netease:cookie', 'netease_cookie'],
    'netease.anonymous_cookie': ['online_provider:netease:anonymous_cookie', 'netease_anonymous_cookie'],
};

const cache = new Map<SecuritySecureId, CacheEntry>();
let installed: Promise<void> | null = null;

/** Reads a migrated value, or undefined when the Keychain has not answered yet. */
export const secureSessionGet = (id: SecuritySecureId): string | null | undefined => {
    const entry = cache.get(id);
    return entry?.loaded ? entry.value : undefined;
};

export const secureSessionSet = (id: SecuritySecureId, value: string): void => {
    cache.set(id, { loaded: true, value });
    if (!isNativeSecurityAvailable()) return;
    void secureSet(id, value).catch((error: unknown) => {
        console.warn('[security] Could not write the NetEase session to the Keychain.', error);
    });
};

export const secureSessionDelete = (id: SecuritySecureId): void => {
    cache.set(id, { loaded: true, value: null });
    if (!isNativeSecurityAvailable()) return;
    void secureDelete(id).catch((error: unknown) => {
        console.warn('[security] Could not remove the NetEase session from the Keychain.', error);
    });
};

/**
 * Migrates the plaintext cookies once, in the iOS shell only. Safe to call more than once: every
 * caller shares the same promise. A failure leaves the old localStorage value in place so the
 * user is never logged out by a storage problem.
 */
export const installSecureSession = (): Promise<void> => {
    if (installed) return installed;
    installed = (async () => {
        if (!isNativeSecurityAvailable()) {
            IDS.forEach(id => cache.set(id, { loaded: true, value: null }));
            return;
        }

        for (const id of IDS) {
            try {
                const stored = await secureGet(id);
                if (stored != null && stored !== '') {
                    cache.set(id, { loaded: true, value: stored });
                    LEGACY_KEYS[id].forEach(key => removeStoredKey(key));
                    continue;
                }

                const legacy = LEGACY_KEYS[id]
                    .map(key => getStoredStringOrNull(key))
                    .find((value): value is string => value != null && value !== '');

                if (legacy != null) {
                    await secureSet(id, legacy);
                    cache.set(id, { loaded: true, value: legacy });
                    LEGACY_KEYS[id].forEach(key => removeStoredKey(key));
                } else {
                    cache.set(id, { loaded: true, value: null });
                }
            } catch (error) {
                console.warn('[security] NetEase session migration failed; keeping the old copy.', error);
                const legacy = LEGACY_KEYS[id]
                    .map(key => getStoredStringOrNull(key))
                    .find((value): value is string => value != null && value !== '');
                cache.set(id, { loaded: false, value: legacy ?? null });
            }
        }
    })();
    return installed;
};

export const whenSecureSessionReady = (): Promise<void> => installSecureSession();
