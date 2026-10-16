import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/hooks/useAppleMusicLibrary.test.ts

const mocks = vi.hoisted(() => ({
    effects: [] as Array<() => unknown>,
    getProviderSummaries: vi.fn(),
    getProviderAvailability: vi.fn(),
    getLoginStatus: vi.fn(),
    getProviderUserPlaylists: vi.fn(),
    logout: vi.fn(),
    loadProviderAccountSnapshot: vi.fn(),
    saveProviderAccountSnapshot: vi.fn(),
    clearProviderAccountSnapshot: vi.fn(),
    setStatusMessage: vi.fn(),
}));
vi.mock('react', () => ({
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => unknown) => { mocks.effects.push(effect); },
}));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: mocks }));
vi.mock('@/services/onlineMusic/providerAccountCache', () => mocks);
vi.mock('@/stores/useStatusMessageStore', () => ({ setStatusMessage: mocks.setStatusMessage }));
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }));

const ID = 'apple-music';
const LOCAL_USER = { id: 'local', nickname: '音乐资料库' };
const DENIED = 'apple-music-permission-denied';
const playlist = (id: string, name = id) => ({ providerId: ID, id, name, type: 'playlist' as const });

// The permission-hint flag is module state, so every test gets a fresh module graph.
const loadHook = async () => {
    vi.resetModules();
    const { useAppleMusicLibrary } = await import('@/hooks/useAppleMusicLibrary');
    const { useOnlineProviderAccountStore } = await import('@/stores/useOnlineProviderAccountStore');
    const { OnlineProviderError } = await import('@/types/onlineMusic');
    useOnlineProviderAccountStore.setState({ accounts: {}, activeProviderId: 'netease' });
    return { useAppleMusicLibrary, store: useOnlineProviderAccountStore, OnlineProviderError };
};

// Runs every collected effect the way React would on mount and returns the combined cleanup.
const mountEffects = () => {
    const cleanups = mocks.effects.map(effect => effect());
    return () => cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
};

