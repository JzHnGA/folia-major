import type { ProviderErrorCode } from '../../types/onlineMusic';
// src/services/onlineMusic/appleMusicTransport.ts

export type AppleMusicOperation = 'probe' | 'listPlaylists' | 'getPlaylistTracks' | 'searchLibrary' | 'getTrack' | 'getArtwork'
    | 'play' | 'pause' | 'resume' | 'seek' | 'setVolume' | 'stop' | 'getState';
export type AppleMusicBridgeResult<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: ProviderErrorCode; message: string } };
export interface AppleMusicTrackRecord { id: string; name: string; artist: string; albumArtist: string; album: string; duration: number; artworkAssetId?: string }
export interface AppleMusicPlaylistRecord { id: string; name: string; kind: 'library' | 'user' | 'smart' }
export type AppleMusicPermission = 'granted' | 'denied' | 'unknown';
