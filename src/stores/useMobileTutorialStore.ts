import { create } from 'zustand';
import { getStoredString, setStoredString } from './storagePrimitives';

// src/stores/useMobileTutorialStore.ts
// iOS 壳的新手教程：首启自动打开一次，设置里可以重播。Ponder 在 iOS 构建里不挂载，这一套是它的手机替代。
// 是否看过存在 localStorage（`folia_mobile_tutorial_v2`），存不进去也只在本次会话里少弹一次。

// v2：教程改成带示范动画的完整版（2026-11-21），看过旧版的也再看一次。
const STORAGE_KEY = 'folia_mobile_tutorial_v2';

const readSeen = (): boolean => getStoredString(STORAGE_KEY, '') === 'seen';

type MobileTutorialState = {
    isOpen: boolean;
    hasSeen: boolean;
    step: number;
    /**
     * 教程第一步正在演示的页签：信息条把它当作「被点开」展开成全名（只看不切页），教程按顺序换下一个。
     * 不持久化；教程关掉或离开那一步时清空。
     */
    previewTabKey: string | null;
    setPreviewTabKey: (key: string | null) => void;
    /**
     * 教程第一步的页签演示正在跑（含两次展开之间的空档）：信息条在这期间不画当前页签的激活底色，
     * 免得它和正在演示的那一格同时亮着。不持久化。
     */
    previewingTabs: boolean;
    setPreviewingTabs: (previewing: boolean) => void;
    open: () => void;
    close: () => void;
    next: (total: number) => void;
    back: () => void;
    goTo: (step: number) => void;
};

export const useMobileTutorialStore = create<MobileTutorialState>((set) => ({
    isOpen: false,
    hasSeen: readSeen(),
    step: 0,
    previewTabKey: null,
    setPreviewTabKey: key => set({ previewTabKey: key }),
    previewingTabs: false,
    setPreviewingTabs: previewing => set({ previewingTabs: previewing }),
    open: () => set({ isOpen: true, step: 0 }),
    close: () => {
        setStoredString(STORAGE_KEY, 'seen');
        set({ isOpen: false, hasSeen: true, previewTabKey: null, previewingTabs: false });
    },
    next: total => set(state => ({ step: Math.min(Math.max(0, total - 1), state.step + 1) })),
    back: () => set(state => ({ step: Math.max(0, state.step - 1) })),
    goTo: step => set({ step: Math.max(0, step) }),
}));

/** 设置里的「查看新手教程」：打开时从头开始。 */
export const openMobileTutorial = (): void => useMobileTutorialStore.getState().open();
