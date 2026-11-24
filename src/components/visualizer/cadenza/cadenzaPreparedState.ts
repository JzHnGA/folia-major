import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext';
import { Line, Theme } from '../../../types';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import type { PreparedStateCacheContext } from './cadenzaTypes';
import { clamp, isCJK, splitGraphemes } from './cadenzaEnvelopes';
import { buildLineFragments, buildSegmentMetas, findWordRanges } from './cadenzaFragments';
import { buildWordPlacements } from './cadenzaPlacements';

// src/components/visualizer/cadenza/cadenzaPreparedState.ts
// 一行歌词的完整准备：选字号、pretext 测量换行、切片段、算落点。整个模式最贵的一步，结果由组件缓存。

const chooseFontPx = (width: number, line: Line) => {
    const graphemeCount = splitGraphemes(line.fullText).length || 1;
    const wordCount = line.words.length || 1;
    const widthBase = clamp(width * 0.086, 34, 94);
    const lengthPenalty = graphemeCount > 12 ? Math.min((graphemeCount - 12) * 1.8, 34) : 0;
    const densityPenalty = wordCount > 7 ? Math.min((wordCount - 7) * 1.5, 18) : 0;
    return clamp(widthBase - lengthPenalty - densityPenalty, 28, 104);
};

/** 有安全区时落点离安全区边缘至少留的距离：给唱到时的 1.3 倍放大和唱过后的漂移。 */
const SAFE_EDGE_GAP = 16;

const buildCanvasFont = (theme: Theme, fontPx: number) => `${resolveThemeFontWeight(theme, 700)} ${fontPx}px ${resolveThemeFontStack(theme)}`;

export const buildPreparedState = (
    line: Line,
    context: PreparedStateCacheContext,
) => {
    const { showText, viewport, safeSides, theme, tuning } = context;

    if (!showText || viewport.width <= 0 || viewport.height <= 0) {
        return null;
    }

    const fontPx = clamp(chooseFontPx(viewport.width, line) * tuning.fontScale, 24, 132);
    const font = buildCanvasFont(theme, fontPx);
    // This is the expensive part of the mode.
    // Once a line reaches here, we fully measure it, wrap it, split it, and convert it into placement-ready fragments.
    const prepared = prepareWithSegments(line.fullText, font);
    const text = prepared.segments.join('');
    const { segmentMetas, graphemes } = buildSegmentMetas(prepared);
    const lineHeight = Math.round(fontPx * (isCJK(text) ? 1.22 : 1.1));
    // 换行宽度按安全区内的宽度算（横屏时灵动岛 / 刘海占掉两侧）；没有安全区时就是整个视口宽
    const safeWidth = viewport.width - safeSides.left - safeSides.right;
    const availableWidth = Math.max(safeWidth - 48, 120);
    const minWidth = Math.min(220, availableWidth);
    const wrapCompression = graphemes.length > 12
        ? clamp(0.92 - (graphemes.length - 12) * 0.018, 0.62, 0.92)
        : 0.92;
    const compactWidthRatio = tuning.widthRatio * wrapCompression;
    const maxWidth = clamp(Math.min(safeWidth * compactWidthRatio, 820), minWidth, availableWidth);
    // 落点平时可以比换行宽度往外多散 72px；有安全区时再限在安全区内（留一点给放大和漂移），
    // 没有安全区时不设限，和以前一样
    const hasSafeSides = safeSides.left > 0 || safeSides.right > 0;
    const horizontalLimit = hasSafeSides ? Math.max(safeWidth / 2 - SAFE_EDGE_GAP, maxWidth / 2) : Infinity;
    const layout = layoutWithLines(prepared, maxWidth, lineHeight);
    const ranges = findWordRanges(line, graphemes, theme);
    const lineFragments = buildLineFragments(prepared, segmentMetas, graphemes, layout, ranges);
    const placements = buildWordPlacements(
        lineFragments,
        fontPx,
        lineHeight,
        maxWidth,
        theme.animationIntensity,
        line.startTime * 1000,
        line.fullText === '......',
        horizontalLimit,
    );

    return {
        prepared,
        text,
        font,
        fontPx,
        lineHeight,
        maxWidth,
        layout,
        segmentMetas,
        graphemes,
        placements,
    };
};
