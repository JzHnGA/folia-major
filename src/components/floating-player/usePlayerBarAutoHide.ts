import { useCallback, useEffect, useRef, useState } from 'react';

// src/components/floating-player/usePlayerBarAutoHide.ts
// 底部播放控制条的空闲自动收起：整条滑到屏幕下方，底边留一个向上箭头（FloatingPlayerControls 的
// player-bar-reveal）提示可以拖回来。换页、换歌、播放 / 暂停都会重新数；用户在墙上动手（拖动整面墙、
// 点墙上的卡）时立刻把条收起来给它让路——收着的时候按墙不会把它带回来，只有点 / 拖底边那个箭头才回来。
// 只在触屏（主指针不是鼠标）上成立：桌面沿用播放页自己的控制条自动隐藏（usePlayerChromeAutoHide）。
// 暂停 / 未播放时也收：控制条只在用得到的时候占着墙底；播放开始时它会自己回来，过一会儿再收起。
// 计时用 ref，不因为一次点击而重渲染整条控制条；只有真的收起 / 回来才 setState。

export const PLAYER_BAR_AUTO_HIDE_MS = 5000;

export const usePlayerBarAutoHide = ({ enabled, resetKey, onBeforeHide }: {
    /** 此刻可以自动收起（触屏、正在播放、没有展开 / 面板 / 浮层 / 定位等交互）。 */
    enabled: boolean;
    /** 换页、换歌、播放 / 暂停：变化时让控制条回来重新数。 */
    resetKey: string;
    /** 收起之前量一次滑出距离（组件按底距 + 胶囊高度算），在隐藏的那一帧之前就写好。 */
    onBeforeHide?: () => void;
}) => {
    const [hidden, setHidden] = useState(false);
    const hiddenRef = useRef(false);
    const enabledRef = useRef(enabled);
    const timerRef = useRef<number | null>(null);

    const clearTimer = useCallback(() => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const hideNow = useCallback(() => {
        clearTimer();
        if (hiddenRef.current) return;
        onBeforeHide?.();
        hiddenRef.current = true;
        setHidden(true);
    }, [clearTimer, onBeforeHide]);

    const schedule = useCallback(() => {
        clearTimer();
        if (!enabledRef.current || hiddenRef.current) return;
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            hideNow();
        }, PLAYER_BAR_AUTO_HIDE_MS);
    }, [clearTimer, hideNow]);

    useEffect(() => {
        enabledRef.current = enabled;
    }, [enabled]);

    useEffect(() => {
        clearTimer();
        hiddenRef.current = false;
        setHidden(false);
        if (!enabled) return clearTimer;
        schedule();
        return clearTimer;
    }, [clearTimer, enabled, resetKey, schedule]);

    const reveal = useCallback(() => {
        hiddenRef.current = false;
        setHidden(false);
        schedule();
    }, [schedule]);

    // 在墙上动手（拖动整面墙、点墙上的卡）＝给它让路：没收起就立刻收起来，已经收着就保持收着。
    // 按在条自己、搜索、设置、菜单里只是把 5 秒重新数一遍，不改变收起状态；要把它叫回来用底边的把手。
    useEffect(() => {
        if (!enabled) return undefined;
        const onWall = (event: PointerEvent) => event.target instanceof Element
            && Boolean(event.target.closest('.lattice-field, [data-grid-canvas], [data-grid3d-slider]'));
        const onPointerDown = (event: PointerEvent) => {
            if (onWall(event)) hideNow();
            else schedule();
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        return () => window.removeEventListener('pointerdown', onPointerDown, true);
    }, [enabled, hideNow, schedule]);

    // 转屏 / 窗口尺寸变了：收起时的滑出距离是按当时的高度算的，直接让它回来，重新数。
    useEffect(() => {
        if (!hidden) return undefined;
        const onResize = () => {
            hiddenRef.current = false;
            setHidden(false);
            schedule();
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [hidden, schedule]);

    useEffect(() => clearTimer, [clearTimer]);

    return { hidden, reveal };
};
