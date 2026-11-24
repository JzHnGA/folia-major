// src/components/nightstand/widgets/nightstandWidgets.ts
// Nightstand 小组件的清单与持久化：顺序 + 隐藏集合 + 卡片样式 + 排列方式存 localStorage，只记一份。
// 卡片外壳默认走 Folia 的玻璃面板（theme-glass-panel + 圆角 + backdrop-blur），与设置面板同一套语言；
// 「实心」「极简」是给同一张卡的另两种皮肤（见 NightstandOverlay 的 cardClassFor）。

import { getStoredString, setStoredString } from '../../../stores/storagePrimitives';

export type NightstandWidgetId = 'clock' | 'weather' | 'calendar' | 'hitokoto' | 'albumArt';

export type NightstandCardStyle = 'glass' | 'solid' | 'minimal';
export type NightstandLayout = 'row' | 'grid';
/** 每张卡的尺寸档位，对齐 iOS 小组件族（小 / 中 / 大）。 */
export type NightstandWidgetSize = 'S' | 'M' | 'L';

/** 每张小组件卡拿到自己的档位，按档位排版。 */
export type NightstandWidgetProps = { size: NightstandWidgetSize };

export type NightstandWidgetsConfig = {
    /** 展示顺序（从左到右）。 */
    order: NightstandWidgetId[];
    /** 被用户关掉的。 */
    hidden: NightstandWidgetId[];
    /** 卡片皮肤：玻璃（默认）/ 实心 / 极简（无底板，纯投影文字）。 */
    cardStyle: NightstandCardStyle;
    /** 排列：横排（格子铺满屏宽，放不下换行）/ 网格（固定 4 列，像 iPhone 主屏）。 */
    layout: NightstandLayout;
    /** 每张卡的尺寸档位；缺省按卡取默认值（见 widgetSizeOf）。 */
    sizes: Partial<Record<NightstandWidgetId, NightstandWidgetSize>>;
};

export const NIGHTSTAND_WIDGETS_STORAGE_KEY = 'nightstand_widgets_v1';

const SIZE_TIERS: readonly NightstandWidgetSize[] = ['S', 'M', 'L'];

export const NIGHTSTAND_WIDGET_IDS: readonly NightstandWidgetId[] = ['clock', 'weather', 'calendar', 'hitokoto', 'albumArt'];

const DEFAULT_CONFIG: NightstandWidgetsConfig = {
    order: ['clock', 'weather', 'calendar'],
    hidden: ['hitokoto', 'albumArt'],
    cardStyle: 'glass',
    layout: 'row',
    sizes: {},
};

/**
 * 尺寸档位 → 占几格（列 × 行），对齐 iOS 主屏小组件：小 1×1、中 2×1、大 2×2。
 * 卡片按格子定死大小，换档只改它自己占的格数，不会撑大同一行的别的卡；
 * 大档位多出来的地方用来显示更多信息，而不是把内容放大（HIG widgets › Best practices）。
 */
export const NIGHTSTAND_SIZE_SPAN: Record<NightstandWidgetSize, { cols: 1 | 2; rows: 1 | 2 }> = {
    S: { cols: 1, rows: 1 },
    M: { cols: 2, rows: 1 },
    L: { cols: 2, rows: 2 },
};

/** 每张卡支持的档位：一言在 1×1 里放不下一句话，不提供小号。 */
export const NIGHTSTAND_SUPPORTED_SIZES: Record<NightstandWidgetId, readonly NightstandWidgetSize[]> = {
    clock: ['S', 'M', 'L'],
    weather: ['S', 'M', 'L'],
    calendar: ['S', 'M', 'L'],
    hitokoto: ['M', 'L'],
    albumArt: ['S', 'M', 'L'],
};

/** 没设过尺寸时各卡的默认档位。 */
const DEFAULT_WIDGET_SIZES: Record<NightstandWidgetId, NightstandWidgetSize> = {
    clock: 'M',
    weather: 'S',
    calendar: 'M',
    hitokoto: 'M',
    albumArt: 'S',
};

/** 把一个档位钳到这张卡支持的档位里（取档位顺序上最近的那个，平局取大的）。 */
export const clampSizeFor = (id: NightstandWidgetId, size: NightstandWidgetSize): NightstandWidgetSize => {
    const supported = NIGHTSTAND_SUPPORTED_SIZES[id];
    if (supported.includes(size)) return size;
    const index = SIZE_TIERS.indexOf(size);
    let best = supported[0];
    for (const candidate of supported) {
        const distance = Math.abs(SIZE_TIERS.indexOf(candidate) - index);
        const bestDistance = Math.abs(SIZE_TIERS.indexOf(best) - index);
        if (distance < bestDistance || (distance === bestDistance && SIZE_TIERS.indexOf(candidate) > SIZE_TIERS.indexOf(best))) best = candidate;
    }
    return best;
};

/** 一张卡当前的档位：存过的（钳到支持范围内）或默认值。 */
export const widgetSizeOf = (config: NightstandWidgetsConfig, id: NightstandWidgetId): NightstandWidgetSize =>
    clampSizeFor(id, config.sizes[id] ?? DEFAULT_WIDGET_SIZES[id]);

