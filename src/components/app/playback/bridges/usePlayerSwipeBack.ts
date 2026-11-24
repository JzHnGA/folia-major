// src/components/app/playback/bridges/usePlayerSwipeBack.ts
// 触屏上从播放页返回的手势，等价于键盘的 Esc：手指从屏幕顶部条带开始、向下滑一段距离就返回。
// 起点限制在顶部条带，歌词轨等区域的纵向滚动不会被误认；只在 view === 'player' 且没有
// 浮层（设置、面板、对话框）占着的时候认。监听全程 passive，永不 preventDefault，不碰滚动。

import { useEffect } from 'react';
import { useAppViewStore } from '../../../../stores/useAppViewStore';
import { hasBlockingWindow, hasOpenSheet } from '../../../../utils/keyboardTargets';

/** 手势起点允许的顶部条带，按视口高的比例给。 */
const TOP_STRIP_RATIO = 0.18;
/** 认成下滑返回的最小垂直位移（px）。 */
const MIN_DROP_PX = 80;
/** 垂直位移相对水平位移的最小倍数：保证是「下滑」而不是斜划。 */
const MIN_VERTICALITY = 1.6;

export function usePlayerSwipeBack(navigateBackFromPlayer: () => void): void {
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: coarse)').matches) {
            return undefined;
        }

        let start: { x: number; y: number; id: number } | null = null;

        const onTouchStart = (event: TouchEvent) => {
            start = null;
            if (event.changedTouches.length === 0) {
                return;
            }
            const touch = event.changedTouches[0];
            if (touch.clientY <= window.innerHeight * TOP_STRIP_RATIO) {
                start = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
            }
        };

        const onTouchEnd = (event: TouchEvent) => {
            const origin = start;
            start = null;
            if (!origin) {
                return;
            }
            const touch = Array.from(event.changedTouches).find(t => t.identifier === origin.id);
            if (!touch) {
                return;
            }
            if (useAppViewStore.getState().view !== 'player' || hasBlockingWindow() || hasOpenSheet()) {
                return;
            }
            const dy = touch.clientY - origin.y;
            const dx = touch.clientX - origin.x;
            if (dy >= MIN_DROP_PX && dy >= Math.abs(dx) * MIN_VERTICALITY) {
                navigateBackFromPlayer();
            }
        };

        const onTouchCancel = () => {
            start = null;
        };

        window.addEventListener('touchstart', onTouchStart, { passive: true });
        window.addEventListener('touchend', onTouchEnd, { passive: true });
        window.addEventListener('touchcancel', onTouchCancel, { passive: true });
        return () => {
            window.removeEventListener('touchstart', onTouchStart);
            window.removeEventListener('touchend', onTouchEnd);
            window.removeEventListener('touchcancel', onTouchCancel);
        };
    }, [navigateBackFromPlayer]);
}
