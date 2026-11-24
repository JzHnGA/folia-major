import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForAccountIdentity } from '@/services/onlineMusic/startupAccountReads';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';

// test/unit/onlineMusic/startupAccountReads.test.ts
// 启动动画等账户状态的规则：平台说出谁登录着（或说没人）就结束；一直没答案时到时限结束。

const providerId = 'startup-account-test';

beforeEach(() => {
    vi.useFakeTimers();
    useOnlineProviderAccountStore.setState({ accounts: {}, activeProviderId: 'netease' });
});

afterEach(() => {
    vi.useRealTimers();
    useOnlineProviderAccountStore.setState({ accounts: {}, activeProviderId: 'netease' });
});

describe('waitForAccountIdentity', () => {
    it('resolves once the platform has answered who is signed in', async () => {
        useOnlineProviderAccountStore.getState().updateAccount(providerId, {
            status: 'unknown',
            hydration: 'loading',
            freshness: 'refreshing',
        });
        let settled = false;
        const wait = waitForAccountIdentity([providerId], 3_000).then(() => { settled = true; });
        expect(settled).toBe(false);

        useOnlineProviderAccountStore.getState().updateAccount(providerId, {
            status: 'anonymous',
            hydration: 'ready',
            freshness: 'fresh',
        });

        await wait;
        expect(settled).toBe(true);
    });

    it('resolves when the wait runs out without an answer', async () => {
        useOnlineProviderAccountStore.getState().updateAccount(providerId, {
            status: 'unknown',
            hydration: 'loading',
            freshness: 'refreshing',
        });
        let settled = false;
        const wait = waitForAccountIdentity([providerId], 3_000).then(() => { settled = true; });

        await vi.advanceTimersByTimeAsync(2_999);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await wait;
        expect(settled).toBe(true);
    });
});
