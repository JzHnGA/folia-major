// src/library/suites/bravais/bravaisBack.ts
// 墙上「回到播放页」这一项要不要画（首页「⋯」工具格里）。左上角那颗隐藏式返回已去掉（用户定，移动端）：退回上一层
// 用信息条里的 ‹，回到可视化播放页点底部的控制条。

/**
 * 「有没有可回的播放页」：有正在播放 / 已加载的歌（usePlaybackStore.currentSong）。首页「⋯」里的「回到播放页」
 * 按它显示 / 隐藏（fb8：「⋯」里的那项原来总是显示，没有歌时点它进的是空的播放页）。
 */
export const selectBravaisHasCurrentSong = (state: { currentSong: unknown }): boolean => state.currentSong !== null;
