// src/components/wall/seamPlan.ts

import type { WallMetrics } from './layout';
import { getViewLineX, type WallView } from './wallView';
import { getBlockSize } from './wallSlots';

// Where a split may open and how it reacts to the camera. The split only ever opens on a block
// boundary: no slot crosses the gap between two 12x8 blocks, so nothing is squeezed or cut.
// When the chosen boundary cannot hold the whole opening on screen, the camera yields the minimum
// distance instead. The split belongs to the world (it rides with the camera) and narrows as it
// nears a viewport edge, closing completely once it leaves. Opening widths are the caller's.
// A split runs along one axis: 'x' opens between two block columns (left and right halves, the
// default), 'y' between two block rows (top and bottom halves). The y helpers mirror the x ones.

/** 'x': the split stands between two block columns; 'y': it lies between two block rows. */
export type SeamAxis = 'x' | 'y';

/** Screen-px margin kept between an open split and the viewport edge. */
export const SEAM_EDGE_MARGIN = 14;
/** Weight of "distance from the base line" against "camera shift" when choosing a boundary. */
export const SEAM_LINE_DISTANCE_WEIGHT = 0.15;

/** Screen coordinate of the base line along `axis` (the vertical middle for 'y'). */
export const getViewLine = (view: WallView, axis: SeamAxis) => (axis === 'x' ? getViewLineX(view) : view.height / 2);
/** The viewport's extent along `axis`. */
const getViewExtent = (view: WallView, axis: SeamAxis) => (axis === 'x' ? view.width : view.height);
const getBlockSpan = (metrics: WallMetrics, axis: SeamAxis) => {
    const size = getBlockSize(metrics);
    return axis === 'x' ? size.width : size.height;
};

/** How far the gap midline stands before a block's leading edge (half of the gap, street included). */
const seamOffset = (metrics: WallMetrics, blockSpan: number, axis: SeamAxis) => (
    (blockSpan - getBlockSpan(metrics, axis) + metrics.gap) / 2
);

const getSeamBoundary = (index: number, metrics: WallMetrics, blockSpan: number, axis: SeamAxis) => (
    index * blockSpan - seamOffset(metrics, blockSpan, axis)
);

const nearestSeamBoundary = (at: number, metrics: WallMetrics, blockSpan: number, axis: SeamAxis) => (
    getSeamBoundary(Math.round((at + seamOffset(metrics, blockSpan, axis)) / blockSpan), metrics, blockSpan, axis)
);

/**
 * World x of the gap midline on the left edge of block `column`. `blockWidth` is the distance
 * between two blocks' left edges: a wall whose blocks stand further apart than the 12-unit block
 * (a street between them) passes its own; the midline is then the middle of the wider gap.
 */
export const getSeamBoundaryX = (column: number, metrics: WallMetrics, blockWidth = getBlockSize(metrics).width) => (
    getSeamBoundary(column, metrics, blockWidth, 'x')
);

export const nearestSeamBoundaryX = (x: number, metrics: WallMetrics, blockWidth = getBlockSize(metrics).width) => (
    nearestSeamBoundary(x, metrics, blockWidth, 'x')
);

export const isSeamBoundaryX = (x: number, metrics: WallMetrics) => (
    Math.abs(nearestSeamBoundaryX(x, metrics) - x) < 1e-6
);

/** World y of the gap midline on the top edge of block `row` (see getSeamBoundaryX). */
export const getSeamBoundaryY = (row: number, metrics: WallMetrics, blockHeight = getBlockSize(metrics).height) => (
    getSeamBoundary(row, metrics, blockHeight, 'y')
);

export const nearestSeamBoundaryY = (y: number, metrics: WallMetrics, blockHeight = getBlockSize(metrics).height) => (
    nearestSeamBoundary(y, metrics, blockHeight, 'y')
);

export type SeamPlan = {
    /** World x of the split (a block boundary unless `preferX` said otherwise). */
    x: number;
    /** View centre x after yielding; equals the input when the split already fits. */
    cameraX: number;
    /** Camera shift in screen px. */
    shift: number;
};

export type BlockSeamPlanInput = {
    /** Current view centre x (world point under the base line). */
    cameraX: number;
    /** Width the split is about to open to, in screen px. */
    openWidth: number;
    view: WallView;
    metrics: WallMetrics;
    /** The distance between two blocks' left edges, when the wall's blocks stand further apart (see getSeamBoundaryX). */
    blockWidth?: number;
    /** Keep this boundary (the split is visible and stays put); only the camera may yield. */
    preferX?: number;
    edge?: number;
    /**
     * Screen px already taken on the left / right by something the split must also clear (the iOS
     * landscape safe area). Added on top of `edge`; default 0 keeps the symmetric plan.
     */
    edgeBefore?: number;
    edgeAfter?: number;
};

