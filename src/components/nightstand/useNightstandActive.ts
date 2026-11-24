// src/components/nightstand/useNightstandActive.ts
// 床头钟是否正盖在播放页上（支持床头钟的平台 + 横屏）。播放页自己的右下角按钮（PanelHandle）读它让位：
// 床头钟只留右上角一颗按钮（HIG 审查：两颗一样的齿轮会让人分不清各管什么）。

import { useState } from 'react';
import { isNightstandSupported } from './nightstandPlatform';
import { useIsLandscape } from './useIsLandscape';

/** 支持床头钟且横屏时为 true；只在播放页上用（床头钟只叠在播放页上）。 */
export const useNightstandActive = (): boolean => {
    const [supported] = useState(isNightstandSupported);
    const isLandscape = useIsLandscape();
    return supported && isLandscape;
};
