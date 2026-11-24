import type { OnlineProviderId } from '../../types/onlineMusic';
import { getFromCache, saveToCache } from '../db';
import { isNativeSecurityAvailable } from '../security/nativeSecurity';
import { secureSessionDelete, secureSessionGet, secureSessionSet } from '../security/secureSession';

// src/services/onlineMusic/providerStorage.ts
//
// NetEase's login cookie is a credential, so in the iOS shell it lives in the Keychain (see
// services/security/secureSession.ts) instead of localStorage. Everything else keeps using the
// original synchronous localStorage path.

export const getProviderCacheKey = (providerId: OnlineProviderId, key: string): string => (
    `online_provider_${providerId}_${key}`
);

export const getProviderSessionKey = (providerId: OnlineProviderId, key: string): string => (
    `online_provider:${providerId}:${key}`
);

// Reads an old unscoped cache once, then stores the value in the provider namespace.
export const getProviderCacheWithLegacyMigration = async <T>(
    providerId: OnlineProviderId,
    key: string,
    legacyKeys: string[] = [],
): Promise<T | null> => {
    const namespacedKey = getProviderCacheKey(providerId, key);
    const current = await getFromCache<T>(namespacedKey);
    if (current != null) return current;

    for (const legacyKey of legacyKeys) {
        const legacy = await getFromCache<T>(legacyKey);
        if (legacy == null) continue;
        await saveToCache(namespacedKey, legacy);
        return legacy;
    }
    return null;
};

const secureIdFor = (providerId: OnlineProviderId, key: string) => {
    if (providerId !== 'netease') return null;
    if (key === 'cookie') return 'netease.cookie' as const;
    if (key === 'anonymous_cookie') return 'netease.anonymous_cookie' as const;
    return null;
};

export const readProviderSessionValue = (
    providerId: OnlineProviderId,
    key: string,
    legacyKeys: string[] = [],
): string | null => {
    if (typeof localStorage === 'undefined') return null;
    const secureId = secureIdFor(providerId, key);
    if (secureId && isNativeSecurityAvailable()) {
        const secure = secureSessionGet(secureId);
        // undefined means the Keychain read has not finished; fall back to the legacy copy once.
        if (secure !== undefined) return secure;
    }
    const namespacedKey = getProviderSessionKey(providerId, key);
    const current = localStorage.getItem(namespacedKey);
    if (current != null) return current;

    for (const legacyKey of legacyKeys) {
        const legacy = localStorage.getItem(legacyKey);
        if (legacy == null) continue;
        localStorage.setItem(namespacedKey, legacy);
        return legacy;
    }
    return null;
};

export const writeProviderSessionValue = (providerId: OnlineProviderId, key: string, value: string): void => {
    const secureId = secureIdFor(providerId, key);
    if (secureId && isNativeSecurityAvailable()) {
        secureSessionSet(secureId, value);
        return;
    }
    if (typeof localStorage !== 'undefined') localStorage.setItem(getProviderSessionKey(providerId, key), value);
};

export const removeProviderSessionValue = (
    providerId: OnlineProviderId,
    key: string,
    legacyKeys: string[] = [],
): void => {
    if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(getProviderSessionKey(providerId, key));
        legacyKeys.forEach(legacyKey => localStorage.removeItem(legacyKey));
    }
    const secureId = secureIdFor(providerId, key);
    if (secureId && isNativeSecurityAvailable()) secureSessionDelete(secureId);
};
