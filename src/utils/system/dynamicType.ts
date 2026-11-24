// src/utils/system/dynamicType.ts
// iOS 壳里跟随系统「文字大小」（Dynamic Type）：WKWebView 把系统正文字号交给 `font: -apple-system-body`，
// 这里量出它和默认正文（17pt）的比例，换算成 <html> 的根字号，用 rem 的 Tailwind 尺寸（text-sm、h-11……）随之缩放。
// 默认档比例为 1，根字号仍是 16px，界面不变。比例钳在 [MIN_SCALE, MAX_SCALE]：海报墙、歌词这类按 rem 排的大块
// 在最大辅助功能字号下不至于挤坏；写死 px 的文字不受影响，要跟随的地方改用 rem。

/** iOS 默认（Large）档的正文字号（pt）。 */
const DEFAULT_BODY_PT = 17;
const BASE_ROOT_PX = 16;
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.4;

/** 量一次系统正文字号，返回相对默认档的比例。量不到（非 WebKit）时返回 1。 */
const measureBodyScale = (): number => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;font:-apple-system-body';
    document.body.appendChild(probe);
    const size = Number.parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    if (!Number.isFinite(size) || size <= 0) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, size / DEFAULT_BODY_PT));
};

const applyRootFontSize = () => {
    const scale = measureBodyScale();
    document.documentElement.style.fontSize = scale === 1 ? '' : `${(BASE_ROOT_PX * scale).toFixed(2)}px`;
    document.documentElement.dataset.dynamicTypeScale = scale.toFixed(2);
};

/**
 * 装上 Dynamic Type 跟随：启动时量一次；从后台回来（人可能刚在设置里改了字号）再量一次。
 * 只在原生壳里调用：浏览器和桌面版的根字号交给浏览器自己的缩放。
 */
export const installDynamicType = (): void => {
    if (typeof document === 'undefined') return;
    applyRootFontSize();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') applyRootFontSize();
    });
};
