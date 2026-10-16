import { describe, expect, it } from 'vitest';
import { envelopeEndsAt, envelopeValueAt } from '@/services/gainEnvelope';

// test/unit/services/gainEnvelope.test.ts
// Reading a gain envelope back at a point in time, the way Web Audio plays a value curve.

describe('envelopeValueAt', () => {
    it('holds the previous value until the envelope starts', () => {
        expect(envelopeValueAt({ startAt: 2, seconds: 1, points: [0, 1] }, 0.7, 1)).toBe(0.7);
    });

    it('interpolates evenly spaced points linearly', () => {
        expect(envelopeValueAt({ startAt: 0, seconds: 2, points: [1, 0, 1] }, 1, 0.5)).toBeCloseTo(0.5);
        expect(envelopeValueAt({ startAt: 0, seconds: 2, points: [1, 0, 1] }, 1, 1.5)).toBeCloseTo(0.5);
    });

    it('sets instantly and holds the last point afterwards', () => {
        expect(envelopeValueAt({ startAt: 1, seconds: 0, points: [0.2, 0.4] }, 1, 1)).toBe(0.4);
        expect(envelopeValueAt({ startAt: 0, seconds: 1, points: [1, 0.3] }, 1, 5)).toBe(0.3);
    });

    it('holds the given value when there is no envelope', () => {
        expect(envelopeValueAt(null, 0.6, 3)).toBe(0.6);
    });
});

describe('envelopeEndsAt', () => {
    it('ends seconds after it starts, and never for no envelope', () => {
        expect(envelopeEndsAt({ startAt: 2, seconds: 1.5, points: [0, 1] })).toBe(3.5);
        expect(envelopeEndsAt(null)).toBe(-Infinity);
    });
});
