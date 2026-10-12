import { expect, it } from 'vitest';
import { createSilentWavBytes } from '@/services/externalPlayback/silentCarrier';

// test/unit/externalPlayback/silentCarrier.test.ts
// The silent carrier WAV: 8 kHz mono 8-bit PCM header, midpoint samples, and sample count rounded up.

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));

it('writes a PCM header for 8 kHz mono 8-bit audio', () => {
    const bytes = createSilentWavBytes(1.5);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(ascii(bytes, 8, 16)).toBe('WAVEfmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);      // PCM
    expect(view.getUint16(22, true)).toBe(1);      // mono
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(8000);   // byte rate
    expect(view.getUint16(32, true)).toBe(1);      // block align
    expect(view.getUint16(34, true)).toBe(8);
    expect(ascii(bytes, 36, 40)).toBe('data');
    expect(view.getUint32(40, true)).toBe(12000);
    expect(bytes.length).toBe(44 + 12000);
});
it('fills the data chunk with the unsigned 8-bit midpoint', () => {
    expect(createSilentWavBytes(0.25).slice(44).every(byte => byte === 0x80)).toBe(true);
});
it('rounds the sample count up so the carrier never ends before the track', () => {
    expect(createSilentWavBytes(0.00001).length).toBe(45);
    expect(createSilentWavBytes(213.4567).length).toBe(44 + Math.ceil(213.4567 * 8000));
});
it('rejects durations that are not positive and finite', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => createSilentWavBytes(value)).toThrow();
});
