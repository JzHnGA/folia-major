import { useEffect, useRef } from 'react';

// src/components/modal/settings/useSwipeDownToClose.ts
// Pulling the settings window down closes it on a phone, as an iOS sheet does. A pull starts from the
// window's top (search, tabs, page title) at any time, and from the page under it only when that page
// is scrolled to its top; a pull that turns out sideways, or that starts on a control that drags
// itself (a slider, a text area), is left alone. The window follows the finger, and either slides
// away and closes, or springs back.

/** How far down, in CSS pixels, a pull must go to close when let go slowly. */
const CLOSE_DISTANCE = 120;
/** How fast, in pixels per millisecond, a flick down closes whatever its distance. */
const CLOSE_SPEED = 0.6;
/** How far the finger moves before the pull is judged down or sideways. */
const DECIDE_DISTANCE = 8;
const SETTLE_MS = 260;
const SETTLE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * Controls that take a drag for themselves. A one-line text field is not among them: the search
 * field is most of the window's top, and a tap on it still focuses it.
 */
const OWN_DRAG_SELECTOR = 'input[type="range"], textarea, select, [role="slider"], [contenteditable="true"], [data-swipe-close-ignore]';

/** Whether something between the touched element and the window is scrolled down from its top. */
const isInsideScrolledArea = (target: Element, root: HTMLElement): boolean => {
    for (let node: Element | null = target; node && node !== root; node = node.parentElement) {
        if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) return true;
    }
    return false;
};

/**
 * Gives the element behind `ref` the pull-down-to-close gesture while `enabled`. `onClose` is called
 * once the element has slid away, and the owner's own exit animation runs from there.
 */
export const useSwipeDownToClose = <T extends HTMLElement>(enabled: boolean, onClose: () => void) => {
    const ref = useRef<T>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        const element = ref.current;
        if (!enabled || !element) return;

        let startX = 0;
        let startY = 0;
        let lastY = 0;
        let lastTime = 0;
        let speed = 0;
        let state: 'idle' | 'deciding' | 'pulling' | 'ignored' = 'idle';

        const place = (offset: number, animate: boolean) => {
            element.style.transition = animate ? `transform ${SETTLE_MS}ms ${SETTLE_EASE}` : 'none';
            element.style.transform = offset === 0 ? '' : `translateY(${offset}px)`;
        };

        const onTouchStart = (event: TouchEvent) => {
            if (event.touches.length !== 1) {
                state = 'ignored';
                return;
            }
            const target = event.target instanceof Element ? event.target : null;
            if (!target || target.closest(OWN_DRAG_SELECTOR) || isInsideScrolledArea(target, element)) {
                state = 'ignored';
                return;
            }
            const touch = event.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            lastY = touch.clientY;
            lastTime = event.timeStamp;
            speed = 0;
            state = 'deciding';
        };

        const onTouchMove = (event: TouchEvent) => {
            if (state === 'idle' || state === 'ignored') return;
            const touch = event.touches[0];
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            if (state === 'deciding') {
                if (Math.hypot(dx, dy) < DECIDE_DISTANCE) return;
                // Only a pull mostly downwards is ours; an upward or sideways one scrolls as usual.
                state = dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.2 ? 'pulling' : 'ignored';
                if (state === 'ignored') return;
            }
            event.preventDefault();
            const elapsed = event.timeStamp - lastTime;
            if (elapsed > 0) speed = (touch.clientY - lastY) / elapsed;
            lastY = touch.clientY;
            lastTime = event.timeStamp;
            place(Math.max(0, dy), false);
        };

        const onTouchEnd = () => {
            if (state !== 'pulling') {
                state = 'idle';
                return;
            }
            state = 'idle';
            const distance = Math.max(0, lastY - startY);
            if (distance > CLOSE_DISTANCE || speed > CLOSE_SPEED) {
                place(element.offsetHeight, true);
                window.setTimeout(() => {
                    onCloseRef.current();
                }, SETTLE_MS);
            } else {
                place(0, true);
            }
        };

        element.addEventListener('touchstart', onTouchStart, { passive: true });
        // Not passive: a pull that is ours stops the page under it from scrolling.
        element.addEventListener('touchmove', onTouchMove, { passive: false });
        element.addEventListener('touchend', onTouchEnd);
        element.addEventListener('touchcancel', onTouchEnd);
        return () => {
            element.removeEventListener('touchstart', onTouchStart);
            element.removeEventListener('touchmove', onTouchMove);
            element.removeEventListener('touchend', onTouchEnd);
            element.removeEventListener('touchcancel', onTouchEnd);
            element.style.transition = '';
            element.style.transform = '';
        };
    }, [enabled]);

    return ref;
};
