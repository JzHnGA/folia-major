import React, { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

// src/components/mobile-tutorial/ScratchpadDragDemo.tsx
// 新手教程「速记簿」那一步的示范动画：画在压暗层上，一遍遍地演给人看把手能挪——手指按住真把手，拖着它的影子
// 先挪到右边、再挪到顶上，每次松手前目标那条边亮起来（与 ScratchpadTouchTab 拖动时的四条边一样），最后淡回原处重来。
// 只是一段画面，不接触摸；真把手还在高亮框里，用户可以照着试。系统要求减少动态效果时不演。

type Rect = { left: number; top: number; width: number; height: number };
type Point = { x: number; y: number };
type Insets = { top: number; right: number; bottom: number; left: number };

/** 舌头的样子与 ScratchpadTouchTab 一致：贴左右边时竖着，贴上下边时横着。 */
const UPRIGHT = { width: 20, height: 64 };
const LYING = { width: 64, height: 20 };
const PAPER = '#e8e3d8';
const LOOP_SECONDS = 5.6;

/**
 * 一遍里的几个时刻：按住 → 浮起 → 拖到右边 → 松手 → 再按住 → 拖到顶上 → 松手 → 淡出回原处。
 * 下面每一列的数组都与它一一对应。
 */
const TIMES = [0, 0.08, 0.16, 0.38, 0.46, 0.54, 0.76, 0.84, 0.94, 1];

const readInsets = (): Insets => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const insets = {
        top: Number.parseFloat(style.paddingTop) || 0,
        right: Number.parseFloat(style.paddingRight) || 0,
        bottom: Number.parseFloat(style.paddingBottom) || 0,
        left: Number.parseFloat(style.paddingLeft) || 0,
    };
    probe.remove();
    return insets;
};

const useViewport = () => {
    const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight, insets: readInsets() }));
    useEffect(() => {
        const update = () => setSize({ width: window.innerWidth, height: window.innerHeight, insets: readInsets() });
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('orientationchange', update);
        };
    }, []);
    return size;
};

type ScratchpadDragDemoProps = {
    /** 真把手的框；不在（把手藏着）时从左缘上部开始演。 */
    from: Rect | null;
    /** 说明卡在上面时，第二程挪到底边，不挪到被卡片盖住的顶边。 */
    cardAtTop: boolean;
};

const ScratchpadDragDemo: React.FC<ScratchpadDragDemoProps> = ({ from, cardAtTop }) => {
    const reduced = useReducedMotion();
    const { width, height, insets } = useViewport();
    if (reduced) return null;

    const start: Point = from
        ? { x: from.left + from.width / 2, y: from.top + from.height / 2 }
        : { x: insets.left + UPRIGHT.width / 2, y: insets.top + height * 0.3 };
    const startUpright = !from || from.height >= from.width;
    const startSize = startUpright ? UPRIGHT : LYING;
    const right: Point = { x: width - insets.right - UPRIGHT.width / 2, y: start.y };
    const secondEdge = cardAtTop ? 'bottom' : 'top';
    const second: Point = cardAtTop
        ? { x: width / 2, y: height - insets.bottom - LYING.height / 2 }
        : { x: width / 2, y: insets.top + LYING.height / 2 };

    const at = (points: Point[]) => ({ x: points.map(p => p.x), y: points.map(p => p.y) });
    const path = at([start, start, start, right, right, right, second, second, start, start]);
    const sizes = [startSize, startSize, startSize, UPRIGHT, UPRIGHT, UPRIGHT, LYING, LYING, startSize, startSize];
    const loop = { duration: LOOP_SECONDS, times: TIMES, repeat: Infinity, ease: 'easeInOut' as const };

    // 拖动时四条边都淡淡亮着，要去的那条亮到底；松手后熄掉。
    const guide = (edge: 'left' | 'right' | 'top' | 'bottom') => {
        const firstTarget = edge === 'right' ? 0.9 : 0.25;
        const secondTarget = edge === secondEdge ? 0.9 : 0.25;
        return [0, 0, 0.25, firstTarget, 0, 0.25, secondTarget, 0, 0, 0];
    };
    const guideBox: Record<'left' | 'right' | 'top' | 'bottom', React.CSSProperties> = {
        left: { top: insets.top + 24, bottom: insets.bottom + 24, left: insets.left, width: 4 },
        right: { top: insets.top + 24, bottom: insets.bottom + 24, right: insets.right, width: 4 },
        top: { top: insets.top, left: insets.left + 24, right: insets.right + 24, height: 4 },
        bottom: { bottom: insets.bottom, left: insets.left + 24, right: insets.right + 24, height: 4 },
    };

    return (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {(['left', 'right', 'top', 'bottom'] as const).map(edge => (
                <motion.span
                    key={edge}
                    className="absolute rounded-sm"
                    style={{ ...guideBox[edge], backgroundColor: PAPER }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: guide(edge) }}
                    transition={loop}
                />
            ))}

            {/* 影子与手指都挂在一个跟着路径走的点上，各自从这个点居中。 */}
            <motion.div
                className="absolute left-0 top-0"
                initial={{ x: start.x, y: start.y }}
                animate={path}
                transition={loop}
            >
                <motion.div
                    className="absolute rounded-[10px]"
                    style={{ backgroundColor: PAPER, translateX: '-50%', translateY: '-50%', boxShadow: '0 14px 32px rgba(0,0,0,0.5)' }}
                    initial={{ opacity: 0, width: startSize.width, height: startSize.height }}
                    animate={{
                        width: sizes.map(size => size.width),
                        height: sizes.map(size => size.height),
                        opacity: [0, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0, 0],
                        scale: [1, 1, 1.12, 1.12, 1, 1.12, 1.12, 1, 1, 1],
                    }}
                    transition={loop}
                />
                {/* 手指：按下时从大一圈缩到指尖大小，拖完抬起淡掉。 */}
                <motion.div
                    className="absolute h-11 w-11 rounded-full border-2 border-white/90 bg-white/35"
                    style={{ translateX: '-50%', translateY: '-50%', boxShadow: '0 4px 16px rgba(0,0,0,0.35)' }}
                    initial={{ opacity: 0, scale: 1.4 }}
                    animate={{
                        opacity: [0, 0.95, 0.95, 0.95, 0, 0.95, 0.95, 0, 0, 0],
                        scale: [1.4, 1, 0.9, 0.9, 1.3, 0.9, 0.9, 1.3, 1.4, 1.4],
                    }}
                    transition={loop}
                />
            </motion.div>
        </div>
    );
};

export default ScratchpadDragDemo;
