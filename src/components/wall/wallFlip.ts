import { isNativeAppShell } from '../../utils/appSurface';
import { WALL_HANDOFF_PERSPECTIVE_PX } from './wallHandoff';

// src/components/wall/wallFlip.ts
// How a wall card draws its half-turn flip: the library wall's tile flips (BravaisTile), and the
// handoff between the library wall and Lattice on both sides (useBravaisWallHandoff, LatticePoster).
//
// Desktop draws a real 3D turn: perspective + rotateY. On the iPhone that turn crashed the app
// (2026-11-21): any element with a 3D transform, or with a transform animation the compositor runs
// (WAAPI on transform), gets its own GPU backing store at its full size - even edge-on, when it
// shows nothing. A handoff holds every Lattice poster edge-on and turns every library tile out at
// the same moment, so both walls were a few hundred full-size layers at once, and iOS killed the
// web process at its 2 GB limit within a second of Lattice opening. The simulator never showed it:
// it does not charge layer memory to the web process.
//
// So the native shell draws the same beat flat, on the same timing and easing:
// - WAAPI keyframes (library wall) close and open a centred clip-path wipe. WebKit does not run
//   clip-path animations on the compositor, so the tile paints into its wall's layer as before.
// - Framer-driven posters (Lattice) squash on X by cos(angle). Framer writes that transform from JS
//   each frame and it has no 3D term, so the poster is not promoted either.

/** True in the iOS shell: wall flips draw flat there (see above). Read once - it cannot change. */
export const WALL_FLIP_FLAT = isNativeAppShell();

/** One keyframe of a half-turn at `degrees` (0 = facing, ±90 = edge-on), for `element.animate`. */
export const wallFlipKeyframe = (degrees: number, flat = WALL_FLIP_FLAT): Keyframe => {
    if (!flat) return { transform: `perspective(${WALL_HANDOFF_PERSPECTIVE_PX}px) rotateY(${degrees}deg)` };
    // Each side closes by half the width the turn hides: 0% facing, 50% (a centred line) edge-on.
    const hidden = (1 - Math.abs(Math.cos((degrees * Math.PI) / 180))) * 50;
    const inset = `${hidden.toFixed(3)}%`;
    return { clipPath: `inset(0 ${inset} 0 ${inset})` };
};

/** Horizontal scale that stands in for a turn of `degrees` in the flat drawing. */
export const flatFlipScaleX = (degrees: number): number => Math.abs(Math.cos((degrees * Math.PI) / 180));