type AxisPlanInput = {
    camera: number;
    openWidth: number;
    view: WallView;
    metrics: WallMetrics;
    blockSpan: number;
    prefer?: number;
    edge: number;
    edgeBefore?: number;
    edgeAfter?: number;
    axis: SeamAxis;
};

const planOnAxis = ({ camera, openWidth, view, metrics, blockSpan, prefer, edge, edgeBefore = 0, edgeAfter = 0, axis }: AxisPlanInput) => {
    const line = getViewLine(view, axis);
    const extent = getViewExtent(view, axis);
    const need = openWidth / 2 + edge;
    const lower = edgeBefore + need;
    const upper = extent - edgeAfter - need;
    const base = Math.round((camera + metrics.gap / 2) / blockSpan);
    const candidates = prefer !== undefined
        ? [prefer]
        : [base - 1, base, base + 1].map(index => getSeamBoundary(index, metrics, blockSpan, axis));

    let best: { at: number; camera: number; shift: number } | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const at of candidates) {
        const screen = line + (at - camera) * view.scale;
        // The opening must stay inside [lower, upper]; a viewport too narrow for both centres it.
        const fit = upper >= lower
            ? Math.min(upper, Math.max(lower, screen))
            : (edgeBefore + extent - edgeAfter) / 2;
        const nextCamera = at - (fit - line) / view.scale;
        const shift = Math.abs(nextCamera - camera) * view.scale;
        const score = shift + Math.abs(fit - line) * SEAM_LINE_DISTANCE_WEIGHT;
        if (!best || score < bestScore) {
            best = { at, camera: nextCamera, shift };
            bestScore = score;
        }
    }
    return best!;
};

/**
 * Picks the boundary for a split: the nearest few around the camera (or `preferX`), each moved
 * on screen by the smallest camera shift that fits the whole opening, scored by
 * shift + weight x distance from the base line.
 */
export const blockSeamPlan = ({
    cameraX,
    openWidth,
    view,
    metrics,
    blockWidth = getBlockSize(metrics).width,
    preferX,
    edge = SEAM_EDGE_MARGIN,
    edgeBefore = 0,
    edgeAfter = 0,
}: BlockSeamPlanInput): SeamPlan => {
    const plan = planOnAxis({ camera: cameraX, openWidth, view, metrics, blockSpan: blockWidth, prefer: preferX, edge, edgeBefore, edgeAfter, axis: 'x' });
    return { x: plan.at, cameraX: plan.camera, shift: plan.shift };
};

export type RowSeamPlan = {
    /** World y of the split (a block row boundary unless `preferY` said otherwise). */
    y: number;
    /** View centre y after yielding. */
    cameraY: number;
    /** Camera shift in screen px. */
    shift: number;
};

/** blockSeamPlan for a split between two block rows: `openWidth` is the opening's height. */
export const blockSeamPlanY = ({
    cameraY,
    openWidth,
    view,
    metrics,
    blockHeight = getBlockSize(metrics).height,
    preferY,
    edge = SEAM_EDGE_MARGIN,
    edgeBefore = 0,
    edgeAfter = 0,
}: {
    cameraY: number;
    openWidth: number;
    view: WallView;
    metrics: WallMetrics;
    blockHeight?: number;
    preferY?: number;
    edge?: number;
    edgeBefore?: number;
    edgeAfter?: number;
}): RowSeamPlan => {
    const plan = planOnAxis({ camera: cameraY, openWidth, view, metrics, blockSpan: blockHeight, prefer: preferY, edge, edgeBefore, edgeAfter, axis: 'y' });
    return { y: plan.at, cameraY: plan.camera, shift: plan.shift };
};

export type SeamGeometry = {
    /** Screen x of the split's centre. */
    screenX: number;
    /** Rendered opening: squeezed to twice the room left before the edge margin, 0 off screen. */
    width: number;
    /** Meant to be open but squeezed shut - show the edge tab on `side`. */
    collapsed: boolean;
    side: 'left' | 'right';
};

const geometryOnAxis = (
    anchor: number,
    camera: number,
    openWidth: number,
    view: WallView,
    edge: number,
    axis: SeamAxis,
    keepWidth: boolean,
    edgeBefore = 0,
    edgeAfter = 0,
) => {
    const line = getViewLine(view, axis);
    const screen = line + (anchor - camera) * view.scale;
    const extent = getViewExtent(view, axis);
    const room = Math.min(screen - edgeBefore, extent - edgeAfter - screen) - edge;
    // A narrow seam (the home rail / spine) has a fixed 120 / 64 px layout: squeezing it near the
    // viewport edge clips the tools and the "..." menu. Keep its full opening while its centre is
    // on screen, and let the part beyond the edge go off screen instead.
    const width = keepWidth && screen > edgeBefore && screen < extent - edgeAfter
        ? openWidth
        : Math.max(0, Math.min(openWidth, room * 2));
    return { screen, width, collapsed: openWidth > 1 && width < 2, before: screen < line };
};

