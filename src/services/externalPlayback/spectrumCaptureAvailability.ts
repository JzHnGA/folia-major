import { omni } from '../onlineMusic/omni';

// src/services/externalPlayback/spectrumCaptureAvailability.ts
// Whether the Apple Music spectrum switch makes sense on this build. The settings row and the command palette
// both ask this one function, so neither can offer the switch where the other hides it.

/** The Apple Music provider is registered only on macOS desktop, so its presence is the platform check. */
export const isAppleMusicSpectrumCaptureAvailable = (): boolean => {
    try {
        return omni.getProviderSummaries().some(provider => provider.providerId === 'apple-music');
    } catch {
        return false;
    }
};