/** 点一下尺寸手柄（或读屏的激活动作）：在支持的档位里循环到下一档。 */
export const nextWidgetSize = (id: NightstandWidgetId, size: NightstandWidgetSize): NightstandWidgetSize => {
    const supported = NIGHTSTAND_SUPPORTED_SIZES[id];
    const index = supported.indexOf(clampSizeFor(id, size));
    return supported[(index + 1) % supported.length];
};

/**
 * 卡片内的长度按格子边长（--ns-cell，NightstandOverlay 设在网格上）算：同一个字号在小、中、大三档里一样大，
 * 大档位多出来的面积用来放更多信息。字号下限 11px（HIG widgets › Avoid very small font sizes）。
 */
export const cellLength = (k: number): string => `calc(var(--ns-cell) * ${k})`;
export const cellFont = (k: number): string => `max(11px, ${cellLength(k)})`;

/** 在 order 里把一张卡往前/后挪一位（越界不动）。 */
export const moveWidget = (order: NightstandWidgetId[], id: NightstandWidgetId, direction: -1 | 1): NightstandWidgetId[] => {
    const index = order.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return order;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
};

/** 拖拽落点换算：把 draggedId 挪到 targetId 的前/后；任一边不在 order 里就原样返回。 */
export const reorderedForDrop = (
    order: NightstandWidgetId[],
    draggedId: NightstandWidgetId,
    targetId: NightstandWidgetId,
    placeAfter: boolean,
): NightstandWidgetId[] => {
    if (draggedId === targetId || !order.includes(draggedId) || !order.includes(targetId)) return order;
    const without = order.filter(id => id !== draggedId);
    const targetIndex = without.indexOf(targetId);
    without.splice(placeAfter ? targetIndex + 1 : targetIndex, 0, draggedId);
    return without;
};

/** 朝远离零的方向过半进位（Math.round(-0.5) 是 -0，直接 round 左右不对称）。 */
const roundSteps = (delta: number, step: number): number => Math.trunc(delta / step + Math.sign(delta) * 0.5);

/**
 * 尺寸拖拽的位移 → 新档位。手柄在右下角：向右加一列、向下加一行，每过半格进一档。
 * step 是一格加间距的像素数（由调用方按实际格子量出来）。占 2 行就只能是大号（没有 1×2 的档位），
 * 结果再钳到这张卡支持的档位里。
 */
export const sizeForResizeDrag = (
    id: NightstandWidgetId,
    base: NightstandWidgetSize,
    dx: number,
    dy: number,
    step: number,
): NightstandWidgetSize => {
    const span = NIGHTSTAND_SIZE_SPAN[base];
    const cols = Math.min(2, Math.max(1, span.cols + roundSteps(dx, step)));
    const rows = Math.min(2, Math.max(1, span.rows + roundSteps(dy, step)));
    const size: NightstandWidgetSize = rows === 2 ? 'L' : cols === 2 ? 'M' : 'S';
    return clampSizeFor(id, size);
};

const isWidgetId = (value: unknown): value is NightstandWidgetId =>
    typeof value === 'string' && (NIGHTSTAND_WIDGET_IDS as readonly string[]).includes(value);

export const readNightstandWidgets = (): NightstandWidgetsConfig => {
    try {
        const raw = getStoredString(NIGHTSTAND_WIDGETS_STORAGE_KEY, '');
        if (!raw) return DEFAULT_CONFIG;
        const value = JSON.parse(raw) as Record<string, unknown> | null;
        const order = Array.isArray(value?.order) ? value.order.filter(isWidgetId) : [];
        const hidden = Array.isArray(value?.hidden) ? value.hidden.filter(isWidgetId) : [];
        // 后加的小组件不在旧 order 里：补到末尾，不让它们静默消失。
        const merged = [...order, ...NIGHTSTAND_WIDGET_IDS.filter(id => !order.includes(id))];
        const cardStyle: NightstandCardStyle =
            value?.cardStyle === 'solid' || value?.cardStyle === 'minimal' ? value.cardStyle : 'glass';
        const layout: NightstandLayout = value?.layout === 'grid' ? 'grid' : 'row';
        const sizes: NightstandWidgetsConfig['sizes'] = {};
        if (value?.sizes && typeof value.sizes === 'object') {
            for (const [id, size] of Object.entries(value.sizes as Record<string, unknown>)) {
                if (isWidgetId(id) && (size === 'S' || size === 'M' || size === 'L')) sizes[id] = size;
            }
        }
        return { order: merged, hidden, cardStyle, layout, sizes };
    } catch {
        return DEFAULT_CONFIG;
    }
};

export const writeNightstandWidgets = (config: NightstandWidgetsConfig) => {
    try {
        setStoredString(NIGHTSTAND_WIDGETS_STORAGE_KEY, JSON.stringify(config));
    } catch {
        // 写不进去就只影响本次会话。
    }
};
