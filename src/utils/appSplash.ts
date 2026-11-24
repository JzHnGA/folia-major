// src/utils/appSplash.ts
// 控制 index.html 内联的首屏加载遮罩：React 挂载后淡出，动画结束再从 DOM 摘掉。

const SPLASH_ELEMENT_ID = 'app-splash';
// 与 index.html 中 #app-splash 的 transition 时长保持一致。
const FADE_OUT_MS = 320;

// 淡出并移除首屏加载遮罩；遮罩不存在（OBS 源已提前移除、或已经调用过）时是空操作。
// iOS 原生壳下网页遮罩在 index.html 里已被移除，取而代之通知原生启动动画淡出；
// 最短展示时长（1.2s）与兜底超时由原生层掌握。
export const hideAppSplash = (): void => {
    const nativeLaunchSplash = window.Capacitor?.Plugins?.LaunchSplash;
    if (nativeLaunchSplash) {
        void nativeLaunchSplash.hide().catch(() => {});
        return;
    }

    const splash = document.getElementById(SPLASH_ELEMENT_ID);
    if (!splash) {
        return;
    }
    splash.classList.add('is-hiding');
    window.setTimeout(() => splash.remove(), FADE_OUT_MS);
};
