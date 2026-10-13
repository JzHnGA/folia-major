// src/services/gainEnvelope.ts
// The shape of a gain move, as data. Automix writes these onto Web Audio parameters; anything that
// has to follow the same move somewhere Web Audio cannot reach reads them instead of the parameter.

/**
 * From startAt on the AudioContext clock, `points` evenly spaced over `seconds`, linear in between;
 * seconds 0 sets points.at(-1) at startAt. Before startAt the gain holds whatever it was.
 */
export interface DeckGainEnvelope {
    startAt: number;
    seconds: number;
    points: readonly number[];
}

/** The gain at `time`: `held` before the envelope starts (or when there is none), its last point after it ends. */
export const envelopeValueAt = (envelope: DeckGainEnvelope | null, held: number, time: number): number => {
    if (!envelope || envelope.points.length === 0 || time < envelope.startAt) return held;
    const { points, seconds } = envelope;
    const last = points[points.length - 1];
    if (seconds <= 0 || time >= envelope.startAt + seconds) return last;
    // Web Audio's value curve: points evenly spaced over the duration, linear in between.
    const position = ((time - envelope.startAt) / seconds) * (points.length - 1);
    const index = Math.floor(position);
    if (index >= points.length - 1) return last;
    return points[index] + (points[index + 1] - points[index]) * (position - index);
};

/** startAt + seconds; -Infinity for none. */
export const envelopeEndsAt = (envelope: DeckGainEnvelope | null): number => (
    envelope ? envelope.startAt + envelope.seconds : -Infinity
);
