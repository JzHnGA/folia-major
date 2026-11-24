import { isNativeAppShell } from '../../../utils/appSurface';

// src/library/suites/bravais/bravaisTileTransform.ts
// Where a library-wall tile sits: one string, written by the tile's own style (BravaisTile) and by
// the reflow driver frame by frame (useBravaisReflowDriver), which must agree exactly - the driver
// writes the settled rect back as the same string React rendered.
//
// translate3d gave every tile its own GPU layer. On the iPhone that memory is charged to the web
// process: with a few dozen tiles on the wall the page started at ~725 MB before anything played
// (2026-11-21), most of the headroom under iOS's 2 GB limit. The native shell positions tiles in 2D,
// so they paint into the wall's own layer; desktop keeps translate3d.

const FLAT = isNativeAppShell();

export const bravaisTileTransform = (x: number, y: number, flat = FLAT): string => (
    flat ? `translate(${x}px, ${y}px)` : `translate3d(${x}px, ${y}px, 0)`
);
