import type {
    EcriaSecurityBridge,
    SecurityAuthState,
    SecuritySecureId,
    SecurityStatus,
    SecuritySyncSlot,
} from './types';

// src/services/security/nativeSecurity.ts
// The web side of the EcriaSecurity plugin. Every function is a no-op-free bridge call: in a
// browser (or the desktop app) isNativeSecurityAvailable() is false and the account page says so,
// instead of pretending the cloud account exists.

export const isNativeSecurityAvailable = (): boolean => Boolean(bridge());

const bridge = (): EcriaSecurityBridge | undefined => {
    if (typeof window === 'undefined') return undefined;
    return window.Capacitor?.Plugins?.EcriaSecurity;
};

const required = (): EcriaSecurityBridge => {
    const value = bridge();
    if (!value) throw new Error('Ecria security is only available in the iOS app.');
    return value;
};

export const status = (): Promise<SecurityStatus> => required().status();
export const authState = (): Promise<SecurityAuthState> => required().authState();
export const signInWithGoogle = (): Promise<SecurityAuthState> => required().signInWithGoogle();
export const refreshToken = (): Promise<SecurityAuthState> => required().refreshToken();
export const signOut = (): Promise<void> => required().signOut();

export const seal = (plaintext: string): Promise<string> => required()
    .seal({ plaintext })
    .then(result => result.ciphertext);

export const open = (ciphertext: string): Promise<string> => required()
    .open({ ciphertext })
    .then(result => result.plaintext);

export const keyCheck = (): Promise<string> => required().keyCheck().then(result => result.check);
export const resetVaultKey = (): Promise<void> => required().resetVaultKey();

export const syncGet = (slot: SecuritySyncSlot): Promise<string | null> => required()
    .syncGet({ slot })
    .then(result => result.value);

export const syncPut = (slot: SecuritySyncSlot, value: string): Promise<void> => required()
    .syncPut({ slot, value });

export const syncDelete = (slot: SecuritySyncSlot): Promise<void> => required()
    .syncDelete({ slot });

export const secureGet = (id: SecuritySecureId): Promise<string | null> => required()
    .secureGet({ id })
    .then(result => result.value);

export const secureSet = (id: SecuritySecureId, value: string): Promise<void> => required()
    .secureSet({ id, value });

export const secureDelete = (id: SecuritySecureId): Promise<void> => required()
    .secureDelete({ id });

export const setAppLock = (enabled: boolean): Promise<boolean> => required()
    .setAppLock({ enabled })
    .then(result => result.enabled);

export const lockNow = (): Promise<void> => required().lockNow();

export const unlock = (): Promise<boolean> => required()
    .unlock()
    .then(result => result.unlocked);
