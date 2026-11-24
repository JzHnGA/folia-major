import { useLayoutEffect, useState, type RefObject } from 'react';

// src/library/suites/bravais/useBravaisSpineTitleFit.ts
// 竖排标题的字号适配（书脊，以及完整信息条在矮横屏时的标题）：竖排文字一旦超过可用高度就会折到下一列，
// 书脊只有 64px 宽，第二列会被裁掉——横屏（高 390 左右）时就是用户截图里「喜欢的音…」那种只剩半列的样子。
// 所以标题始终只排一列（CSS 的 white-space: nowrap），字号按可用高度和字数收缩，整条标题留在槽里；不靠固定
// 断点猜字号：竖屏 / 横屏、播放条出现 / 消失、安全区变化时都会重新量。
// 书脊的标题槽在竖屏是 display: contents（标题仍是书脊的直接子级，计数与 spacer 照旧），矮横屏才变成 flex: 1
// 的那一段；没有盒子时 clientHeight 是 0，按「不限制」处理，保持基准字号。
// 只量槽高（clientHeight）：槽的高度由 flex 分配，与标题字号无关，所以量一次就能算出最终字号，不会来回跳。

/** 竖排标题每字占的高度（em）：字号 × 这个系数，含 letter-spacing 0.04em 的一点点余量。 */
export const SPINE_TITLE_ADVANCE_EM = 1.12;
/** 再长的标题也至少留这么大，太小的字没有意义；放不下时由标题槽裁掉末尾。 */
export const SPINE_TITLE_MIN_FONT_PX = 10;

/**
 * 字号 = min(基准字号, 槽高 / （字数 × 每字占高）)。纯函数，测量与用例共用。
 * 基准字号仍由 verticalTitleSize 按字数先收一道，两个条件取更小的那个。
 */
export const resolveSpineTitleFontSize = (availablePx: number, text: string, basePx: number, minPx = SPINE_TITLE_MIN_FONT_PX) => {
    const chars = Math.max(1, Array.from(text).length);
    const fitted = Math.floor(availablePx / (chars * SPINE_TITLE_ADVANCE_EM));
    return Math.max(minPx, Math.min(basePx, fitted));
};

export const useBravaisSpineTitleFit = ({
    slotRef,
    text,
    basePx,
    minPx = SPINE_TITLE_MIN_FONT_PX,
    enabled = true,
}: {
    /** 标题槽（书脊里 flex: 1 的那一段）。 */
    slotRef: RefObject<HTMLElement | null>;
    text: string;
    basePx: number;
    minPx?: number;
    /** 横排标题（信息条横向）不需要竖排适配：关掉时不量、直接用基准字号。 */
    enabled?: boolean;
}): number => {
    const [fontSize, setFontSize] = useState(basePx);

    useLayoutEffect(() => {
        if (!enabled) {
            setFontSize(basePx);
            return undefined;
        }
        const slot = slotRef.current;
        if (!slot || typeof ResizeObserver === 'undefined') return undefined;
        const measure = () => {
            // display: contents（竖屏书脊）没有盒子，clientHeight 是 0：不限制，保持基准字号。
            const available = slot.clientHeight;
            const next = available > 0
                ? resolveSpineTitleFontSize(available, text, basePx, minPx)
                : basePx;
            setFontSize(current => (current === next ? current : next));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(slot);
        // 竖屏 → 横屏时标题槽从 display: contents 变成 flex：观察父级，拿得到“盒子刚出现”的那一次。
        if (slot.parentElement) observer.observe(slot.parentElement);
        return () => observer.disconnect();
    }, [basePx, enabled, minPx, slotRef, text]);

    return fontSize;
};
