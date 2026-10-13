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
