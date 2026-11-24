import { loadProviderAccountSnapshot, saveProviderAccountSnapshot } from '../onlineMusic/providerAccountCache';
import { useOnlineProviderAccountStore } from '../../stores/useOnlineProviderAccountStore';
import type { OnlineProviderAccountState } from '../../stores/useOnlineProviderAccountStore';
import { getStoredStringOrNull, setStoredString } from '../../stores/storagePrimitives';
import type { MediaId } from '../../types/onlineMusic';
import { authState, isNativeSecurityAvailable, keyCheck, open, resetVaultKey, seal, syncDelete, syncGet, syncPut } from './nativeSecurity';
import type { VaultMeta, VaultSnapshot } from './types';

// src/services/security/vaultSync.ts
// Pillars 2 + 3 together: the snapshot is built locally, sealed with AES-256-GCM (the Keychain key
// asks for Face ID), and only then written to ecria/users/<uid>/vault. Firebase never sees the
// Nightstand widgets, the appearance settings or the liked song references in readable form.

const NIGHTSTAND_KEY = 'nightstand_widgets_v1';

const APPEARANCE_KEYS = [
    'follow_system_theme',
    'default_theme_daylight',
    'custom_theme_preferred',
    'custom_dual_theme',
    'theme_animation_intensity',
    'theme_generation_source',
    'theme_auto_switch_enabled',
    'theme_auto_generate_enabled',
    'last_applied_theme_pointer',
    'background_opacity',
    'url_background_list',
    'url_background_selected_id',
    'remote_background_mode',
    'transparent_player_background',
    'visualizer_background_mode',
    'folia_sync_theme_registry_v1',
    'folia_sync_theme_watermark_v1',
] as const;

const isMediaId = (value: unknown): value is MediaId => (
    (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isFinite(value))
);

export const collectSnapshot = (): VaultSnapshot => {
    const nightstand: Record<string, string> = {};
    const nightstandValue = getStoredStringOrNull(NIGHTSTAND_KEY);
    if (nightstandValue != null) nightstand[NIGHTSTAND_KEY] = nightstandValue;

    const appearance: Record<string, string> = {};
    APPEARANCE_KEYS.forEach(key => {
        const value = getStoredStringOrNull(key);
        if (value != null) appearance[key] = value;
    });

    const active = useOnlineProviderAccountStore.getState();
    const account = active.accounts['netease'] as OnlineProviderAccountState | undefined;
    const likedSongs = (account?.likedSongIds ?? []).filter(isMediaId);

    return { version: 1, savedAt: Date.now(), nightstand, appearance, likedSongs };
};

const parseSnapshot = (raw: string): VaultSnapshot => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('This device found a vault it does not understand.');
    }
    const value = parsed as Partial<VaultSnapshot>;
    if (value.version !== 1) {
        throw new Error('This device found a vault it does not understand.');
    }
    const nightstand = value.nightstand && typeof value.nightstand === 'object' ? value.nightstand : {};
    const appearance = value.appearance && typeof value.appearance === 'object' ? value.appearance : {};
    return {
        version: 1,
        savedAt: typeof value.savedAt === 'number' ? value.savedAt : Date.now(),
        nightstand: Object.fromEntries(
            Object.entries(nightstand).filter(([key, item]) => key === NIGHTSTAND_KEY && typeof item === 'string'),
        ),
        appearance: Object.fromEntries(
            APPEARANCE_KEYS
                .filter(key => typeof appearance[key] === 'string')
                .map(key => [key, appearance[key]] as const),
        ),
        likedSongs: Array.isArray(value.likedSongs) ? value.likedSongs.filter(isMediaId) : [],
    };
};

const applySnapshot = async (snapshot: VaultSnapshot): Promise<void> => {
    Object.entries(snapshot.nightstand).forEach(([key, value]) => setStoredString(key, value));
    Object.entries(snapshot.appearance).forEach(([key, value]) => setStoredString(key, value));

    useOnlineProviderAccountStore.getState().updateAccount('netease', { likedSongIds: snapshot.likedSongs });

    // Keep the provider's own cache in step, so a restart still sees the restored favourites.
    const existing = await loadProviderAccountSnapshot('netease');
    if (existing) {
        await saveProviderAccountSnapshot('netease', {
            user: existing.user,
            collections: existing.collections,
            likedSongIds: snapshot.likedSongs,
        });
    }
};

const assertReady = async () => {
    if (!isNativeSecurityAvailable()) throw new Error('Cloud sync is only available in the iOS app.');
    const state = await authState();
    if (!state.signedIn) throw new Error('Sign in with Google before syncing.');
    return state;
};

/**
 * Seals and uploads the local snapshot. The key check is written once and can never be replaced:
 * another device with a different key is refused instead of silently overwriting the vault.
 */
export const syncVault = async (): Promise<{ savedAt: number }> => {
    await assertReady();

    const localCheck = await keyCheck(); // Face ID: the Keychain item is biometry-protected
    const remoteCheck = await syncGet('vaultKeyCheck');
    if (remoteCheck && remoteCheck !== localCheck) {
        throw new Error('This account was encrypted with a different key on another device. Use “Start Fresh” on this device, or sign in on the device that owns the key.');
    }
    if (!remoteCheck) await syncPut('vaultKeyCheck', localCheck);

    const snapshot = collectSnapshot();
    const ciphertext = await seal(JSON.stringify(snapshot));
    const meta: VaultMeta = { version: 1, savedAt: snapshot.savedAt, device: 'iOS' };

    await syncPut('vault', ciphertext);
    await syncPut('vaultMeta', JSON.stringify(meta));
    return { savedAt: snapshot.savedAt };
};

/** Downloads and opens the vault. Face ID is required by the Keychain item. */
export const restoreVault = async (): Promise<{ savedAt: number }> => {
    await assertReady();

    const ciphertext = await syncGet('vault');
    if (!ciphertext) throw new Error('There is no cloud vault for this account yet.');
    const snapshot = parseSnapshot(await open(ciphertext));
    await applySnapshot(snapshot);
    return { savedAt: snapshot.savedAt };
};

export const readVaultMeta = async (): Promise<VaultMeta | null> => {
    if (!isNativeSecurityAvailable()) return null;
    const raw = await syncGet('vaultMeta');
    if (!raw) return null;
    try {
        const meta = JSON.parse(raw) as Partial<VaultMeta>;
        return meta.version === 1 && typeof meta.savedAt === 'number'
            ? { version: 1, savedAt: meta.savedAt, device: typeof meta.device === 'string' ? meta.device : 'iOS' }
            : null;
    } catch {
        return null;
    }
};

/**
 * Explicit, destructive reset: removes the cloud vault and this device's key. Used when the
 * account's key lives on another device and this one cannot open it. The UI asks for confirmation.
 */
export const startFresh = async (): Promise<void> => {
    await assertReady();
    await syncDelete('vault');
    await syncDelete('vaultMeta');
    await syncDelete('vaultKeyCheck');
    await resetVaultKey();
};
