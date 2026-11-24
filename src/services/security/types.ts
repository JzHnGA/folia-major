// src/services/security/types.ts
// The shape of the EcriaSecurity bridge (ios/App/App/EcriaSecurityPlugin.swift) and of the data
// the account page uses. Nothing here is available in a browser: every caller checks
// isNativeSecurityAvailable() first.

export type SecurityBiometricKind = 'face' | 'touch' | 'optic' | 'none';

export type SecurityStatus = {
    readonly native: boolean;
    readonly configured: boolean;
    readonly biometrics: boolean;
    readonly biometricType: SecurityBiometricKind;
    readonly biometricLabel: string;
    readonly hasVaultKey: boolean;
    readonly lockEnabled: boolean;
    readonly signedIn: boolean;
};

export type SecurityAuthState = {
    readonly signedIn: boolean;
    readonly uid: string | null;
    readonly email: string | null;
    readonly displayName: string | null;
    /** Unix seconds. Firebase refreshes the token automatically before it expires. */
    readonly expiresAt: number | null;
};

export type SecuritySyncSlot = 'vault' | 'vaultMeta' | 'vaultKeyCheck' | 'profile';

export type SecuritySecureId =
    | 'netease.cookie'
    | 'netease.anonymous_cookie'
    | 'netease.official.access'
    | 'netease.official.refresh'
    | 'netease.official.anonymous'
    | 'ai.gemini_api_key'
    | 'ai.openai_api_key';

export interface EcriaSecurityBridge {
    status(): Promise<SecurityStatus>;
    authState(): Promise<SecurityAuthState>;
    signInWithGoogle(): Promise<SecurityAuthState>;
    refreshToken(): Promise<SecurityAuthState>;
    signOut(): Promise<void>;

    seal(options: { plaintext: string }): Promise<{ ciphertext: string }>;
    open(options: { ciphertext: string }): Promise<{ plaintext: string }>;
    keyCheck(): Promise<{ check: string }>;
    resetVaultKey(): Promise<void>;

    syncGet(options: { slot: SecuritySyncSlot }): Promise<{ value: string | null }>;
    syncPut(options: { slot: SecuritySyncSlot; value: string }): Promise<void>;
    syncDelete(options: { slot: SecuritySyncSlot }): Promise<void>;

    secureGet(options: { id: SecuritySecureId }): Promise<{ value: string | null }>;
    secureSet(options: { id: SecuritySecureId; value: string }): Promise<void>;
    secureDelete(options: { id: SecuritySecureId }): Promise<void>;

    setAppLock(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
    lockNow(): Promise<void>;
    unlock(): Promise<{ unlocked: boolean }>;
    /** Tells the native lock screen which app language to draw in. Optional: older native builds lack it. */
    setAppLocale?(options: { locale: string }): Promise<void>;
}

export type VaultSnapshot = {
    readonly version: 1;
    readonly savedAt: number;
    readonly nightstand: Record<string, string>;
    readonly appearance: Record<string, string>;
    readonly likedSongs: Array<string | number>;
};

export type VaultMeta = {
    readonly version: 1;
    readonly savedAt: number;
    readonly device: string;
};
