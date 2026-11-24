// src/components/nightstand/useIsLandscape.ts
// 横屏检测：订阅 orientation 媒体查询，输出离散布尔（只在方向真正翻转时变化，可进 React state）。

import { useSyncExternalStore } from 'react';

const LANDSCAPE_QUERY = '(orientation: landscape)';

const subscribe = (onChange: () => void): (() => void) => {
    const mql = window.matchMedia(LANDSCAPE_QUERY);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
};

const getSnapshot = (): boolean => (
    typeof window !== 'undefined' ? window.matchMedia(LANDSCAPE_QUERY).matches : false
);

/** 当前是否横屏。 */
export const useIsLandscape = (): boolean => useSyncExternalStore(subscribe, getSnapshot, () => false);
