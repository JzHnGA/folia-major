import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import i18n from '../i18n/config';
import { omni } from '../services/onlineMusic/omni';
import { createSpectrumCaptureController } from '../services/externalPlayback/spectrumCaptureController';
import { startSystemAudioCapture } from '../services/externalPlayback/systemAudioCapture';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { PlayerState } from '../types';

// src/hooks/useAppleMusicSpectrumCapture.ts
// While an Apple Music song plays (the sound comes from Music.app, Folia only plays a silent carrier), captures system
// audio so the spectrum and audio-reactive visuals follow the music. Returns the capture's analyser, which the
// visualizer bridge reads instead of the main analyser for external songs. Capturing only while such a song plays
// keeps macOS's recording indicator off the rest of the time.

type UseAppleMusicSpectrumCaptureParams = {
    audioContextRef: MutableRefObject<AudioContext | null>;
};

// The denial notice is shown once per app session; a failed start is not retried until the setting is toggled again.
let hasShownCaptureFailureNotice = false;

const reportCaptureFailure = (error: unknown) => {
    console.warn('[AppleMusicSpectrum] system audio capture failed', error);
    if (hasShownCaptureFailureNotice) return;
    hasShownCaptureFailureNotice = true;
    setStatusMessage({ type: 'error', text: i18n.t('appleMusic.spectrumCaptureDenied') });
};

export function useAppleMusicSpectrumCapture({
    audioContextRef,
}: UseAppleMusicSpectrumCaptureParams): MutableRefObject<AnalyserNode | null> {
    const enabled = useAudioSettingsStore(state => state.appleMusicSpectrumCapture);
    // Booleans, so the hook re-renders only when the answer changes, not on every song or progress update.
    const isExternal = usePlaybackStore(state => omni.isExternalPlaybackSong(state.currentSong));
    const isPlaying = usePlaybackStore(state => state.playerState === PlayerState.PLAYING);
    const captureAnalyserRef = useRef<AnalyserNode | null>(null);
    const context = audioContextRef.current;

    // The AudioContext is created on first play and lives in a ref, so nothing re-renders when it appears; the
    // controller polls getContext for it itself while a capture is wanted, instead of this hook re-rendering App.
    const [controller] = useState(() => createSpectrumCaptureController({
        start: audioContext => startSystemAudioCapture(audioContext),
        publish: analyser => { captureAnalyserRef.current = analyser; },
        onFailure: reportCaptureFailure,
        getContext: () => audioContextRef.current,
    }));

    useEffect(() => {
        controller.update({ enabled, isExternal, isPlaying, context });
    }, [controller, enabled, isExternal, isPlaying, context]);

    useEffect(() => () => controller.dispose(), [controller]);

    return captureAnalyserRef;
}
