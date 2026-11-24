// src/components/nightstand/NightstandOverlay.tsx
// 床头钟覆盖层：横屏播放页上叠加一排小组件卡（时钟/天气/日历/一言/专辑封面，可开关、可换皮肤与排列），
// 左下角不再画正在播放卡（用户要求）。动态歌词由底下的可视化视图（SceneHost）自己渲染。
// 卡片外壳与 Folia 设置面板同一套语言（theme-glass-panel + 大圆角 + backdrop-blur）；
// 「极简」皮肤无底板、纯投影文字；「实心」用近乎不透明的主题底色。
// 除右上角自定义按钮与编辑态外整层 pointer-events: none，不挡播放页的点击。
// 编辑模式（iOS 主屏那一套）：右上角按钮进入，卡片抖动，按住卡片拖到别的卡的前/后换位，
// 拖右下角手柄改尺寸档位（或点一下手柄循环换档），左上角 − 把卡收进右侧「已隐藏」托盘，点托盘里的卡加回来。
// 卡片按 iOS 主屏的格子定尺寸（小 1×1、中 2×1、大 2×2），换档只改它自己占的格数，别的卡尺寸不变；
// 每张卡按档位显示不同内容（大档位显示更多信息），不是把同样的内容放大。

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Minus, Plus, Settings2, X } from 'lucide-react';
import type { Theme } from '../../types';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import {
    readNightstandWidgets,
    writeNightstandWidgets,
    reorderedForDrop,
    sizeForResizeDrag,
    nextWidgetSize,
    widgetSizeOf,
    NIGHTSTAND_SIZE_SPAN,
    type NightstandCardStyle,
    type NightstandLayout,
    type NightstandWidgetId,
    type NightstandWidgetProps,
    type NightstandWidgetSize,
    type NightstandWidgetsConfig,
} from './widgets/nightstandWidgets';
import ClockWidget from './widgets/ClockWidget';
import WeatherWidget from './widgets/WeatherWidget';
import CalendarWidget from './widgets/CalendarWidget';
import HitokotoWidget from './widgets/HitokotoWidget';
import AlbumArtWidget from './widgets/AlbumArtWidget';

type NightstandOverlayProps = {
    theme: Theme;
    isDaylight: boolean;
};

const WIDGET_COMPONENTS: Record<NightstandWidgetId, React.FC<NightstandWidgetProps>> = {
    clock: ClockWidget,
    weather: WeatherWidget,
    calendar: CalendarWidget,
    hitokoto: HitokotoWidget,
    albumArt: AlbumArtWidget,
};

const SIZE_NAME_KEYS: Record<NightstandWidgetSize, string> = { S: 'sizeSmall', M: 'sizeMedium', L: 'sizeLarge' };

/**
 * 格子边长：按可用高度算，横屏 iPhone 上两行大号卡（2 格 + 间距）正好让开底部的播放控制条；
 * iPad 上钳到 168px，不让卡片大得失去比例。
 */
const CELL_SIZE = 'clamp(88px, calc((100dvh - 9rem) / 2), 168px)';
const CELL_GAP_PX = 12;

/** 一个档位占的宽或高（格数 → CSS 长度）。 */
const spanLength = (cells: number) => `calc(var(--ns-cell) * ${cells} + var(--ns-gap) * ${cells - 1})`;

/** 拖手柄超过这个距离才算拖动；更短的当作点一下（循环换档）。 */
const RESIZE_TAP_SLOP_PX = 6;

const WIDGET_NAME_KEYS: Record<NightstandWidgetId, string> = {
    clock: 'widgetClock',
    weather: 'widgetWeather',
    calendar: 'widgetCalendar',
    hitokoto: 'widgetHitokoto',
    albumArt: 'widgetAlbumArt',
};

