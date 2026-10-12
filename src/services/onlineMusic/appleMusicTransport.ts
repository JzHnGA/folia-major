import { OnlineProviderError } from '../../types/onlineMusic';
import type { ExternalPlaybackState, ProviderErrorCode } from '../../types/onlineMusic';
// src/services/onlineMusic/appleMusicTransport.ts

export type AppleMusicOperation = 'probe' | 'listPlaylists' | 'getPlaylistTracks' | 'searchLibrary' | 'getTrack' | 'getArtwork'
    | 'play' | 'pause' | 'resume' | 'seek' | 'setVolume' | 'stop' | 'getState';
export type AppleMusicBridgeResult<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: ProviderErrorCode; message: string } };
export interface AppleMusicTrackRecord { id: string; name: string; artist: string; albumArtist: string; album: string; duration: number; artworkAssetId?: string }
export interface AppleMusicPlaylistRecord { id: string; name: string; kind: 'library' | 'user' | 'smart' }
export type AppleMusicPermission = 'granted' | 'denied' | 'unknown';

const PROVIDER_ID = 'apple-music';

// The probe sends no Apple Event, so only real requests can tell whether Automation access was granted.
let permission: AppleMusicPermission = 'unknown';

export const isAppleMusicBridgeAvailable = (): boolean => (
    typeof window !== 'undefined'
    && window.electron?.platform === 'darwin'
    && typeof window.electron?.appleMusic?.request === 'function'
);

export const getAppleMusicPermission = (): AppleMusicPermission => permission;

// Sends one operation to the main-process Music app bridge; failures become OnlineProviderError and the answer updates the known permission.
export async function requestAppleMusic<T = unknown>(op: AppleMusicOperation, args: Record<string, unknown> = {}): Promise<T> {
    if (!isAppleMusicBridgeAvailable()) {
        throw new OnlineProviderError('unavailable', 'Apple Music requires the macOS desktop app', PROVIDER_ID);
    }
    let result: AppleMusicBridgeResult;
    try {
        result = await window.electron!.appleMusic!.request(op, args);
    } catch (error) {
        throw new OnlineProviderError('network', 'Apple Music bridge request failed', PROVIDER_ID, error);
    }
    if (!result.ok) {
        if (result.error.code === 'auth-required') permission = 'denied';
        throw new OnlineProviderError(result.error.code, result.error.message, PROVIDER_ID);
    }
    if (op !== 'probe') permission = 'granted';
    return result.data as T;
}

// Tells the main process whether anyone is listening, so it can poll faster or stop polling.
export function setAppleMusicMonitoring(active: boolean): void {
    if (!isAppleMusicBridgeAvailable()) return;
    // A refused IPC call only means monitoring stays as it was; there is nobody to report it to.
    void Promise.resolve(window.electron!.appleMusic!.setMonitoring(active)).catch(() => undefined);
}

export function subscribeAppleMusicState(listener: (state: ExternalPlaybackState) => void): () => void {
    if (!isAppleMusicBridgeAvailable() || typeof window.electron!.appleMusic!.onState !== 'function') return () => undefined;
    return window.electron!.appleMusic!.onState(listener);
}
