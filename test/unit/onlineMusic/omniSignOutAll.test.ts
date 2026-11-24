import { afterEach, describe, expect, it, vi } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import { setProviderSongCleanup } from '@/services/onlineMusic/account/providerSongCleanup';
import { registerOnlineMusicProvider, unregisterOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import type * as ProviderRegistryModule from '@/services/onlineMusic/providerRegistry';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';
import type { UnifiedSong } from '@/types';
import type { OnlineAuthProvider, OnlineMusicProvider, ProviderCapabilities } from '@/types/onlineMusic';

// test/unit/onlineMusic/omniSignOutAll.test.ts
// 设置里「清除所有登录信息」的底层动作：每个登录着的平台各走一次和账号页相同的退出，
// 没登录的平台不碰；某个平台退出失败不影响其它平台。

// 只让 omni 看到本用例登记的假平台：真实平台在这里退出会发请求 / 动本机会话。
const { testProviders } = vi.hoisted(() => ({ testProviders: [] as OnlineMusicProvider[] }));

vi.mock('@/services/onlineMusic/providerRegistry', async importOriginal => ({
    ...(await importOriginal<typeof ProviderRegistryModule>()),
    listOnlineMusicProviders: () => testProviders,
}));

const ID_A = 'omni-signout-a';
const ID_B = 'omni-signout-b';
const ID_C = 'omni-signout-c';

const capabilities: ProviderCapabilities = {
    search: false, playback: false, lyrics: false, auth: true, userLibrary: false,
    playlists: false, albums: false, artists: false, recommendations: false,
    mutations: false, wordByWordLyrics: false,
};

const signedInUser = { id: 'user', nickname: 'Listener' } as const;

const makeProvider = (id: string, logout: OnlineAuthProvider['logout']): OnlineMusicProvider => {
    const provider: OnlineMusicProvider = {
        id,
        displayName: id,
        capabilities,
        normalizeSong: raw => raw as unknown as UnifiedSong,
        auth: { getLoginStatus: async () => signedInUser, logout } as unknown as OnlineAuthProvider,
    };
    testProviders.push(provider);
    return provider;
};

const signIn = (providerId: string) => {
    useOnlineProviderAccountStore.getState().updateAccount(providerId, {
        status: 'authenticated',
        user: { ...signedInUser },
        hydration: 'ready',
        freshness: 'fresh',
    });
};

afterEach(() => {
    setProviderSongCleanup(null);
    testProviders.length = 0;
    unregisterOnlineMusicProvider(ID_A);
    unregisterOnlineMusicProvider(ID_B);
    unregisterOnlineMusicProvider(ID_C);
    useOnlineProviderAccountStore.getState().clearAccount(ID_A);
    useOnlineProviderAccountStore.getState().clearAccount(ID_B);
    useOnlineProviderAccountStore.getState().clearAccount(ID_C);
    omni.invalidateActiveRequests();
});

describe('omni.signOutAllAccounts', () => {
    it('signs out every platform with auth, including one whose account has not been read yet', async () => {
        const logoutA = vi.fn(async () => undefined);
        const logoutB = vi.fn(async () => undefined);
        const logoutC = vi.fn(async () => undefined);
        registerOnlineMusicProvider(makeProvider(ID_A, logoutA));
        registerOnlineMusicProvider(makeProvider(ID_B, logoutB));
        registerOnlineMusicProvider(makeProvider(ID_C, logoutC));
        signIn(ID_A);
        signIn(ID_B);
        // C 的账号读数还没回来 / 失败了：store 里没有 user，但设备上可能仍存着它的会话。
        const dropSongs = vi.fn();
        setProviderSongCleanup(dropSongs);

        await omni.signOutAllAccounts();

        expect(dropSongs.mock.calls.map(([providerId]) => providerId).sort()).toEqual([ID_A, ID_B, ID_C]);
        expect(logoutA).toHaveBeenCalledTimes(1);
        expect(logoutB).toHaveBeenCalledTimes(1);
        expect(logoutC).toHaveBeenCalledTimes(1);
        for (const providerId of [ID_A, ID_B, ID_C]) {
            expect(useOnlineProviderAccountStore.getState().accounts[providerId]?.user).toBeNull();
        }
    });

    it('moves each platform\'s songs out before signing it out', async () => {
        const order: string[] = [];
        registerOnlineMusicProvider(makeProvider(ID_A, async () => { order.push('logout'); }));
        signIn(ID_A);
        setProviderSongCleanup(providerId => { order.push(`songs:${providerId}`); });

        await omni.signOutAllAccounts();

        expect(order).toEqual([`songs:${ID_A}`, 'logout']);
    });

    it('keeps going when one platform fails to sign out', async () => {
        const logoutA = vi.fn(async () => { throw new Error('offline'); });
        const logoutB = vi.fn(async () => undefined);
        registerOnlineMusicProvider(makeProvider(ID_A, logoutA));
        registerOnlineMusicProvider(makeProvider(ID_B, logoutB));
        signIn(ID_A);
        signIn(ID_B);

        await expect(omni.signOutAllAccounts()).resolves.toBeUndefined();

        expect(logoutA).toHaveBeenCalledTimes(1);
        expect(logoutB).toHaveBeenCalledTimes(1);
        expect(useOnlineProviderAccountStore.getState().accounts[ID_A]?.user).toBeNull();
        expect(useOnlineProviderAccountStore.getState().accounts[ID_B]?.user).toBeNull();
    });

    it('a cleanup that throws does not stop the sign-outs', async () => {
        const logoutA = vi.fn(async () => undefined);
        const logoutB = vi.fn(async () => undefined);
        registerOnlineMusicProvider(makeProvider(ID_A, logoutA));
        registerOnlineMusicProvider(makeProvider(ID_B, logoutB));
        signIn(ID_A);
        signIn(ID_B);
        setProviderSongCleanup(providerId => {
            if (providerId === ID_A) throw new Error('player not ready');
        });

        await expect(omni.signOutAllAccounts()).resolves.toBeUndefined();

        expect(logoutA).toHaveBeenCalledTimes(1);
        expect(logoutB).toHaveBeenCalledTimes(1);
    });
});