/** Follow coupling: the split sits on its world anchor and narrows near the viewport edges. */
export const getSeamGeometry = ({
    anchorX,
    cameraX,
    openWidth,
    view,
    edge = SEAM_EDGE_MARGIN,
    keepWidth = false,
    edgeBefore = 0,
    edgeAfter = 0,
}: {
    anchorX: number;
    cameraX: number;
    openWidth: number;
    view: WallView;
    edge?: number;
    keepWidth?: boolean;
    /** Screen px taken before / after the opening (the iOS landscape safe area); see BlockSeamPlanInput. */
    edgeBefore?: number;
    edgeAfter?: number;
}): SeamGeometry => {
    const geometry = geometryOnAxis(anchorX, cameraX, openWidth, view, edge, 'x', keepWidth, edgeBefore, edgeAfter);
    return { screenX: geometry.screen, width: geometry.width, collapsed: geometry.collapsed, side: geometry.before ? 'left' : 'right' };
};

export type RowSeamGeometry = {
    /** Screen y of the split's centre line. */
    screenY: number;
    /** Rendered opening height, squeezed near the top and bottom edges like getSeamGeometry. */
    width: number;
    collapsed: boolean;
    side: 'top' | 'bottom';
};

/** getSeamGeometry for a split between two block rows. */
export const getSeamGeometryY = ({
    anchorY,
    cameraY,
    openWidth,
    view,
    edge = SEAM_EDGE_MARGIN,
    edgeBefore = 0,
    edgeAfter = 0,
}: {
    anchorY: number;
    cameraY: number;
    openWidth: number;
    view: WallView;
    edge?: number;
    edgeBefore?: number;
    edgeAfter?: number;
}): RowSeamGeometry => {
    const geometry = geometryOnAxis(anchorY, cameraY, openWidth, view, edge, 'y', false, edgeBefore, edgeAfter);
    return { screenY: geometry.screen, width: geometry.width, collapsed: geometry.collapsed, side: geometry.before ? 'top' : 'bottom' };
};

const cameraSpanOnAxis = (
    anchor: number,
    openWidth: number,
    view: WallView,
    edge: number,
    axis: SeamAxis,
    edgeBefore = 0,
    edgeAfter = 0,
) => {
    const line = getViewLine(view, axis);
    const extent = getViewExtent(view, axis);
    const need = openWidth / 2 + edge;
    const lower = edgeBefore + need;
    const upper = extent - edgeAfter - need;
    const min = anchor - (upper - line) / view.scale;
    const max = anchor + (line - lower) / view.scale;
    if (min <= max) return { min, max };
    // Wider than the usable viewport: the only sensible spot is centred in it.
    const centred = anchor - ((edgeBefore + extent - edgeAfter) / 2 - line) / view.scale;
    return { min: centred, max: centred };
};

/**
 * Camera x range that keeps the whole opening on screen. Camera clamps are widened to include it,
 * otherwise the yield from `blockSeamPlan` would be rubber-banded straight back.
 */
export const getSeamCameraSpan = ({
    anchorX,
    openWidth,
    view,
    edge = SEAM_EDGE_MARGIN,
    edgeBefore = 0,
    edgeAfter = 0,
}: {
    anchorX: number;
    openWidth: number;
    view: WallView;
    edge?: number;
    edgeBefore?: number;
    edgeAfter?: number;
}) => (
    cameraSpanOnAxis(anchorX, openWidth, view, edge, 'x', edgeBefore, edgeAfter)
);

/** Camera y range that keeps a row split's whole opening on screen (see getSeamCameraSpan). */
export const getSeamCameraSpanY = ({
    anchorY,
    openWidth,
    view,
    edge = SEAM_EDGE_MARGIN,
    edgeBefore = 0,
    edgeAfter = 0,
}: {
    anchorY: number;
    openWidth: number;
    view: WallView;
    edge?: number;
    edgeBefore?: number;
    edgeAfter?: number;
}) => (
    cameraSpanOnAxis(anchorY, openWidth, view, edge, 'y', edgeBefore, edgeAfter)
);

/**
 * Split mode moves each half away by half the opening plus half a gap (scaled), so the paper strip
 * sits one gap from the posters on both sides. Returns screen-px offsets for the two halves along
 * the split's axis (`left` is the top half for a row split).
 */
export const getSeamSplitOffsets = (width: number, scale: number, metrics: WallMetrics) => {
    const pad = (metrics.gap / 2) * scale * Math.min(1, width / 16);
    return { left: -width / 2 - pad, right: width / 2 + pad };
};
