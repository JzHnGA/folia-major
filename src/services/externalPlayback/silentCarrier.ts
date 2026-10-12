import { createSafeObjectUrl } from '../../utils/blobGuards';

// src/services/externalPlayback/silentCarrier.ts
// Silent WAV carrier that keeps Folia's lyric clock running while Music.app plays the real audio.

const WAV_HEADER_BYTES = 44;
const SILENT_U8_SAMPLE = 0x80;

const writeAscii = (bytes: Uint8Array, offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
};

// Builds a mono 8-bit unsigned PCM WAV whose sample count covers durationSec, filled with silence.
export const createSilentWavBytes = (durationSec: number, sampleRate = 8000): Uint8Array<ArrayBuffer> => {
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        throw new RangeError(`Silent carrier duration must be positive and finite: ${durationSec}`);
    }
    const dataBytes = Math.ceil(durationSec * sampleRate);
    const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
    const view = new DataView(bytes.buffer);
    writeAscii(bytes, 0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    writeAscii(bytes, 8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);   // byte rate: one byte per sample
    view.setUint16(32, 1, true);            // block align
    view.setUint16(34, 8, true);            // bits per sample
    writeAscii(bytes, 36, 'data');
    view.setUint32(40, dataBytes, true);
    bytes.fill(SILENT_U8_SAMPLE, WAV_HEADER_BYTES);
    return bytes;
};

// Wraps the silent WAV in an object URL for the carrier <audio>; returns null when Blob URLs are unavailable.
export const createSilentCarrierUrl = (durationSec: number): string | null => (
    createSafeObjectUrl(new Blob([createSilentWavBytes(durationSec)], { type: 'audio/wav' }))
);
