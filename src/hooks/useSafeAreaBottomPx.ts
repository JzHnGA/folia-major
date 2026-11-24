import { useSyncExternalStore } from 'react';

// src/hooks/useSafeAreaBottomPx.ts
// 底部安全区（iPhone 的 Home 指示条）的唯一出处：在文档里放一个不可见的量尺读 env(safe-area-inset-bottom)。
// 桌面浏览器、没有安全区的设备读出来是 0；改方向 / 窗口变化时重新量。所有贴底固定的东西（播放胶囊、
// 面板、墙工具按钮、字幕、空墙说明的让位）都用这一个值，免得每处各写一遍 env()。

const PROBE_ID = 'folia-safe-area-bottom-probe';

let cached = 0;

const readSafeAreaBottom = (): number => {
    if (typeof document === 'undefined') return 0;
    const host = document.body;
    let probe = document.getElementById(PROBE_ID);
    if (!probe) {
        probe = document.createElement('div');
        probe.id = PROBE_ID;
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none;';
        host.appendChild(probe);
    }
    const value = Number.parseFloat(getComputedStyle(probe).height);
    return Number.isFinite(value) ? value : 0;
};

const getSnapshot = (): number => cached;

const listeners = new Set<() => void>();
let listening = false;

const update = () => {
    const next = readSafeAreaBottom();
    if (next === cached) return;
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

/** 此刻底部的安全区高度（px）；没有安全区时是 0。 */
export const useSafeAreaBottomPx = (): number => useSyncExternalStore(subscribe, getSnapshot, () => 0);
