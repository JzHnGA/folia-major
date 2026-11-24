import React from 'react';
import { hideAppSplash } from '../utils/appSplash';

// src/components/AppSplashGate.tsx
// 包在根组件树外层：首帧挂载完成后（useEffect 在浏览器绘制之后触发）移除首屏加载遮罩，
// 保证遮罩淡出时下面已经是渲染好的界面，而不是空白。
//
// `waitFor`：首屏还依赖的启动结果（iOS 壳的登录状态确认）。等它落定、再等两帧让最终账户状态画出来，
// 才撤启动动画；这样动画结束时看到的是插头或头像，而不是缓存账号闪一下。

const afterNextPaint = (): Promise<void> => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

const AppSplashGate: React.FC<{ children: React.ReactNode; waitFor?: Promise<void> | null }> = ({ children, waitFor = null }) => {
    React.useEffect(() => {
        let cancelled = false;
        const hide = () => {
            if (!cancelled) hideAppSplash();
        };
        if (!waitFor) {
            hide();
            return () => { cancelled = true; };
        }
        void waitFor.catch(() => {}).then(afterNextPaint).then(hide);
        return () => { cancelled = true; };
    }, [waitFor]);

    return <>{children}</>;
};

export default AppSplashGate;
