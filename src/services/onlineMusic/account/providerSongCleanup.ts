import type { OnlineProviderId } from '../../../types/onlineMusic';

// src/services/onlineMusic/account/providerSongCleanup.ts
// 「清除所有登录信息」时，把那个平台留在播放器里的歌一起拿走所需的一个出口：App 持有播放器的
// DOM 与歌词句柄（library/app/createLibraryAccountPort.ts 的 dropProviderSongs），omni 不持有。
// App 在挂载时登记，设置页的动作经 omni 调用；没有登记（没有播放器）时什么也不做。
// 与账号页的退出保持同一个顺序：先移走这个平台的歌，再退出登录。

type ProviderSongCleanup = (providerId: OnlineProviderId) => void | Promise<void>;

let cleanup: ProviderSongCleanup | null = null;

export const setProviderSongCleanup = (next: ProviderSongCleanup | null): void => {
    cleanup = next;
};

/** 退出一个平台之前调用；没有登记时是 no-op。 */
export const dropProviderSongsForSignOut = (providerId: OnlineProviderId): void | Promise<void> => cleanup?.(providerId);
