import React, { useEffect, useRef, useState } from 'react';
import type { ScratchpadHandleSide } from '../../../stores/useScratchpadSettingsStore';

// src/components/app/scratchpad/ScratchpadTouchTab.tsx
// 手机上的速记簿把手（没有指针悬停，桌面那条悬停展开的标签用不上）：贴在一条屏幕边上的米白小舌头，点一下开抽屉。
// 按住拖动可以把它挪到四条边的任意位置：拖动时它跟着手指走、四条边亮起来、离手指最近的那条最亮，松手吸到那条边上，
// 边与沿边的位置存进设置（placeHandle）。舌头上有三颗「握把」点，说明它能拖；没挪过之前旁边还有一句提示，
// 第一次挪动或点掉提示后不再出现。都避开刘海、灵动岛与 Home 指示条（safe-area）。

type ScratchpadTouchTabProps = {
    side: ScratchpadHandleSide;
    /** 0..1：沿这条边的位置。 */
    position: number;
    count: number;
    pulsing: boolean;
    label: string;
    moveHint: string;
    showMoveHint: boolean;
    onOpen: () => void;
    onPlace: (side: ScratchpadHandleSide, position: number) => void;
    onMoveHintSeen: () => void;
    handleRef: React.Ref<HTMLButtonElement>;
};

/** 手指移动多远算拖动而不是点。 */
const DRAG_THRESHOLD = 8;
/** 舌头沿边的长度，与 scratchpad.css 的 --scratchpad-tab-length 一致。 */
const TAB_LENGTH = 64;
/** 沿边留出的空：上下边让开状态栏与 Home 条附近的系统手势，左右边让开屏幕两端。 */
const EDGE_MARGIN = 24;

type SafeArea = { top: number; right: number; bottom: number; left: number };

/** 量 env(safe-area-inset-*) 的像素：放一个用它做内边距的空元素，读算好的值再拿掉。 */
const readSafeArea = (): SafeArea => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const safe = {
        top: Number.parseFloat(style.paddingTop) || 0,
        right: Number.parseFloat(style.paddingRight) || 0,
        bottom: Number.parseFloat(style.paddingBottom) || 0,
        left: Number.parseFloat(style.paddingLeft) || 0,
    };
    probe.remove();
    return safe;
};

/** 手指松开的点吸到最近的一条边上，算出沿边的位置（0..1）。 */
export const snapToEdge = (x: number, y: number, width: number, height: number, safe: SafeArea): { side: ScratchpadHandleSide; position: number } => {
    const distances: Array<[ScratchpadHandleSide, number]> = [
        ['left', x - safe.left],
        ['right', width - safe.right - x],
        ['top', y - safe.top],
        ['bottom', height - safe.bottom - y],
    ];
    const [side] = distances.reduce((nearest, entry) => (entry[1] < nearest[1] ? entry : nearest));
    const vertical = side === 'left' || side === 'right';
    const start = (vertical ? safe.top : safe.left) + EDGE_MARGIN;
    const end = (vertical ? height - safe.bottom : width - safe.right) - EDGE_MARGIN - TAB_LENGTH;
    const along = (vertical ? y : x) - TAB_LENGTH / 2;
    const position = end > start ? (along - start) / (end - start) : 0;
    return { side, position: Math.min(1, Math.max(0, position)) };
};

const ScratchpadTouchTab: React.FC<ScratchpadTouchTabProps> = ({
    side, position, count, pulsing, label, moveHint, showMoveHint, onOpen, onPlace, onMoveHintSeen, handleRef,
}) => {
    const start = useRef<{ x: number; y: number; id: number } | null>(null);
    const [drag, setDrag] = useState<{ x: number; y: number; side: ScratchpadHandleSide } | null>(null);
    const dragging = drag !== null;

    // 拖动时整页不滚、不选字。
    useEffect(() => {
        if (!dragging) return;
        const root = document.documentElement;
        const previous = root.style.userSelect;
        root.style.userSelect = 'none';
        return () => {
            root.style.userSelect = previous;
        };
    }, [dragging]);

    const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const from = start.current;
        if (!from || from.id !== event.pointerId) return;
        if (!drag && Math.hypot(event.clientX - from.x, event.clientY - from.y) < DRAG_THRESHOLD) return;
        const near = snapToEdge(event.clientX, event.clientY, window.innerWidth, window.innerHeight, readSafeArea());
        setDrag({ x: event.clientX, y: event.clientY, side: near.side });
    };

    const finish = (event: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
        const from = start.current;
        if (!from || from.id !== event.pointerId) return;
        start.current = null;
        if (drag) {
            setDrag(null);
            if (!cancelled) {
                const placed = snapToEdge(event.clientX, event.clientY, window.innerWidth, window.innerHeight, readSafeArea());
                onPlace(placed.side, placed.position);
                onMoveHintSeen();
            }
        } else if (!cancelled) {
            onOpen();
        }
    };

    const restClass = `scratchpad-touch-tab is-${side}${count > 0 ? ' has-entries' : ''}${pulsing ? ' is-pulsing' : ''}${dragging ? ' is-dragging' : ''}${showMoveHint && !dragging ? ' is-hinting' : ''}`;

    return (
        <>
            {dragging && (
                // 拖动时四条边亮起来，手指最近的那条最亮：松手就吸到那里。
                <div className="scratchpad-touch-guides" aria-hidden="true">
                    {(['left', 'right', 'top', 'bottom'] as const).map(edge => (
                        <span key={edge} className={`scratchpad-touch-guide is-${edge}${drag.side === edge ? ' is-near' : ''}`} />
                    ))}
                </div>
            )}
            <button
                ref={handleRef}
                type="button"
                className={restClass}
                data-testid="scratchpad-handle"
                data-ponder="scratchpad"
                data-mobile-tutorial="scratchpad"
                aria-label={`${label}. ${moveHint}`}
                style={dragging
                    ? { left: drag.x, top: drag.y, right: 'auto', bottom: 'auto' }
                    : { '--scratchpad-tab-position': position } as React.CSSProperties}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={event => finish(event, false)}
                onPointerCancel={event => finish(event, true)}
                // 点开由 pointerup 管（拖动以后不能再算一次点击）；键盘与读屏的「点」走这里。
                onClick={event => {
                    if (event.detail === 0) onOpen();
                }}
                onContextMenu={event => event.preventDefault()}
            >
                <span className="scratchpad-touch-grip" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                </span>
                {count > 0 && <span className="scratchpad-touch-count" aria-hidden="true">{count}</span>}
            </button>
            {showMoveHint && !dragging && (
                <button
                    type="button"
                    className={`scratchpad-touch-hint is-${side}`}
                    style={{ '--scratchpad-tab-position': position } as React.CSSProperties}
                    onClick={onMoveHintSeen}
                >
                    {moveHint}
                </button>
            )}
        </>
    );
};

export default ScratchpadTouchTab;
