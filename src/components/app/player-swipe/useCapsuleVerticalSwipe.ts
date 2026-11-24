import { useEffect, useRef } from 'react';

// src/components/app/player-swipe/useCapsuleVerticalSwipe.ts
// 底部播放条上的上下滑动：上滑展开胶囊（显示更多信息与那排命令），下滑收起。左右滑动切歌归 useCapsuleTrackSwipe，
// 两者按方向分：竖直分量要明显大于水平分量才算。只认触屏；监听 passive，不 preventDefault，松手时才判定。

/** 认成上下滑的最小竖直位移（px）。胶囊只有 56px 高，手指往上带一截就够。 */
export const CAPSULE_VERTICAL_SWIPE_MIN_DISTANCE = 28;
/** 竖直位移相对水平位移的最小倍数：斜着划的留给左右切歌。 */
export const CAPSULE_VERTICAL_SWIPE_RATIO = 1.4;

export type CapsuleVerticalSwipeDirection = 'up' | 'down';

/** 松手时的方向；不够远或更像横划时是 null。 */
export const resolveCapsuleVerticalSwipe = (dx: number, dy: number): CapsuleVerticalSwipeDirection | null => {
    if (Math.abs(dy) < CAPSULE_VERTICAL_SWIPE_MIN_DISTANCE) return null;
    if (Math.abs(dy) < Math.abs(dx) * CAPSULE_VERTICAL_SWIPE_RATIO) return null;
    return dy < 0 ? 'up' : 'down';
};

type CapsuleVerticalSwipeOptions = {
    /** 接手势的元素（胶囊）；换了节点监听跟着换。 */
    target: HTMLElement | null;
    enabled: boolean;
    onSwipeUp: () => void;
    onSwipeDown: () => void;
};

const findTouch = (touches: TouchList, id: number): Touch | null => {
    for (let index = 0; index < touches.length; index += 1) {
        if (touches[index].identifier === id) return touches[index];
    }
    return null;
};

export function useCapsuleVerticalSwipe({ target, enabled, onSwipeUp, onSwipeDown }: CapsuleVerticalSwipeOptions): void {
    // 回调每次渲染都是新的：放进 ref，监听器只随节点与开关重挂。
    const handlersRef = useRef({ onSwipeUp, onSwipeDown });
    handlersRef.current = { onSwipeUp, onSwipeDown };

    useEffect(() => {
        if (!enabled || !target) return undefined;
        let start: { x: number; y: number; id: number } | null = null;

        const onTouchStart = (event: TouchEvent) => {
            start = null;
            if (event.touches.length !== 1) return;
            const touch = event.touches[0];
            start = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
        };
        const onTouchEnd = (event: TouchEvent) => {
            const origin = start;
            start = null;
            if (!origin) return;
            const touch = findTouch(event.changedTouches, origin.id);
            if (!touch) return;
            const direction = resolveCapsuleVerticalSwipe(touch.clientX - origin.x, touch.clientY - origin.y);
            if (direction === 'up') handlersRef.current.onSwipeUp();
            else if (direction === 'down') handlersRef.current.onSwipeDown();
        };
        const onTouchCancel = () => { start = null; };

        const options = { passive: true } as const;
        target.addEventListener('touchstart', onTouchStart, options);
        target.addEventListener('touchend', onTouchEnd, options);
        target.addEventListener('touchcancel', onTouchCancel, options);
        return () => {
            target.removeEventListener('touchstart', onTouchStart);
            target.removeEventListener('touchend', onTouchEnd);
            target.removeEventListener('touchcancel', onTouchCancel);
        };
    }, [enabled, target]);
}
