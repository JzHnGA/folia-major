import { useOnlineProviderAccountStore } from '../../stores/useOnlineProviderAccountStore';
import type { OnlineProviderId } from '../../types/onlineMusic';
import { omni } from './omni';

// src/services/onlineMusic/startupAccountReads.ts
// 启动时在启动动画背后读一次各平台的账户：iOS 壳等「谁登录着」有了答案（或最多等 STARTUP_ACCOUNT_WAIT_MS）
// 再撤启动动画，避免动画结束后先画出缓存账号、再变成未登录。超时只结束等待，读取本身继续在后台进行。

export const STARTUP_ACCOUNT_WAIT_MS = 3_000;

const accountSettled = (providerId: OnlineProviderId): boolean => {
    const account = useOnlineProviderAccountStore.getState().accounts[providerId];
    return Boolean(account) && account.hydration === 'ready' && account.status !== 'unknown';
};

/** 等这些平台的账户状态确定；到 `timeoutMs` 还没全部确定也 resolve。 */
export const waitForAccountIdentity = (
    providerIds: readonly OnlineProviderId[],
    timeoutMs: number,
): Promise<void> => {
    if (providerIds.every(accountSettled)) return Promise.resolve();
    return new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: () => void = () => {};
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (timer !== null) clearTimeout(timer);
            unsubscribe();
            resolve();
        };
        timer = setTimeout(finish, timeoutMs);
        unsubscribe = useOnlineProviderAccountStore.subscribe(() => {
            if (providerIds.every(accountSettled)) finish();
        });
    });
};

let startup: Promise<void> | null = null;

/** 在启动动画背后读一次账户；同一个页面只开始一次。 */
export const startStartupAccountReads = (): Promise<void> => {
    if (startup) return startup;
    const providerIds = omni.getProviderSummaries()
        .filter(provider => provider.requiresAccount)
        .map(provider => provider.providerId);
    if (providerIds.length === 0) {
        startup = Promise.resolve();
        return startup;
    }
    // 先开始读再订阅：读的同步部分已经把状态置为 unknown/loading，等待不会把最初的 anonymous 当成答案。
    providerIds.forEach(providerId => { void omni.readAccount(providerId, 'start'); });
    startup = waitForAccountIdentity(providerIds, STARTUP_ACCOUNT_WAIT_MS);
    return startup;
};