type WindowStub = { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
const installWindow = () => {
    const listeners = new Map<string, () => void>();
    const stub: WindowStub = {
        addEventListener: vi.fn((type: string, listener: () => void) => { listeners.set(type, listener); }),
        removeEventListener: vi.fn((type: string, listener: () => void) => { if (listeners.get(type) === listener) listeners.delete(type); }),
    };
    (globalThis as { window?: unknown }).window = stub;
    return { stub, listeners };
};

describe('useAppleMusicLibrary', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.effects.length = 0;
        mocks.getProviderSummaries.mockReturnValue([{ providerId: ID }]);
        mocks.getProviderAvailability.mockReturnValue({ configured: true });
        mocks.getLoginStatus.mockResolvedValue(LOCAL_USER);
        mocks.getProviderUserPlaylists.mockResolvedValue({ items: [], hasMore: false, nextOffset: 0 });
        mocks.loadProviderAccountSnapshot.mockResolvedValue(null);
        mocks.saveProviderAccountSnapshot.mockResolvedValue({ savedAt: 2 });
        mocks.clearProviderAccountSnapshot.mockResolvedValue(undefined);
        mocks.logout.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete (globalThis as { window?: unknown }).window;
    });

    it('marks the local library as signed in from the probe without listing playlists at startup', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        useAppleMusicLibrary();
        mountEffects();
        await vi.waitFor(() => expect(store.getState().accounts[ID]).toMatchObject({
            status: 'authenticated', user: LOCAL_USER, hydration: 'ready', freshness: 'stale',
        }));
        expect(mocks.getLoginStatus).toHaveBeenCalledWith(ID);
        expect(mocks.getProviderUserPlaylists).not.toHaveBeenCalled();
        expect(mocks.saveProviderAccountSnapshot).not.toHaveBeenCalled();
    });

    it('does not list playlists at startup unless Apple Music is the active provider', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        store.setState({ activeProviderId: ID });
        mocks.getProviderUserPlaylists.mockResolvedValue({ items: [playlist('library')], hasMore: false, nextOffset: 1 });
        useAppleMusicLibrary();
        mountEffects();
        await vi.waitFor(() => expect(store.getState().accounts[ID]?.freshness).toBe('fresh'));
        expect(mocks.getProviderUserPlaylists).toHaveBeenCalledTimes(1);
        expect(mocks.getProviderUserPlaylists).toHaveBeenCalledWith(ID, 'local', { offset: 0, limit: 50 });
        expect(store.getState().accounts[ID]).toMatchObject({
            status: 'authenticated', user: LOCAL_USER, collections: [{ id: 'library' }], lastUpdatedAt: 2, error: undefined,
        });
        expect(mocks.saveProviderAccountSnapshot).toHaveBeenCalledWith(ID, expect.objectContaining({
            user: LOCAL_USER, collections: [expect.objectContaining({ id: 'library' })],
        }));
    });

    it('lists playlists once the listener switches to Apple Music', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        mocks.getProviderUserPlaylists.mockResolvedValue({ items: [playlist('library')], hasMore: false, nextOffset: 1 });
        useAppleMusicLibrary();
        mountEffects();
        await vi.waitFor(() => expect(store.getState().accounts[ID]?.status).toBe('authenticated'));
        expect(mocks.getProviderUserPlaylists).not.toHaveBeenCalled();
        store.getState().setActiveProviderId(ID);
        await vi.waitFor(() => expect(store.getState().accounts[ID]?.freshness).toBe('fresh'));
        expect(mocks.getProviderUserPlaylists).toHaveBeenCalledWith(ID, 'local', { offset: 0, limit: 50 });
        expect(store.getState().accounts[ID]?.collections).toEqual([expect.objectContaining({ id: 'library' })]);
    });

    it('ignores switches to other providers and stops listening after cleanup', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        useAppleMusicLibrary();
        const unmount = mountEffects();
        await vi.waitFor(() => expect(store.getState().accounts[ID]?.status).toBe('authenticated'));
        mocks.getLoginStatus.mockClear();
        store.getState().setActiveProviderId('kugou');
        unmount();
        store.getState().setActiveProviderId(ID);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(mocks.getLoginStatus).not.toHaveBeenCalled();
        expect(mocks.getProviderUserPlaylists).not.toHaveBeenCalled();
    });

    it('pages through the playlists until hasMore is false', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        store.setState({ activeProviderId: ID });
        mocks.getProviderUserPlaylists
            .mockResolvedValueOnce({ items: [playlist('library'), playlist('a')], hasMore: true, nextOffset: 2 })
            .mockResolvedValueOnce({ items: [playlist('b')], hasMore: false, nextOffset: 3 });
        const { refresh } = useAppleMusicLibrary();
        await expect(refresh()).resolves.toBe(true);
        expect(mocks.getProviderUserPlaylists).toHaveBeenNthCalledWith(1, ID, 'local', { offset: 0, limit: 50 });
        expect(mocks.getProviderUserPlaylists).toHaveBeenNthCalledWith(2, ID, 'local', { offset: 2, limit: 50 });
        expect(store.getState().accounts[ID]?.collections.map(collection => collection.id)).toEqual(['library', 'a', 'b']);
    });

    it('shows the cached playlists while the fresh listing is still loading', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        store.setState({ activeProviderId: ID });
        mocks.loadProviderAccountSnapshot.mockResolvedValue({
            user: LOCAL_USER, savedAt: 1, collections: [playlist('cached')], likedSongIds: [],
        });
        let finish!: (page: unknown) => void;
        mocks.getProviderUserPlaylists.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const { refresh } = useAppleMusicLibrary();
        const pending = refresh();
        await vi.waitFor(() => expect(mocks.getProviderUserPlaylists).toHaveBeenCalled());
        expect(store.getState().accounts[ID]).toMatchObject({
            status: 'authenticated', collections: [{ id: 'cached' }], hydration: 'ready', freshness: 'refreshing', lastUpdatedAt: 1,
        });
        finish({ items: [playlist('library')], hasMore: false, nextOffset: 1 });
        await expect(pending).resolves.toBe(true);
        expect(store.getState().accounts[ID]).toMatchObject({ collections: [{ id: 'library' }], freshness: 'fresh' });
    });

    it('shows the permission hint once when access is denied', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        mocks.getLoginStatus.mockResolvedValue(null);
        mocks.getProviderAvailability.mockReturnValue({ configured: false, reason: 'not-configured' });
        const { refresh } = useAppleMusicLibrary();
        await expect(refresh()).resolves.toBe(false);
        expect(store.getState().accounts[ID]).toMatchObject({ status: 'anonymous', user: null, error: DENIED });
        await expect(refresh()).resolves.toBe(false);
        expect(store.getState().accounts[ID]).toMatchObject({ status: 'anonymous', user: null, error: DENIED });
        expect(mocks.setStatusMessage).toHaveBeenCalledTimes(1);
        expect(mocks.setStatusMessage).toHaveBeenCalledWith({ type: 'error', text: 'appleMusic.permissionDenied' });
        expect(mocks.getProviderUserPlaylists).not.toHaveBeenCalled();
    });

    it('re-tests the permission when the window regains focus while it is denied', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        const { stub, listeners } = installWindow();
        mocks.getLoginStatus.mockResolvedValue(null);
        mocks.getProviderAvailability.mockReturnValue({ configured: false, reason: 'not-configured' });
        useAppleMusicLibrary();
        const unmount = mountEffects();
        await vi.waitFor(() => expect(store.getState().accounts[ID]?.error).toBe(DENIED));
        expect(stub.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
        expect(mocks.getLoginStatus).toHaveBeenCalledTimes(1);

        // Access was granted in System Settings: the next focus re-reads the permission through the probe.
        mocks.getLoginStatus.mockResolvedValue(LOCAL_USER);
        mocks.getProviderAvailability.mockReturnValue({ configured: true });
        listeners.get('focus')!();
        await vi.waitFor(() => expect(store.getState().accounts[ID]).toMatchObject({
            status: 'authenticated', user: LOCAL_USER, error: undefined,
        }));
        expect(mocks.getLoginStatus).toHaveBeenCalledTimes(2);

        // Once signed in, focusing the window must not probe again.
        listeners.get('focus')!();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(mocks.getLoginStatus).toHaveBeenCalledTimes(2);

        unmount();
        expect(stub.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
        expect(listeners.has('focus')).toBe(false);
    });

    it('keeps the account denied when focus finds the permission still refused', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        const { listeners } = installWindow();
        mocks.getLoginStatus.mockResolvedValue(null);
        mocks.getProviderAvailability.mockReturnValue({ configured: false, reason: 'not-configured' });
        useAppleMusicLibrary();
        mountEffects();
        await vi.waitFor(() => expect(store.getState().accounts[ID]?.error).toBe(DENIED));
        listeners.get('focus')!();
        await vi.waitFor(() => expect(mocks.getLoginStatus).toHaveBeenCalledTimes(2));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(store.getState().accounts[ID]).toMatchObject({ status: 'anonymous', error: DENIED });
        expect(mocks.setStatusMessage).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the provider is not registered or the runtime is unavailable', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        mocks.getProviderSummaries.mockReturnValue([{ providerId: 'netease' }]);
        const { refresh } = useAppleMusicLibrary();
        await expect(refresh()).resolves.toBe(false);

        mocks.getProviderSummaries.mockReturnValue([{ providerId: ID }]);
        mocks.getProviderAvailability.mockReturnValue({ configured: false, reason: 'runtime-unavailable' });
        await expect(refresh()).resolves.toBe(false);

        expect(mocks.getLoginStatus).not.toHaveBeenCalled();
        expect(store.getState().accounts[ID]).toBeUndefined();
        expect(mocks.setStatusMessage).not.toHaveBeenCalled();
    });

    it('keeps the snapshot quietly when Music is not running', async () => {
        const { useAppleMusicLibrary, store, OnlineProviderError } = await loadHook();
        store.setState({ activeProviderId: ID });
        mocks.loadProviderAccountSnapshot.mockResolvedValue({
            user: LOCAL_USER, savedAt: 1, collections: [playlist('cached')], likedSongIds: [],
        });
        mocks.getProviderUserPlaylists.mockRejectedValue(new OnlineProviderError('unavailable', 'Music is not running', ID));
        const { refresh } = useAppleMusicLibrary();
        await expect(refresh()).resolves.toBe(false);
        const account = store.getState().accounts[ID];
        expect(account).toMatchObject({ status: 'authenticated', collections: [{ id: 'cached' }], freshness: 'stale' });
        expect(account.error).toBeUndefined();
        expect(mocks.setStatusMessage).not.toHaveBeenCalled();
        expect(mocks.saveProviderAccountSnapshot).not.toHaveBeenCalled();
    });

    it('treats auth-required while listing as a denied permission', async () => {
        const { useAppleMusicLibrary, store, OnlineProviderError } = await loadHook();
        store.setState({ activeProviderId: ID });
        mocks.getProviderUserPlaylists.mockRejectedValue(new OnlineProviderError('auth-required', 'Not authorized', ID));
        const { refresh } = useAppleMusicLibrary();
        await expect(refresh()).resolves.toBe(false);
        expect(store.getState().accounts[ID]).toMatchObject({ status: 'anonymous', user: null, error: DENIED });
        expect(mocks.setStatusMessage).toHaveBeenCalledTimes(1);
    });

    it('marks other listing failures as an error but keeps the account', async () => {
        const { useAppleMusicLibrary, store, OnlineProviderError } = await loadHook();
        store.setState({ activeProviderId: ID });
        mocks.getProviderUserPlaylists.mockRejectedValue(new OnlineProviderError('network', 'bridge failed', ID));
        const { refresh } = useAppleMusicLibrary();
        await expect(refresh()).resolves.toBe(false);
        expect(store.getState().accounts[ID]).toMatchObject({
            status: 'authenticated', user: LOCAL_USER, hydration: 'ready', freshness: 'error',
        });
        expect(mocks.setStatusMessage).not.toHaveBeenCalled();
    });

    it('drops the result of a refresh that logout has superseded', async () => {
        const { useAppleMusicLibrary, store } = await loadHook();
        store.setState({ activeProviderId: ID });
        let finish!: (page: unknown) => void;
        mocks.getProviderUserPlaylists.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const { refresh, logout } = useAppleMusicLibrary();
        const pending = refresh();
        await vi.waitFor(() => expect(mocks.getProviderUserPlaylists).toHaveBeenCalled());
        await logout();
        finish({ items: [playlist('library')], hasMore: false, nextOffset: 1 });
        await expect(pending).resolves.toBe(false);
        expect(store.getState().accounts[ID]).toMatchObject({ status: 'anonymous', user: null, collections: [] });
        expect(mocks.logout).toHaveBeenCalledWith(ID);
        expect(mocks.clearProviderAccountSnapshot).toHaveBeenCalledWith(ID);
        expect(mocks.saveProviderAccountSnapshot).not.toHaveBeenCalled();
    });
});
