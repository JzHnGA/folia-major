import { useEffect, useRef, type RefObject } from 'react';
import { useAppViewStore } from '../../../stores/useAppViewStore';
import { hasBlockingWindow, hasOpenSheet } from '../../../utils/keyboardTargets';
import {
    hasPlayerSwipeIntent,
    resolvePlayerSwipeDirection,
    resolvePlayerSwipeProgress,
    resolvePlayerSwipeShift,
    type PlayerTrackSwipeDirection,
} from './playerSwipeGesture';

// src/components/app/player-swipe/usePlayerTrackSwipe.ts
// 播放页的左右滑动切歌：左滑下一首、右滑上一首，过程中点亮对应方向的箭头。
// 与 usePlayerSwipeBack 同一套边界——只认触屏、只在 view === 'player'、浮层 / 对话框开着时让路；
// 监听全程 passive，不 preventDefault，竖直滚动照常。箭头跟手与提交动画直接写箭头层的 CSS 变量
// 和 data 属性，不走 React state（frontend-runtime-guardrails：拖动期间不逐帧 setState）。

/**
 * 起点落在这里面就不认手势：真正的控件（进度条、按钮、链接、输入框）与显式声明不接滑动的区域。
 * 不按 `role="button"` 一票否决：Monet 的可点歌词行就是 role=button，而歌词区是播放页上最自然的手势起点，
 * 横向划过它们时浏览器也会自己取消点击。需要拦截的自定义控件挂 `data-player-swipe-ignore`。
 */
const IGNORE_SELECTOR = [
    'input',
    'textarea',
    'select',
    'button',
    'a',
    '[role="slider"]',
    '[contenteditable]:not([contenteditable="false"])',
    '[data-player-swipe-ignore]',
    // 控制条上起手的归胶囊自己（左右切歌、上下展开收起），见 FloatingPlayerControls。
    '[data-player-bar-shell]',
].join(', ');

/** 提交后箭头清掉状态前的等待：CSS 动画 380ms，多留一点余量再删 data 属性。 */
const COMMIT_ANIMATION_MS = 420;

type PlayerTrackSwipeOptions = {
    onNextTrack: () => void;
    onPrevTrack: () => void;
    /** 箭头层：手势直接写它的 CSS 变量与 data 属性。 */
    feedbackRef: RefObject<HTMLElement | null>;
    enabled?: boolean;
};

const findTouch = (touches: TouchList, id: number): Touch | null => {
    for (let index = 0; index < touches.length; index += 1) {
        if (touches[index].identifier === id) return touches[index];
    }
    return null;
};