/** 三种卡片皮肤：玻璃（设计系统默认）、实心、极简（无底板、强投影文字）。 */
const cardClassFor = (style: NightstandCardStyle, isDaylight: boolean): { className: string; css: React.CSSProperties } => {
    if (style === 'minimal') {
        return {
            className: 'rounded-3xl p-4',
            css: { textShadow: isDaylight ? '0 1px 24px rgba(255,255,255,0.8)' : '0 2px 28px rgba(0,0,0,0.85)' },
        };
    }
    if (style === 'solid') {
        return {
            className: 'overflow-hidden rounded-3xl border p-4',
            css: {
                backgroundColor: 'color-mix(in srgb, var(--bg-color) 96%, transparent)',
                borderColor: 'color-mix(in srgb, var(--text-primary) 12%, transparent)',
            },
        };
    }
    return { className: 'overflow-hidden rounded-3xl border p-4 backdrop-blur-2xl theme-glass-panel', css: {} };
};

/** 防烧屏漂移的幅度（px）与节奏：床头钟会长亮数小时，整层缓慢漂移，OLED 上没有像素一直显示同一内容。 */
const BURN_IN_DRIFT_PX = 12;
const BURN_IN_DRIFT_INTERVAL_MS = 45_000;
const BURN_IN_DRIFT_TRANSITION_MS = 40_000;

/** 右上角按钮闲置多久后淡出（ms）。 */
const CHROME_IDLE_MS = 4_000;

/** 移动拖拽的进行态：位移只影响视觉，松手才换算成顺序。 */
type MoveDrag = {
    id: NightstandWidgetId;
    pointerId: number;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    overId: NightstandWidgetId | null;
    placeAfter: boolean;
};

/** 尺寸拖拽的进行态：拖动中只画目标尺寸的虚线框，卡片本身不变，松手才换档落盘。 */
type ResizeDrag = {
    id: NightstandWidgetId;
    pointerId: number;
    startX: number;
    startY: number;
    base: NightstandWidgetSize;
    /** 一格加间距的像素数，按卡片实际尺寸量出来。 */
    step: number;
    target: NightstandWidgetSize;
    moved: boolean;
};

