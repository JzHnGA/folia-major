// src/components/nightstand/nightstandPlatform.ts
// Nightstand（床头钟）模式的运行平台判定：在原生 iOS 壳（Capacitor WebView）里自动启用；
// 浏览器里可用 ?nightstand=1 强制打开，便于在桌面调试横屏布局。
// Window.Capacitor 的类型登记在 src/vite-env.d.ts。

/** 原生壳（iOS）里为 true；`?nightstand=1` 可在任意浏览器里强制启用（调试用）。 */
export const isNightstandSupported = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        if (new URLSearchParams(window.location.search).get('nightstand') === '1') return true;
    } catch {
        // location 不可读时按未强制启用处理。
    }
    return window.Capacitor?.isNativePlatform?.() === true;
};