export function usePlayerTrackSwipe({
    onNextTrack,
    onPrevTrack,
    feedbackRef,
    enabled = true,
}: PlayerTrackSwipeOptions): void {
    // 回调每次渲染都是新的：放进 ref，监听器只挂一次，不在切歌 / 播放状态变化时反复解绑重绑。
    const handlersRef = useRef({ onNextTrack, onPrevTrack });
    handlersRef.current = { onNextTrack, onPrevTrack };

    useEffect(() => {
        if (!enabled) return undefined;
        if (typeof window === 'undefined') return undefined;
        // 触屏判定：iOS 壳报 coarse；把触控板当主指针的设备仍可能是 fine，所以再看有没有触点。
        const touchCapable = navigator.maxTouchPoints > 0
            || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
        if (!touchCapable) {
            return undefined;
        }

        const feedback = feedbackRef.current;
        let start: { x: number; y: number; id: number } | null = null;
        let direction: PlayerTrackSwipeDirection | null = null;
        let commitTimer = 0;

        const writeFeedback = (dx: number) => {
            if (!feedback) return;
            feedback.style.setProperty('--player-swipe-shift', `${resolvePlayerSwipeShift(dx)}px`);
            feedback.style.setProperty('--player-swipe-progress', String(resolvePlayerSwipeProgress(dx)));
        };

        const clearFeedback = () => {
            direction = null;
            window.clearTimeout(commitTimer);
            if (!feedback) return;
            delete feedback.dataset.playerSwipeDirection;
            delete feedback.dataset.playerSwipeCommit;
            feedback.style.removeProperty('--player-swipe-shift');
            feedback.style.removeProperty('--player-swipe-progress');
        };

        const canSwipe = () => (
            useAppViewStore.getState().view === 'player'
            && !hasBlockingWindow()
            && !hasOpenSheet()
        );

        const onTouchStart = (event: TouchEvent) => {
            // 先把上一次的手势 / 提交动画清掉：第二根手指落下时 start 会丢掉，留下的半亮箭头
            // 不能一直挂在屏幕上（那一下之后也不会有 touchend 来收它）。
            clearFeedback();
            start = null;
            if (event.touches.length !== 1) {
                return;
            }
            if (!canSwipe()) {
                return;
            }
            const target = event.target instanceof Element ? event.target.closest(IGNORE_SELECTOR) : null;
            if (target) {
                return;
            }
            const touch = event.touches[0];
            start = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
        };

        const onTouchMove = (event: TouchEvent) => {
            if (!start || !feedback) {
                return;
            }
            const touch = findTouch(event.touches, start.id);
            if (!touch) {
                return;
            }
            const dx = touch.clientX - start.x;
            const dy = touch.clientY - start.y;
            if (!hasPlayerSwipeIntent(dx, dy)) {
                // 更像上下滚动：把箭头收掉，但记住起点，后面还可能拐成横划。
                if (direction) {
                    direction = null;
                    delete feedback.dataset.playerSwipeDirection;
                    feedback.style.setProperty('--player-swipe-progress', '0');
                    feedback.style.setProperty('--player-swipe-shift', '0px');
                }
                return;
            }
            const nextDirection: PlayerTrackSwipeDirection = dx < 0 ? 'next' : 'prev';
            if (direction !== nextDirection) {
                direction = nextDirection;
                feedback.dataset.playerSwipeDirection = nextDirection;
            }
            writeFeedback(dx);
        };

        const onTouchEnd = (event: TouchEvent) => {
            const origin = start;
            start = null;
            if (!origin) {
                return;
            }
            const touch = findTouch(event.changedTouches, origin.id);
            if (!touch) {
                clearFeedback();
                return;
            }
            if (!canSwipe()) {
                clearFeedback();
                return;
            }
            const dx = touch.clientX - origin.x;
            const dy = touch.clientY - origin.y;
            const resolved = resolvePlayerSwipeDirection(dx, dy);
            if (!resolved) {
                clearFeedback();
                return;
            }

            // 提交：箭头按手指最后的位置起跳，向右 / 左滑出去淡掉（CSS），同时切歌。
            direction = resolved;
            if (feedback) {
                feedback.dataset.playerSwipeDirection = resolved;
                feedback.dataset.playerSwipeCommit = resolved;
                feedback.style.setProperty('--player-swipe-progress', '1');
                feedback.style.setProperty('--player-swipe-shift', `${resolvePlayerSwipeShift(dx)}px`);
            }
            window.clearTimeout(commitTimer);
            commitTimer = window.setTimeout(() => {
                if (!feedback) return;
                delete feedback.dataset.playerSwipeCommit;
                feedback.style.removeProperty('--player-swipe-shift');
                feedback.style.removeProperty('--player-swipe-progress');
                delete feedback.dataset.playerSwipeDirection;
                direction = null;
            }, COMMIT_ANIMATION_MS);

            if (resolved === 'next') handlersRef.current.onNextTrack();
            else handlersRef.current.onPrevTrack();
        };

        const onTouchCancel = () => {
            start = null;
            clearFeedback();
        };

        // 捕获阶段：Monet / Pendolo 的歌词轨在自己的 touch 处理器里 stopPropagation，冒泡阶段收不到；
        // 捕获先于它们，横划在歌词上也照样认。仍然 passive，不 preventDefault。
        const listenerOptions = { passive: true, capture: true } as const;
        window.addEventListener('touchstart', onTouchStart, listenerOptions);
        window.addEventListener('touchmove', onTouchMove, listenerOptions);
        window.addEventListener('touchend', onTouchEnd, listenerOptions);
        window.addEventListener('touchcancel', onTouchCancel, listenerOptions);
        return () => {
            window.removeEventListener('touchstart', onTouchStart, listenerOptions);
            window.removeEventListener('touchmove', onTouchMove, listenerOptions);
            window.removeEventListener('touchend', onTouchEnd, listenerOptions);
            window.removeEventListener('touchcancel', onTouchCancel, listenerOptions);
            window.clearTimeout(commitTimer);
        };
    }, [enabled, feedbackRef]);
}