const NightstandOverlay: React.FC<NightstandOverlayProps> = ({ theme, isDaylight }) => {
    const { t } = useTranslation();
    const currentSong = usePlaybackStore(state => state.currentSong);
    const [config, setConfig] = useState<NightstandWidgetsConfig>(() => readNightstandWidgets());
    const [editing, setEditing] = useState(false);
    const [panelOpen, setPanelOpen] = useState(false);
    const [moveDrag, setMoveDrag] = useState<MoveDrag | null>(null);
    const [resizeDrag, setResizeDrag] = useState<ResizeDrag | null>(null);
    const cardRefs = useRef(new Map<NightstandWidgetId, HTMLDivElement>());
    // 拖过手柄后浏览器还会补一个 click，这一下不能再算作「点一下换档」。
    const suppressResizeClick = useRef(false);

    // 床头钟亮着的时候屏幕不睡（床头钟就是要一直看的）；竖回去或离开播放页就交还给系统。
    useEffect(() => {
        const keepAwake = window.Capacitor?.isNativePlatform?.() === true ? window.Capacitor.Plugins?.KeepAwake : undefined;
        if (!keepAwake) return undefined;
        void keepAwake.keepAwake();
        return () => { void keepAwake.allowSleep(); };
    }, []);

    // 每 45s 漂到 ±12px 内的一个新位置，40s 的过渡让漂移本身几乎不可察觉。
    const [drift, setDrift] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    useEffect(() => {
        const id = window.setInterval(() => {
            setDrift({
                x: Math.round((Math.random() * 2 - 1) * BURN_IN_DRIFT_PX),
                y: Math.round((Math.random() * 2 - 1) * BURN_IN_DRIFT_PX),
            });
        }, BURN_IN_DRIFT_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, []);

    // 右上角按钮闲置一会儿就淡出，床头钟只剩小组件；碰一下屏幕（或读屏/键盘把焦点移到按钮上）就回来。编辑态一直显示。
    const [chromeIdle, setChromeIdle] = useState(false);
    const chromeTimerRef = useRef<number | null>(null);
    const chromeRef = useRef<HTMLDivElement | null>(null);
    /** 渲染时同步的「此刻是否淡出」，给下面 window 上的监听读。 */
    const chromeHiddenRef = useRef(false);
    /** 淡出时点在按钮上的那一下只负责唤醒：它后面跟来的 click 也吞掉。 */
    const swallowChromeClickRef = useRef(false);
    const wakeChrome = useCallback(() => {
        setChromeIdle(false);
        if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current);
        chromeTimerRef.current = window.setTimeout(() => {
            // 键盘焦点停在按钮上时不淡出（看不见焦点在哪就没法操作）。
            const focused = document.activeElement;
            if (focused && chromeRef.current?.contains(focused) && focused.matches(':focus-visible')) return;
            setChromeIdle(true);
        }, CHROME_IDLE_MS);
    }, []);
    useEffect(() => {
        const inChrome = (target: EventTarget | null) => target instanceof Node && Boolean(chromeRef.current?.contains(target));
        // 按钮淡出时仍然接指针（读屏的「按下」按坐标命中，不能让它穿到底下去），只是第一下只唤醒、不触发按钮。
        const onPointerDown = (event: PointerEvent) => {
            if (chromeHiddenRef.current && inChrome(event.target)) {
                event.preventDefault();
                event.stopPropagation();
                swallowChromeClickRef.current = true;
            }
            wakeChrome();
        };
        // 读屏双击只发 click、不发 pointerdown：这种 click 照常触发按钮，同时把按钮唤醒。
        const onClick = (event: MouseEvent) => {
            if (swallowChromeClickRef.current && inChrome(event.target)) {
                event.preventDefault();
                event.stopPropagation();
            }
            swallowChromeClickRef.current = false;
            wakeChrome();
        };
        wakeChrome();
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('click', onClick, true);
        window.addEventListener('keydown', wakeChrome, true);
        window.addEventListener('focusin', wakeChrome, true);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('click', onClick, true);
            window.removeEventListener('keydown', wakeChrome, true);
            window.removeEventListener('focusin', wakeChrome, true);
            if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current);
        };
    }, [wakeChrome]);
    const chromeHidden = chromeIdle && !editing;
    chromeHiddenRef.current = chromeHidden;

    const update = useCallback((next: NightstandWidgetsConfig) => {
        setConfig(next);
        writeNightstandWidgets(next);
    }, []);

    const toggleWidget = (id: NightstandWidgetId) => {
        update({
            ...config,
            hidden: config.hidden.includes(id) ? config.hidden.filter(x => x !== id) : [...config.hidden, id],
        });
    };

    // 指针落在哪张卡上、在它的左半还是右半：决定松手时插到它前面还是后面。
    const hitTest = (x: number, y: number, draggedId: NightstandWidgetId): { overId: NightstandWidgetId; placeAfter: boolean } | null => {
        for (const [id, element] of cardRefs.current) {
            if (id === draggedId) continue;
            const rect = element.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                return { overId: id, placeAfter: x > rect.left + rect.width / 2 };
            }
        }
        return null;
    };

    const onCardPointerDown = (id: NightstandWidgetId) => (event: React.PointerEvent<HTMLDivElement>) => {
        if (!editing) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setMoveDrag({ id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dx: 0, dy: 0, overId: null, placeAfter: false });
    };

    const onCardPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        setMoveDrag(drag => {
            if (!drag || event.pointerId !== drag.pointerId) return drag;
            const hit = hitTest(event.clientX, event.clientY, drag.id);
            return {
                ...drag,
                dx: event.clientX - drag.startX,
                dy: event.clientY - drag.startY,
                overId: hit?.overId ?? null,
                placeAfter: hit?.placeAfter ?? false,
            };
        });
    };

    const onCardPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
        setMoveDrag(drag => {
            if (!drag || event.pointerId !== drag.pointerId) return drag;
            if (drag.overId) {
                const next = reorderedForDrop(config.order, drag.id, drag.overId, drag.placeAfter);
                if (next !== config.order) update({ ...config, order: next });
            }
            return null;
        });
    };

    const setWidgetSize = (id: NightstandWidgetId, size: NightstandWidgetSize) => {
        if (size === widgetSizeOf(config, id)) return;
        update({ ...config, sizes: { ...config.sizes, [id]: size } });
    };

    const onResizePointerDown = (id: NightstandWidgetId) => (event: React.PointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const base = widgetSizeOf(config, id);
        const rect = cardRefs.current.get(id)?.getBoundingClientRect();
        const rows = NIGHTSTAND_SIZE_SPAN[base].rows;
        const cell = rect ? (rect.height - (rows - 1) * CELL_GAP_PX) / rows : 120;
        suppressResizeClick.current = false;
        setResizeDrag({
            id,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            base,
            step: cell + CELL_GAP_PX,
            target: base,
            moved: false,
        });
    };

    const onResizePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        setResizeDrag(drag => {
            if (!drag || event.pointerId !== drag.pointerId) return drag;
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            const moved = drag.moved || Math.hypot(dx, dy) > RESIZE_TAP_SLOP_PX;
            const target = sizeForResizeDrag(drag.id, drag.base, dx, dy, drag.step);
            if (moved === drag.moved && target === drag.target) return drag;
            return { ...drag, moved, target };
        });
    };

    const onResizePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = resizeDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        setResizeDrag(null);
        // 没拖动就是点一下：交给 onClick 循环换档（读屏的激活动作也只走 click）。
        if (!drag.moved) return;
        suppressResizeClick.current = true;
        setWidgetSize(drag.id, drag.target);
    };

    const onResizePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (resizeDrag?.pointerId === event.pointerId) setResizeDrag(null);
    };

    const onResizeClick = (id: NightstandWidgetId) => (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (suppressResizeClick.current) {
            suppressResizeClick.current = false;
            return;
        }
        setWidgetSize(id, nextWidgetSize(id, widgetSizeOf(config, id)));
    };

    // 未播放时专辑封面卡整个不显示（而不是摆一张占位卡）。
    const visible = config.order.filter(id => !config.hidden.includes(id) && (id !== 'albumArt' || currentSong));
    const hiddenWidgets = config.order.filter(id => config.hidden.includes(id));
    const card = cardClassFor(config.cardStyle, isDaylight);
    const primary = theme.primaryColor;

    return (
        // 内边距用 max(设计值, 安全区)：桌面与网页 env 为 0 等于原 p-6，iOS 横屏让开两侧的刘海。
        // 编辑态整层（含空白处的退出层）不接播放页的左右滑动切歌：拖卡片换位、拖手柄改尺寸都是横向手势。
        <div
            data-player-swipe-ignore={editing || undefined}
            className="pointer-events-none fixed inset-0 z-30 flex flex-col justify-between"
            style={{
                color: primary,
                padding: 'max(1.5rem, env(safe-area-inset-top)) max(1.5rem, env(safe-area-inset-right)) max(1.5rem, env(safe-area-inset-bottom)) max(1.5rem, env(safe-area-inset-left))',
                transform: `translate(${drift.x}px, ${drift.y}px)`,
                transition: `transform ${BURN_IN_DRIFT_TRANSITION_MS}ms ease-in-out`,
            }}
        >
            <style>{`
                @keyframes nightstand-jiggle {
                    0% { transform: rotate(-0.8deg); }
                    50% { transform: rotate(0.8deg); }
                    100% { transform: rotate(-0.8deg); }
                }
                @keyframes nightstand-size-in {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                .nightstand-size-in { animation: nightstand-size-in 250ms ease-out; }
                /* 减弱动态效果：不抖动、换档直接替换（HIG accessibility › Cognitive） */
                @media (prefers-reduced-motion: reduce) {
                    .nightstand-jiggle, .nightstand-size-in { animation: none !important; }
                }
            `}</style>
            {/* 编辑态点空白处退出（这层在卡片下面，不挡卡片的手势） */}
            {editing && (
                <div
                    className="pointer-events-auto absolute inset-0"
                    onClick={() => { setEditing(false); setPanelOpen(false); }}
                />
            )}

            {/* 小组件区：固定边长的格子，每张卡按档位占 1×1 / 2×1 / 2×2，dense 让小卡补进空格 */}
            <div
                className="relative grid"
                style={{
                    '--ns-cell': CELL_SIZE,
                    '--ns-gap': `${CELL_GAP_PX}px`,
                    gridTemplateColumns: config.layout === 'grid' ? 'repeat(4, var(--ns-cell))' : 'repeat(auto-fill, var(--ns-cell))',
                    gridAutoRows: 'var(--ns-cell)',
                    gridAutoFlow: 'row dense',
                    gap: 'var(--ns-gap)',
                    // 横排铺满屏宽，右边让出右上角的按钮
                    width: config.layout === 'grid' ? 'max-content' : 'calc(100% - 3.5rem)',
                } as React.CSSProperties}
            >
                {visible.map((id, index) => {
                    const Widget = WIDGET_COMPONENTS[id];
                    const size = widgetSizeOf(config, id);
                    const span = NIGHTSTAND_SIZE_SPAN[size];
                    const isDragging = moveDrag?.id === id;
                    const isDropTarget = editing && moveDrag !== null && moveDrag.overId === id;
                    const resizing = resizeDrag?.id === id && resizeDrag.moved ? resizeDrag : null;
                    const targetSpan = resizing ? NIGHTSTAND_SIZE_SPAN[resizing.target] : null;
                    return (
                        <div
                            key={id}
                            ref={element => {
                                if (element) cardRefs.current.set(id, element);
                                else cardRefs.current.delete(id);
                            }}
                            className={`relative ${editing ? 'pointer-events-auto touch-none select-none' : ''}`}
                            style={{
                                gridColumn: `span ${span.cols}`,
                                gridRow: `span ${span.rows}`,
                                transform: isDragging ? `translate(${moveDrag.dx}px, ${moveDrag.dy}px) scale(1.05)` : undefined,
                                zIndex: isDragging || resizing ? 10 : undefined,
                                opacity: isDragging ? 0.9 : undefined,
                                outline: isDropTarget ? `2px dashed ${primary}` : undefined,
                                outlineOffset: isDropTarget ? 4 : undefined,
                                borderRadius: isDropTarget ? 24 : undefined,
                            }}
                            onPointerDown={onCardPointerDown(id)}
                            onPointerMove={onCardPointerMove}
                            onPointerUp={onCardPointerEnd}
                            onPointerCancel={onCardPointerEnd}
                        >
                            <div
                                className={`absolute inset-0 ${card.className} ${editing && !isDragging ? 'nightstand-jiggle' : ''}`}
                                style={{
                                    ...card.css,
                                    color: primary,
                                    animation: editing && !isDragging ? `nightstand-jiggle ${1.2 + (index % 3) * 0.15}s ease-in-out ${index * 0.08}s infinite` : undefined,
                                }}
                            >
                                {/* key 跟着档位走：换档时新排版淡入，而不是旧内容被拉伸 */}
                                <div key={size} className="nightstand-size-in h-full w-full">
                                    <Widget size={size} />
                                </div>
                            </div>
                            {/* 尺寸拖拽中：目标尺寸的虚线框 + 档位名，松手才换档 */}
                            {resizing && targetSpan && (
                                <div
                                    className="pointer-events-none absolute left-0 top-0 flex items-center justify-center rounded-3xl border-2 border-dashed text-sm font-medium"
                                    style={{
                                        width: spanLength(targetSpan.cols),
                                        height: spanLength(targetSpan.rows),
                                        borderColor: primary,
                                        backgroundColor: 'color-mix(in srgb, var(--text-primary) 8%, transparent)',
                                    }}
                                >
                                    {t(`nightstand.${SIZE_NAME_KEYS[resizing.target]}`)}
                                </div>
                            )}
                            {editing && (
                                <>
                                    {/* 左上角 −：收进「已隐藏」托盘。看得见的圆 24px，点击区 44px */}
                                    <button
                                        type="button"
                                        aria-label={t(`nightstand.${WIDGET_NAME_KEYS[id]}`)}
                                        onPointerDown={event => event.stopPropagation()}
                                        onClick={() => toggleWidget(id)}
                                        className="absolute -left-5 -top-5 z-10 flex h-11 w-11 items-center justify-center"
                                    >
                                        <span className="flex h-6 w-6 items-center justify-center rounded-full border shadow backdrop-blur-2xl theme-glass-panel">
                                            <Minus size={14} />
                                        </span>
                                    </button>
                                    {/* 右下角手柄：拖动按格子改尺寸，点一下循环换档。看得见的圆 24px，点击区 44px */}
                                    <button
                                        type="button"
                                        aria-label={`${t('nightstand.resizeHandle')} · ${t(`nightstand.${SIZE_NAME_KEYS[size]}`)}`}
                                        onPointerDown={onResizePointerDown(id)}
                                        onPointerMove={onResizePointerMove}
                                        onPointerUp={onResizePointerUp}
                                        onPointerCancel={onResizePointerCancel}
                                        onClick={onResizeClick(id)}
                                        className="absolute -bottom-4 -right-4 z-10 flex h-11 w-11 touch-none items-center justify-center"
                                        style={{ cursor: 'nwse-resize' }}
                                    >
                                        <span className="flex h-6 w-6 items-center justify-center rounded-full border shadow backdrop-blur-2xl theme-glass-panel">
                                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                                                <path d="M9 1 L1 9" />
                                                <path d="M9 5 L5 9" />
                                            </svg>
                                        </span>
                                    </button>
                                </>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* 底排：「已隐藏」托盘在右侧，避开居中的播放控制条。
                左下角的正在播放卡（Title / 歌手）按用户要求去掉；歌曲信息由播放控制条与资料库承担。 */}
            <div className="relative flex items-end justify-between gap-4">
                <span />
            </div>

            {/* 「已隐藏」托盘：右侧竖排，在右上角按钮下面；样式面板打开时让到面板左边 */}
            {editing && hiddenWidgets.length > 0 && (
                <div
                    data-nightstand-hidden-tray
                    className="pointer-events-auto absolute flex max-h-[calc(100vh-6.5rem)] flex-col items-stretch gap-2 overflow-y-auto rounded-2xl border px-3 py-2.5 backdrop-blur-2xl theme-glass-panel"
                    style={{
                        top: 'max(4.5rem, calc(env(safe-area-inset-top) + 3rem))',
                        right: panelOpen
                            ? 'calc(max(1.5rem, env(safe-area-inset-right)) + 18.75rem)'
                            : 'max(1.5rem, env(safe-area-inset-right))',
                    }}
                >
                    <span className="text-xs opacity-60">{t('nightstand.hiddenWidgets')}</span>
                    {hiddenWidgets.map(id => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => toggleWidget(id)}
                            className="flex min-h-11 items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1 text-sm"
                            style={{ borderColor: 'color-mix(in srgb, var(--text-primary) 25%, transparent)' }}
                        >
                            <Plus size={12} />
                            {t(`nightstand.${WIDGET_NAME_KEYS[id]}`)}
                        </button>
                    ))}
                </div>
            )}

            {editing && (
                <div className="pointer-events-none absolute inset-x-0 top-1.5 text-center text-xs opacity-60" style={{ textShadow: '0 1px 12px rgba(0,0,0,0.6)' }}>
                    {t('nightstand.editHint')}
                </div>
            )}

            {/* 右上角：编辑模式开关（齿轮进、对勾出）；样式与排列面板只留皮肤与排布 */}
            <div
                ref={chromeRef}
                className={`pointer-events-auto absolute right-6 top-6 flex gap-2 transition-opacity duration-500 motion-reduce:transition-none ${chromeHidden ? 'opacity-0' : 'opacity-100'}`}
                style={{ top: 'max(1.5rem, env(safe-area-inset-top))', right: 'max(1.5rem, env(safe-area-inset-right))' }}
            >
                {editing && (
                    <button
                        type="button"
                        aria-label={t('nightstand.styleAndLayout')}
                        onClick={() => setPanelOpen(open => !open)}
                        className="flex h-11 w-11 items-center justify-center rounded-full border backdrop-blur-2xl theme-glass-panel transition-opacity hover:opacity-80"
                    >
                        <Settings2 size={20} />
                    </button>
                )}
                <button
                    type="button"
                    aria-label={editing ? t('nightstand.editDone') : t('nightstand.customizeTitle')}
                    onClick={() => {
                        setEditing(value => !value);
                        setPanelOpen(false);
                    }}
                    className="flex h-11 w-11 items-center justify-center rounded-full border backdrop-blur-2xl theme-glass-panel transition-opacity hover:opacity-80"
                >
                    {editing ? <Check size={20} /> : <Settings2 size={20} />}
                </button>
            </div>

            {/* 样式与排列面板（只留皮肤与排布；换位、尺寸、开关都在卡片上直接做） */}
            {editing && panelOpen && (
                <div
                    className="pointer-events-auto absolute right-6 flex max-h-[calc(100vh-6.5rem)] w-72 flex-col gap-4 overflow-y-auto rounded-3xl border p-5 shadow-2xl backdrop-blur-2xl theme-glass-panel"
                    style={{ color: primary, top: 'max(4.5rem, calc(env(safe-area-inset-top) + 3rem))', right: 'max(1.5rem, env(safe-area-inset-right))' }}
                >
                    <div className="flex items-center justify-between">
                        <span className="text-lg font-medium">{t('nightstand.styleAndLayout')}</span>
                        <button type="button" aria-label={t('ui.close')} onClick={() => setPanelOpen(false)} className="-mr-3 flex h-11 w-11 items-center justify-center opacity-70 hover:opacity-100">
                            <X size={18} />
                        </button>
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="text-sm opacity-60">{t('nightstand.styleLabel')}</span>
                        <div className="flex gap-2">
                            {(['glass', 'solid', 'minimal'] as const).map(style => (
                                <button
                                    key={style}
                                    type="button"
                                    onClick={() => update({ ...config, cardStyle: style })}
                                    className={`min-h-11 flex-1 rounded-xl border px-2 py-1.5 text-sm ${config.cardStyle === style ? 'font-medium' : 'opacity-60'}`}
                                    style={{ borderColor: 'color-mix(in srgb, var(--text-primary) 20%, transparent)' }}
                                >
                                    {t(`nightstand.style${style[0].toUpperCase()}${style.slice(1)}`)}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="text-sm opacity-60">{t('nightstand.layoutLabel')}</span>
                        <div className="flex gap-2">
                            {(['row', 'grid'] as const).map((layout: NightstandLayout) => (
                                <button
                                    key={layout}
                                    type="button"
                                    onClick={() => update({ ...config, layout })}
                                    className={`min-h-11 flex-1 rounded-xl border px-2 py-1.5 text-sm ${config.layout === layout ? 'font-medium' : 'opacity-60'}`}
                                    style={{ borderColor: 'color-mix(in srgb, var(--text-primary) 20%, transparent)' }}
                                >
                                    {t(`nightstand.layout${layout[0].toUpperCase()}${layout.slice(1)}`)}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default memo(NightstandOverlay);
