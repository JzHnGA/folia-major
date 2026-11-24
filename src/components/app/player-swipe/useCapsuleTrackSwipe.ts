import { useEffect, useRef, type RefObject } from 'react';
import {
    hasPlayerSwipeIntent,
    resolvePlayerSwipeDirection,
    type PlayerTrackSwipeDirection,
} from './playerSwipeGesture';

// src/components/app/player-swipe/useCapsuleTrackSwipe.ts
// 底部播放条（FloatingPlayerControls 的胶囊）上左右滑动切歌：左滑下一首、右滑上一首，与播放页整屏滑动同一套门槛
// （playerSwipeGesture）。胶囊里的内容跟着手指走，过了门槛松手就朝滑的方向滑出、新歌从另一侧滑进；没过门槛弹回；
// 那一侧没有歌时只拉得动一小截。每个页面都开；播放页整屏的滑动不接控制条上起手的触摸，所以不会一划切两首。
// 只认触屏；监听 passive，竖直方向照常。收起的播放条大半是进度条，而 iOS 上进度条（range）只认按住圆点拖：
// 起点在圆点附近的留给它定位，进度条其余地方照样能滑动切歌。
// 位移写 CSS 的 translate 属性，不写 transform：胶囊和内容都在 framer-motion 的 layout 动画里，transform 归它管。

/** 起点落在这里面就不认：输入框与显式声明不接滑动的区域。按钮可以：横划过去浏览器自己不会触发点击。 */
const IGNORE_SELECTOR = 'input, textarea, select, [role="slider"], [data-player-swipe-ignore]';
const PROGRESS_TRACK = '[data-folium-part="progress.track"]';
const PROGRESS_THUMB = '[data-folium-part="progress.thumb"]';
/** 进度条上离圆点这么近的起点留给拖动定位（手指的宽度）。 */
const THUMB_SLOP_PX = 28;

/** 起点是不是这次手势该让出去的：进度条的圆点附近（拖动定位），或别的输入控件。 */
export const yieldsToControl = (target: Element, x: number): boolean => {
    const track = target.closest(PROGRESS_TRACK);
    if (track) {
        const thumb = track.querySelector(PROGRESS_THUMB)?.getBoundingClientRect();
        return !thumb || Math.abs(x - (thumb.left + thumb.width / 2)) <= THUMB_SLOP_PX;
    }
    return Boolean(target.closest(IGNORE_SELECTOR));
};

/** 跟手时内容走的比例与上限：手指的一大半，但不出胶囊太远。 */
const FOLLOW_RATIO = 0.6;
const FOLLOW_MAX_PX = 96;
/** 那一侧没有歌时的阻尼：只拉得动一小截。 */
const BLOCKED_RATIO = 0.18;
const BLOCKED_MAX_PX = 24;
/** 提交：先滑出去，再从另一侧滑进来。 */
const OUT_MS = 150;
const IN_MS = 240;
const SETTLE_MS = 220;
/** 刚滑过之后胶囊的那次点击（展开 / 打开面板）不算数。 */
const CLICK_GUARD_MS = 450;

type CapsuleTrackSwipeOptions = {
    /** 接手势的元素（胶囊）；换了节点监听跟着换。 */
    target: HTMLElement | null;
    /** 跟着手指动的内容。 */
    contentRef: RefObject<HTMLElement | null>;
    enabled: boolean;
    canNext: boolean;
    canPrev: boolean;
    onNext: () => void;
    onPrev: () => void;
    reducedMotion: boolean;
};

const findTouch = (touches: TouchList, id: number): Touch | null => {
    for (let index = 0; index < touches.length; index += 1) {
        if (touches[index].identifier === id) return touches[index];
    }
    return null;
};

/** 跟手的位移：能切的一侧跟一大半，不能切的一侧只拉得动一小截。 */
export const resolveCapsuleFollow = (dx: number, allowed: boolean): number => {
    const ratio = allowed ? FOLLOW_RATIO : BLOCKED_RATIO;
    const limit = allowed ? FOLLOW_MAX_PX : BLOCKED_MAX_PX;
    return Math.max(-limit, Math.min(limit, dx * ratio));
};

