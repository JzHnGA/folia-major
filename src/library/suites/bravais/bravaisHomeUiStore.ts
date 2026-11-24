import { create } from 'zustand';

// src/library/suites/bravais/bravaisHomeUiStore.ts
// 首页缝里的全局搜索框开没开（B9）。它不是导航（不写 history），也不是缝的等级：开着时首页窄缝临时展开成完整宽度的
// 搜索框（bravaisSeamTarget 的 search 变体），提交（走 onSearchCommitted 去 SearchWorkspace）、「关闭搜索」、Esc、
// 折叠缝、换 suite（stage 卸载）都会关上。模块作用域，stage 与 surface 共用。
// fb3：书脊上的「⋯」要先把缝展开成窄缝、再打开窄缝里的菜单。书脊与窄缝是同一个组件的两种
// 排版，但翻转换内容时不保证是同一个实例，所以「展开后要打开什么」记在这里（openRequest），窄缝渲染出来时消费掉。
// 窄缝里的弹层（工具格的「⋯」菜单）开没开记在 popover。

/** 书脊展开成窄缝后要打开的东西：工具格的「⋯」菜单。 */
export type BravaisHomeOpenRequest = 'menu';

/** 首页窄缝里此刻开着的弹层（与 openRequest 同一组取值）。 */
export type BravaisHomePopover = BravaisHomeOpenRequest;

type BravaisHomeUiState = {
    searchOpen: boolean;
    openRequest: BravaisHomeOpenRequest | null;
    popover: BravaisHomePopover | null;
    /**
     * 信息条横向、页签被缩成一个字母时，用户点开的那个页签：它临时展开成全名，中间那段让出宽度。
     * 2.5 秒后或点到别处收起；切页签翻内容时不丢。
     */
    revealedTabKey: string | null;
    /** 这个展开到什么时候（performance.now 的时间基准，Date.now 也行；这里用 Date.now）。 */
    revealedUntil: number | null;
};

export const useBravaisHomeUiStore = create<BravaisHomeUiState>(() => ({
    searchOpen: false,
    openRequest: null,
    popover: null,
    revealedTabKey: null,
    revealedUntil: null,
}));

export const setBravaisSearchOpen = (open: boolean) => {
    if (useBravaisHomeUiStore.getState().searchOpen !== open) useBravaisHomeUiStore.setState({ searchOpen: open });
};

/** 记下 / 清掉书脊展开后要打开的东西。 */
export const setBravaisHomeOpenRequest = (request: BravaisHomeOpenRequest | null) => {
    if (useBravaisHomeUiStore.getState().openRequest !== request) useBravaisHomeUiStore.setState({ openRequest: request });
};

/** 开一个弹层（另一个随之收起），或收起全部（null）。 */
export const setBravaisHomePopover = (popover: BravaisHomePopover | null) => {
    if (useBravaisHomeUiStore.getState().popover !== popover) useBravaisHomeUiStore.setState({ popover });
};

/** 收起某一个弹层：此刻开着的正是它才收（别的弹层开着时不动）。 */
export const closeBravaisHomePopover = (popover: BravaisHomePopover) => {
    if (useBravaisHomeUiStore.getState().popover === popover) useBravaisHomeUiStore.setState({ popover: null });
};

/** 页签展开全名：`until` 是 Date.now() 的截止时刻。 */
export const revealBravaisHomeTab = (key: string, until: number) => {
    const state = useBravaisHomeUiStore.getState();
    if (state.revealedTabKey === key && state.revealedUntil === until) return;
    useBravaisHomeUiStore.setState({ revealedTabKey: key, revealedUntil: until });
};

/** 收起展开的页签；没有展开时不动。 */
export const clearBravaisHomeTab = () => {
    const state = useBravaisHomeUiStore.getState();
    if (state.revealedTabKey === null) return;
    useBravaisHomeUiStore.setState({ revealedTabKey: null, revealedUntil: null });
};
