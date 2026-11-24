import { useSyncExternalStore } from 'react';

// src/hooks/useSafeAreaSidesPx.ts
// 左右安全区（iPhone 横屏的灵动岛 / 刘海与圆角）的唯一出处：在文档里放一个不可见的量尺读
// env(safe-area-inset-left/right)，改方向 / 窗口变化时重新量。竖屏与没有安全区的设备读出来是 0。
// 墙面铺满屏幕（fixed 壳吃不到 #root 的内边距），要让开这一段的只有贴边的信息条与它的标签，
// 所以调用方是 BravaisStage；底部安全区仍用 useSafeAreaBottomPx。

const PROBE_ID = 'folia-safe-area-sides-probe';

export type SafeAreaSides = { left: number; right: number };

const readSafeAreaSides = (): SafeAreaSides => {
    if (typeof document === 'undefined') return { left: 0, right: 0 };
    let probe = document.getElementById(PROBE_ID);
    if (!probe) {
        probe = document.createElement('div');
        probe.id = PROBE_ID;
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);';
        document.body.appendChild(probe);
    }
    const style = getComputedStyle(probe);
    const left = Number.parseFloat(style.paddingLeft);
    const right = Number.parseFloat(style.paddingRight);
    return { left: Number.isFinite(left) ? left : 0, right: Number.isFinite(right) ? right : 0 };
};

// 模块加载时就量一次：第一帧的相机 / 缝规划就要按安全区算，不能等订阅后的 effect 再补，
// 否则横屏首帧会把书脊开在灵动岛下面（之后再缩回标签，看得到一次跳动）。
let cached: SafeAreaSides = readSafeAreaSides();

const getSnapshot = (): SafeAreaSides => cached;

const listeners = new Set<() => void>();
let listening = false;

const update = () => {
    const next = readSafeAreaSides();
    if (next.left === cached.left && next.right === cached.right) return;
    cached = next;
    listeners.forEach(listener => listener());
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (!listening) {
        listening = true;
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
    }
    // 订阅发生在挂载之后：这时才第一次真正量（首帧读到的可能还是 0）。
    update();
    return () => {
        listeners.delete(listener);
    };
};

/** 此刻左右两侧的安全区（px）；没有安全区时都是 0。 */
export const useSafeAreaSidesPx = (): SafeAreaSides => useSyncExternalStore(subscribe, getSnapshot, () => cached);