export function useCapsuleTrackSwipe({
    target,
    contentRef,
    enabled,
    canNext,
    canPrev,
    onNext,
    onPrev,
    reducedMotion,
}: CapsuleTrackSwipeOptions): void {
    // 回调与能不能切每次渲染都会变：放进 ref，监听只挂一次。
    const latestRef = useRef({ canNext, canPrev, onNext, onPrev, reducedMotion });
    latestRef.current = { canNext, canPrev, onNext, onPrev, reducedMotion };

    useEffect(() => {
        if (!enabled || !target || typeof window === 'undefined') return undefined;
        const touchCapable = navigator.maxTouchPoints > 0
            || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
        if (!touchCapable) return undefined;

        let start: { x: number; y: number; id: number } | null = null;
        let swiping = false;
        let guardUntil = 0;
        let animation: Animation | null = null;

        const content = () => contentRef.current;
        const allowedFor = (direction: PlayerTrackSwipeDirection) => (
            direction === 'next' ? latestRef.current.canNext : latestRef.current.canPrev
        );
        const setFollow = (px: number, fade: number) => {
            const element = content();
            if (!element) return;
            element.style.translate = `${px}px 0`;
            element.style.opacity = String(1 - fade);
        };
        const clearFollow = () => {
            const element = content();
            if (!element) return;
            element.style.removeProperty('translate');
            element.style.removeProperty('opacity');
        };
        const stopAnimation = () => {
            animation?.cancel();
            animation = null;
        };
        /** 从此刻的位置动画到 `keyframes`，放完清掉内联样式。 */
        const animateFrom = (keyframes: Keyframe[], duration: number, easing: string): Promise<void> => {
            const element = content();
            if (!element || typeof element.animate !== 'function') {
                clearFollow();
                return Promise.resolve();
            }
            stopAnimation();
            const run = element.animate(keyframes, { duration, easing, fill: 'forwards' });
            animation = run;
            // 放完撤掉这一段（只撤自己：放的途中又来了新的手势，新的那段不动）。
            return run.finished.then(() => {
                if (animation === run) {
                    run.cancel();
                    animation = null;
                }
            }, () => undefined);
        };

        const settleBack = () => {
            const element = content();
            const from = element?.style.translate || '0px 0';
            const opacity = element?.style.opacity || '1';
            clearFollow();
            if (latestRef.current.reducedMotion) return;
            void animateFrom([{ translate: from, opacity }, { translate: '0px 0', opacity: 1 }], SETTLE_MS, 'cubic-bezier(0.2, 0.9, 0.3, 1.2)');
        };

        const commit = (direction: PlayerTrackSwipeDirection) => {
            const { onNext: next, onPrev: prev } = latestRef.current;
            guardUntil = performance.now() + CLICK_GUARD_MS;
            if (latestRef.current.reducedMotion) {
                clearFollow();
                if (direction === 'next') next(); else prev();
                return;
            }
            const element = content();
            const width = Math.max(element?.getBoundingClientRect().width ?? 240, 120);
            // 左滑（下一首）往左出、从右进；右滑反过来。
            const sign = direction === 'next' ? -1 : 1;
            const from = element?.style.translate || '0px 0';
            const opacity = element?.style.opacity || '1';
            clearFollow();
            void animateFrom([{ translate: from, opacity }, { translate: `${sign * width * 0.45}px 0`, opacity: 0 }], OUT_MS, 'ease-in')
                .then(() => {
                    if (direction === 'next') next(); else prev();
                    return animateFrom([{ translate: `${-sign * width * 0.35}px 0`, opacity: 0 }, { translate: '0px 0', opacity: 1 }], IN_MS, 'cubic-bezier(0.2, 0.8, 0.2, 1)');
                });
        };

        const onTouchStart = (event: TouchEvent) => {
            start = null;
            swiping = false;
            if (event.touches.length !== 1) return;
            const touch = event.touches[0];
            if (event.target instanceof Element && yieldsToControl(event.target, touch.clientX)) return;
            stopAnimation();
            start = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
        };

        const onTouchMove = (event: TouchEvent) => {
            if (!start) return;
            const touch = findTouch(event.touches, start.id);
            if (!touch) return;
            const dx = touch.clientX - start.x;
            const dy = touch.clientY - start.y;
            if (!swiping) {
                if (!hasPlayerSwipeIntent(dx, dy)) {
                    // 更像上下划（拖条上去、往下滚）：这次不认。
                    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) start = null;
                    return;
                }
                swiping = true;
            }
            const direction: PlayerTrackSwipeDirection = dx < 0 ? 'next' : 'prev';
            const allowed = allowedFor(direction);
            const follow = resolveCapsuleFollow(dx, allowed);
            setFollow(follow, allowed ? Math.min(0.45, Math.abs(follow) / FOLLOW_MAX_PX * 0.45) : 0);
        };

        const onTouchEnd = (event: TouchEvent) => {
            const origin = start;
            const wasSwiping = swiping;
            start = null;
            swiping = false;
            if (!origin || !wasSwiping) return;
            const touch = findTouch(event.changedTouches, origin.id);
            const resolved = touch ? resolvePlayerSwipeDirection(touch.clientX - origin.x, touch.clientY - origin.y) : null;
            guardUntil = performance.now() + CLICK_GUARD_MS;
            if (resolved && allowedFor(resolved)) {
                console.info(`[player] capsule swipe: ${resolved}`);
                commit(resolved);
            } else {
                settleBack();
            }
        };

        const onTouchCancel = () => {
            const wasSwiping = swiping;
            start = null;
            swiping = false;
            if (wasSwiping) settleBack();
        };

        // 滑过之后的那一下点击（展开胶囊、打开面板、按到的按钮）吞掉：捕获阶段，先于胶囊和按钮自己的处理。
        const onClickCapture = (event: MouseEvent) => {
            if (performance.now() < guardUntil) {
                event.stopPropagation();
                event.preventDefault();
            }
        };

        const passive = { passive: true } as const;
        target.addEventListener('touchstart', onTouchStart, passive);
        target.addEventListener('touchmove', onTouchMove, passive);
        target.addEventListener('touchend', onTouchEnd, passive);
        target.addEventListener('touchcancel', onTouchCancel, passive);
        target.addEventListener('click', onClickCapture, true);
        return () => {
            target.removeEventListener('touchstart', onTouchStart);
            target.removeEventListener('touchmove', onTouchMove);
            target.removeEventListener('touchend', onTouchEnd);
            target.removeEventListener('touchcancel', onTouchCancel);
            target.removeEventListener('click', onClickCapture, true);
            stopAnimation();
            clearFollow();
        };
    }, [contentRef, enabled, target]);
}
